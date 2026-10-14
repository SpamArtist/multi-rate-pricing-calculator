import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { json, Router, type RequestHandler } from 'express';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { validateRegistrationFields } from '../shared/auth-validation.js';
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

function createSignupRateLimiter(clock: Clock, options: SignupRateLimitOptions = {}): RequestHandler {
  const maxRequests = Math.max(1, options.maxRequests ?? 5);
  const windowMs = Math.max(1, options.windowMs ?? 15 * 60 * 1000);
  const maxBuckets = 10_000;
  const buckets = new Map<string, { startedAt: number; count: number }>();

  return (request, response, next) => {
    const now = clock.now().getTime();
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(key);
    }

    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value!);
      buckets.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }
    if (bucket.count >= maxRequests) {
      sendRateLimited(response);
      return;
    }
    bucket.count += 1;
    next();
  };
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

export function createAuthRouter(
  clock: Clock,
  signupRateLimit: SignupRateLimitOptions = {},
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
          INSERT INTO sessions (user_id, token_hash, expires_at)
          VALUES (${created.id}, ${tokenHash}, ${new Date(now.getTime() + SESSION_ABSOLUTE_MS)})
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

  router.get('/session', async (request, response, next) => {
    const token = readSessionToken(request.headers.cookie);
    if (!token) {
      if (request.headers.cookie?.includes(`${SESSION_COOKIE}=`)) response.append('Set-Cookie', clearSessionCookie());
      unauthenticated(response);
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [session] = await db.select({
      id: sessions.id,
      userId: users.id,
      email: users.emailDisplay,
      lastActivityAt: sessions.lastActivityAt,
      expiresAt: sessions.expiresAt,
    })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    if (!session) {
      response.append('Set-Cookie', clearSessionCookie());
      unauthenticated(response);
      return;
    }

    const now = clock.now();
    const idleExpired = session.lastActivityAt.getTime() + SESSION_IDLE_MS <= now.getTime();
    const absoluteExpired = session.expiresAt.getTime() <= now.getTime();
    if (idleExpired || absoluteExpired) {
      await db.delete(sessions).where(and(eq(sessions.id, session.id), eq(sessions.tokenHash, tokenHash)));
      response.append('Set-Cookie', clearSessionCookie());
      unauthenticated(response);
      return;
    }

    try {
      const lastActivityAt = new Date(Math.max(now.getTime(), session.lastActivityAt.getTime() + 1));
      await db.update(sessions)
        .set({ lastActivityAt })
        .where(eq(sessions.id, session.id));
      response.status(200).json({ user: { id: session.userId, email: session.email } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
