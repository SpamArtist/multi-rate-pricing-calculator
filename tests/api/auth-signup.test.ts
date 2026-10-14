import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const clock = new TestClock(new Date());
const server = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 20 } }));
const createdOwnerIds: string[] = [];
let baseUrl = '';

async function listen(target: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(target: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
}

describe('POST /auth/sign-up', () => {
  beforeAll(async () => { baseUrl = await listen(server); });

  afterAll(async () => {
    await close(server);
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('creates trimmed display identity, Argon2id password, hashed session, secure cookie, and private session response', async () => {
    const client = createApiSession();
    const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '\u0085  Owner@Example.com \u0085', password: ' \u0085A🔐b$cD\u0085 ' }),
    });

    expect(response.status).toBe(201);
    const payload = await response.json() as { user: { id: string; email: string } };
    expect(payload.user.email).toBe('Owner@Example.com');
    expect(payload.user.id).toMatch(/^[0-9a-f-]{36}$/i);
    createdOwnerIds.push(payload.user.id);

    const user = await migrationPool.query<{
      email_display: string;
      email_canonical: string;
      password_hash: string;
    }>(
      'SELECT email_display, email_canonical, password_hash FROM users WHERE id = $1',
      [payload.user.id],
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0].email_display).toBe('Owner@Example.com');
    expect(user.rows[0].email_canonical).toBe('owner@example.com');
    expect(user.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(user.rows[0].password_hash).toContain('m=19456');
    expect(user.rows[0].password_hash).toContain('t=2');
    expect(user.rows[0].password_hash).toContain('p=1');
    expect(await argon2.verify(user.rows[0].password_hash, 'A🔐b$cD')).toBe(true);

    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]+;/);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).toMatch(/;\s*Secure(?:;|$)/i);
    expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    const token = cookie.match(/^__Host-session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();

    const storedSession = await migrationPool.query<{ id: string; token_hash: string }>(
      'SELECT id, token_hash FROM sessions WHERE user_id = $1', [payload.user.id],
    );
    expect(storedSession.rows).toHaveLength(1);
    expect(storedSession.rows[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(storedSession.rows[0].token_hash).toBe(createHash('sha256').update(token!).digest('hex'));
    expect(storedSession.rows[0].token_hash).not.toBe(token);

    const sessionResponse = await client.fetch(`${baseUrl}/auth/session`);
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ user: payload.user });
  });

  it('rejects invalid values and unknown fields without storing users', async () => {
    const cases = [
      { email: 'bad-email', password: 'A🔐b$cD', field: 'email' },
      { email: `short-${randomUUID()}@example.com`, password: 'ab😀cd', field: 'password' },
      { email: `long-${randomUUID()}@example.com`, password: 'a23456789😀1', field: 'password' },
      { email: `space-${randomUUID()}@example.com`, password: 'ab\u00a0cde', field: 'password' },
      { email: `nel-${randomUUID()}@example.com`, password: 'ab\u0085cde', field: 'password' },
      { email: `bad\u0085email-${randomUUID()}@example.com`, password: 'A🔐b$cD', field: 'email' },
      { email: `blank-${randomUUID()}@example.com`, password: ' \u2003 \u3000 ', field: 'password' },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/auth/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: entry.email, password: entry.password }),
      });
      expect(response.status).toBe(422);
      const payload = await response.json() as { error: { code: string; fields: Record<string, string> } };
      expect(payload.error.code).toBe('validation_failed');
      expect(payload.error.fields).toHaveProperty(entry.field);

      const stored = await migrationPool.query('SELECT id FROM users WHERE email_canonical = $1', [entry.email.trim().toLowerCase()]);
      expect(stored.rows).toEqual([]);
    }

    const extraEmail = `unknown-${randomUUID()}@example.com`;
    const unknownFieldResponse = await fetch(`${baseUrl}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: extraEmail, password: 'A🔐b$cD', ownerId: randomUUID() }),
    });
    expect(unknownFieldResponse.status).toBe(422);
    const unknownPayload = await unknownFieldResponse.json() as { error: { code: string; fields: Record<string, string> } };
    expect(unknownPayload.error.code).toBe('validation_failed');
    expect(unknownPayload.error.fields).toHaveProperty('ownerId');
    expect(await migrationPool.query('SELECT id FROM users WHERE email_canonical = $1', [extraEmail.toLowerCase()])).toMatchObject({ rows: [] });
  });

  it('rejects duplicate canonical email despite case and surrounding spaces', async () => {
    const response = await fetch(`${baseUrl}/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  oWNER@eXample.com\t', password: 'A🔐b$cD' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'email_registered', message: 'Email already registered.' },
    });
    const users = await migrationPool.query('SELECT id FROM users WHERE email_canonical = $1', ['owner@example.com']);
    expect(users.rows).toHaveLength(1);
  });

  it('throttles repeated sign-up attempts by client IP', async () => {
    const limitedServer = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 2, windowMs: 60_000 } }));
    const limitedUrl = await listen(limitedServer);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${limitedUrl}/auth/sign-up`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(422);
      }
      const blocked = await fetch(`${limitedUrl}/auth/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'blocked@example.com', password: 'A🔐b$cD' }),
      });
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({
        error: { code: 'rate_limited', message: 'Too many requests. Try again later.' },
      });
      expect(await migrationPool.query('SELECT id FROM users WHERE email_canonical = $1', ['blocked@example.com'])).toMatchObject({ rows: [] });
    } finally {
      await close(limitedServer);
    }
  });

  it('expires idle and absolute sessions and clears their cookies', async () => {
    const expiryClock = new TestClock(new Date());
    const expiryServer = createServer(createApp(undefined, expiryClock, { signupRateLimit: { maxRequests: 10 } }));
    const expiryUrl = await listen(expiryServer);
    const idleClient = createApiSession();
    const idleEmail = `idle-${randomUUID()}@example.com`;
    const absoluteClient = createApiSession();
    const absoluteEmail = `absolute-${randomUUID()}@example.com`;

    try {
      const idleSignup = await idleClient.fetch(`${expiryUrl}/auth/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: idleEmail, password: 'A🔐b$cD' }),
      });
      expect(idleSignup.status).toBe(201);
      const idleUser = (await idleSignup.json() as { user: { id: string } }).user;
      createdOwnerIds.push(idleUser.id);

      expiryClock.advance(24 * 60 * 60 * 1000 + 1_000);
      const idleExpiry = await idleClient.fetch(`${expiryUrl}/auth/session`);
      expect(idleExpiry.status).toBe(401);
      expect(idleExpiry.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);
      expect(await migrationPool.query('SELECT id FROM sessions WHERE user_id = $1', [idleUser.id])).toMatchObject({ rows: [] });

      expiryClock.freeze(new Date());
      const absoluteSignup = await absoluteClient.fetch(`${expiryUrl}/auth/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: absoluteEmail, password: 'A🔐b$cD' }),
      });
      expect(absoluteSignup.status).toBe(201);
      const absoluteUser = (await absoluteSignup.json() as { user: { id: string } }).user;
      createdOwnerIds.push(absoluteUser.id);

      expect((await absoluteClient.fetch(`${expiryUrl}/auth/session`)).status).toBe(200);
      const absoluteExpiry = new Date(expiryClock.now().getTime() + 10_000);
      await migrationPool.query('UPDATE sessions SET expires_at = $1 WHERE user_id = $2', [absoluteExpiry, absoluteUser.id]);
      expiryClock.advance(10_001);
      const absoluteExpired = await absoluteClient.fetch(`${expiryUrl}/auth/session`);
      expect(absoluteExpired.status).toBe(401);
      expect(absoluteExpired.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);
      expect(await migrationPool.query('SELECT id FROM sessions WHERE user_id = $1', [absoluteUser.id])).toMatchObject({ rows: [] });
    } finally {
      await close(expiryServer);
    }
  });
});
