import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { json, Router, type Request, type RequestHandler } from 'express';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { trimUnicodeWhitespace, validateRegistrationFields } from '../shared/auth-validation.js';
import { type Clock } from './clock.js';

const SESSION_COOKIE = '__Host-session';
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

type Fields = Record<string, string>;

export interface SignupRateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

export type SigninRateLimitOptions = SignupRateLimitOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSignupInput(body: unknown): { input?: { emailDisplay: string; emailCanonical: string; password: string }; fields: Fields } {
  const fields = Object.create(null) as Fields;
  if (!isRecord(body)) {
    fields.body = 'Send an email address and password.';
    return { fields };
  }

  for (const key of Object.keys(body)) {
    if (key !== 'email' && key !== 'password') fields[key] = 'This field is not allowed.';
  }

  const validation = validateRegistrationFields(body.email, body.password);
  Object.assign(fields, validation.fields);

  if (Object.keys(fields).length > 0) return { fields };
  return {
    fields,
    input: {
      emailDisplay: validation.emailDisplay,
      emailCanonical: validation.emailCanonical,
      password: validation.password,
    },
  };
}

function errorResponse(code: string, message: string, fields?: Fields): { error: Record<string, unknown> } {
  return { error: fields ? { code, message, fields } : { code, message } };
}

function sendRateLimited(response: Parameters<RequestHandler>[1]): void {
  response.status(429).json(errorResponse('rate_limited', 'Too many requests. Try again later.'));
}

function requestIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function createRateLimiter(
  clock: Clock,
  keyForRequest: (request: Request) => string[],
  options: SignupRateLimitOptions = {},
): RequestHandler {
  const maxRequests = Math.max(1, options.maxRequests ?? 5);
  const windowMs = Math.max(1, options.windowMs ?? 15 * 60 * 1000);
  const maxBuckets = 10_000;
  const buckets = new Map<string, { startedAt: number; count: number }>();

  return (request, response, next) => {
    const now = clock.now().getTime();
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(key);
    }

    const keys = [...new Set(keyForRequest(request))];
    if (keys.some(key => (buckets.get(key)?.count ?? 0) >= maxRequests)) {
      sendRateLimited(response);
      return;
    }
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value!);
        buckets.set(key, { startedAt: now, count: 1 });
      } else {
        bucket.count += 1;
      }
    }
    next();
  };
}

function createSignupRateLimiter(clock: Clock, options: SignupRateLimitOptions = {}): RequestHandler {
  return createRateLimiter(clock, request => [`ip:${requestIp(request)}`], options);
}

function createSigninRateLimiter(clock: Clock, options: SigninRateLimitOptions = {}): RequestHandler {
  return createRateLimiter(clock, request => {
    const email = isRecord(request.body) && typeof request.body.email === 'string'
      ? trimUnicodeWhitespace(request.body.email).toLowerCase()
      : '';
    return [`ip:${requestIp(request)}`, `email:${email}`];
  }, options);
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_ABSOLUTE_MS / 1000}; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const token = segment.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{40,64}$/.test(token) ? token : undefined;
  }
  return undefined;
}

function isEmailUniqueConflict(error: unknown): boolean {
  let current = error;
  while (current && typeof current === 'object') {
    const value = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (value.code === '23505' && value.constraint === 'users_email_canonical_unique') return true;
    current = value.cause;
  }
  return false;
}

function unauthenticated(response: Parameters<RequestHandler>[1]): void {
  response.status(401).json(errorResponse('unauthenticated', 'Sign in to continue.'));
}

const dummyPasswordHash = argon2.hash('pricing-calculator-dummy-password', ARGON2ID_OPTIONS);

function sameOrigin(request: Request): boolean {
  const source = request.get('origin') || request.get('referer');
  const host = request.get('host');
  if (!source || !host) return false;
  try {
    return new URL(source).origin === `${request.protocol}://${host}`;
  } catch {
    return false;
  }
}

export const requireSameOrigin: RequestHandler = (request, response, next) => {
  if (!sameOrigin(request)) {
    response.status(403).json(errorResponse('invalid_origin', 'Request origin is not allowed.'));
    return;
  }
  next();
};

export const requireSameOriginForCookieMutations: RequestHandler = (request, response, next) => {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  const publicAuthEndpoint = request.path === '/auth/sign-in' || request.path === '/auth/sign-up';
  const hasSessionCookie = request.headers.cookie?.split(';').some(segment => {
    const separator = segment.indexOf('=');
    return separator >= 0 && segment.slice(0, separator).trim() === SESSION_COOKIE;
  });
  if (mutating && !publicAuthEndpoint && hasSessionCookie) {
    requireSameOrigin(request, response, next);
    return;
  }
  next();
};

export function createAuthRouter(
  clock: Clock,
  signupRateLimit: SignupRateLimitOptions = {},
  signinRateLimit: SigninRateLimitOptions = {},
): Router {
  const router = Router();

  router.post('/sign-up', createSignupRateLimiter(clock, signupRateLimit), json({ limit: '16kb' }), async (request, response, next) => {
    const parsed = parseSignupInput(request.body);
    if (!parsed.input) {
      response.status(422).json(errorResponse('validation_failed', 'Check the highlighted fields.', parsed.fields));
      return;
    }

    const { emailDisplay, emailCanonical, password } = parsed.input;
    const existingUser = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.emailCanonical, emailCanonical))
      .limit(1);
    if (existingUser.length > 0) {
      response.status(409).json(errorResponse('email_registered', 'Email already registered.'));
      return;
    }

    const passwordHash = await argon2.hash(password, ARGON2ID_OPTIONS);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = clock.now();

    try {
      const user = await db.transaction(async transaction => {
        const inserted = await transaction.execute<{ id: string; email: string }>(sql`
          INSERT INTO users (email_display, email_canonical, password_hash)
          VALUES (${emailDisplay}, ${emailCanonical}, ${passwordHash})
          RETURNING id, email_display AS email
        `);
        const created = inserted.rows[0];
        await transaction.execute(sql`
          INSERT INTO sessions (user_id, token_hash, created_at, last_activity_at, expires_at)
          VALUES (${created.id}, ${tokenHash}, ${now}, ${now}, ${new Date(now.getTime() + SESSION_ABSOLUTE_MS)})
        `);
        return created;
      });

      response.append('Set-Cookie', sessionCookie(token));
      response.status(201).json({ user });
    } catch (error) {
      if (isEmailUniqueConflict(error)) {
        response.status(409).json(errorResponse('email_registered', 'Email already registered.'));
        return;
      }
      next(error);
    }
  });

  router.post('/sign-in', json({ limit: '16kb' }), createSigninRateLimiter(clock, signinRateLimit), async (request, response, next) => {
    const parsed = parseSignupInput(request.body);
    if (!parsed.input) {
      response.status(422).json(errorResponse('validation_failed', 'Check the highlighted fields.', parsed.fields));
      return;
    }

    const { emailCanonical, password } = parsed.input;
    try {
      await dummyPasswordHash;
      const [user] = await db.select({
        id: users.id,
        email: users.emailDisplay,
        passwordHash: users.passwordHash,
      })
        .from(users)
        .where(eq(users.emailCanonical, emailCanonical))
        .limit(1);

      let passwordMatches = false;
      try {
        passwordMatches = await argon2.verify(user?.passwordHash ?? await dummyPasswordHash, password);
      } catch {
        passwordMatches = false;
      }
      if (!user || !passwordMatches) {
        response.status(401).json(errorResponse('invalid_credentials', 'Invalid email or password.'));
        return;
      }

      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const now = clock.now();
      await db.execute(sql`
        INSERT INTO sessions (user_id, token_hash, created_at, last_activity_at, expires_at)
        VALUES (${user.id}, ${tokenHash}, ${now}, ${now}, ${new Date(now.getTime() + SESSION_ABSOLUTE_MS)})
      `);
      response.append('Set-Cookie', sessionCookie(token));
      response.status(200).json({ user: { id: user.id, email: user.email } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/session', async (request, response, next) => {
    const token = readSessionToken(request.headers.cookie);
    if (!token) {
      if (request.headers.cookie?.includes(`${SESSION_COOKIE}=`)) response.append('Set-Cookie', clearSessionCookie());
      unauthenticated(response);
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = clock.now();
    try {
      const refreshed = await db.execute<{ id: string; email: string }>(sql`
        UPDATE sessions AS session
        SET last_activity_at = GREATEST(session.last_activity_at, ${now})
        FROM users AS owner
        WHERE session.user_id = owner.id
          AND session.token_hash = ${tokenHash}
          AND session.last_activity_at > ${new Date(now.getTime() - SESSION_IDLE_MS)}
          AND session.expires_at > ${now}
        RETURNING owner.id, owner.email_display AS email
      `);
      const user = refreshed.rows[0];
      if (!user) {
        await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
        response.append('Set-Cookie', clearSessionCookie());
        unauthenticated(response);
        return;
      }
      response.status(200).json({ user: { id: user.id, email: user.email } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (request, response, next) => {
    try {
      const token = readSessionToken(request.headers.cookie);
      if (token) {
        const tokenHash = createHash('sha256').update(token).digest('hex');
        await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      }
      response.append('Set-Cookie', clearSessionCookie());
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
