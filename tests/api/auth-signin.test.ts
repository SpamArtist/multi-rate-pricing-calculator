import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const PASSWORD = 'A🔐b$cD';
const clock = new TestClock(new Date());
const ownerId = randomUUID();
const emailDisplay = `Signer-${ownerId}@Example.com`;
const emailCanonical = emailDisplay.toLowerCase();
let server: Server;
let baseUrl = '';

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
}

async function startServer(signinRateLimit: { maxRequests?: number; windowMs?: number } = { maxRequests: 20 }): Promise<void> {
  server = createServer(createApp(undefined, clock, { signinRateLimit }));
  baseUrl = await listen(server);
}

async function signIn(client: ReturnType<typeof createApiSession>, email = emailDisplay, password = PASSWORD): Promise<Response> {
  return client.fetch(`${baseUrl}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('sign-in sessions', () => {
  beforeAll(async () => {
    const passwordHash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
    await migrationPool.query(
      'INSERT INTO users (id, email_display, email_canonical, password_hash) VALUES ($1, $2, $3, $4)',
      [ownerId, emailDisplay, emailCanonical, passwordHash],
    );
    await startServer();
  });

  beforeEach(async () => {
    await migrationPool.query('DELETE FROM sessions WHERE user_id = $1', [ownerId]);
  });

  afterAll(async () => {
    await close(server);
    await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('normalizes email and password like sign-up, then persists login across server restart', async () => {
    const client = createApiSession();
    const response = await signIn(client, ` \t${emailDisplay.toUpperCase()}\u0085 `, ` \u0085${PASSWORD}\u0085 `);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id: ownerId, email: emailDisplay } });
    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]+;/);
    expect(cookie).toMatch(/;\s*Secure(?:;|$)/i);
    expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i);

    const session = await migrationPool.query<{ created_at: Date; last_activity_at: Date; expires_at: Date }>(
      'SELECT created_at, last_activity_at, expires_at FROM sessions WHERE user_id = $1', [ownerId],
    );
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0].created_at.getTime()).toBe(clock.now().getTime());
    expect(session.rows[0].last_activity_at.getTime()).toBe(clock.now().getTime());
    expect(session.rows[0].expires_at.getTime()).toBe(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);

    await close(server);
    await startServer();
    const restored = await client.fetch(`${baseUrl}/auth/session`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ user: { id: ownerId, email: emailDisplay } });
  });

  it('returns identical failures for unknown email and wrong password', async () => {
    const unknown = await signIn(createApiSession(), `missing-${randomUUID()}@example.com`);
    const wrongPassword = await signIn(createApiSession(), emailDisplay, 'Wrong🔐9');
    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    const publicFailure = {
      error: { code: 'invalid_credentials', message: 'Invalid email or password.' },
    };
    expect(await unknown.json()).toEqual(publicFailure);
    expect(await wrongPassword.json()).toEqual(publicFailure);
    expect(unknown.headers.getSetCookie()).toEqual([]);
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
  });

  it('keeps device sessions independent and rejects cross-origin logout', async () => {
    const firstDevice = createApiSession();
    const secondDevice = createApiSession();
    expect((await signIn(firstDevice)).status).toBe(200);
    expect((await signIn(secondDevice)).status).toBe(200);

    const rejectedLogout = await firstDevice.fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(rejectedLogout.status).toBe(403);
    expect(await rejectedLogout.json()).toEqual({
      error: { code: 'invalid_origin', message: 'Request origin is not allowed.' },
    });
    expect((await firstDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(200);

    const logout = await firstDevice.fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);
    expect((await firstDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(401);
    expect((await secondDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(200);
    const sessions = await migrationPool.query('SELECT id FROM sessions WHERE user_id = $1', [ownerId]);
    expect(sessions.rows).toHaveLength(1);
  });

  it('requires a current session for logout and keeps origin rejection first', async () => {
    const absentLogout = await createApiSession().fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    expect(absentLogout.status).toBe(401);
    expect(await absentLogout.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    });
    expect(absentLogout.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);

    const expiredDevice = createApiSession();
    expect((await signIn(expiredDevice)).status).toBe(200);
    clock.advance(7 * 24 * 60 * 60 * 1000);

    const crossOriginLogout = await expiredDevice.fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(crossOriginLogout.status).toBe(403);
    expect(await crossOriginLogout.json()).toEqual({
      error: { code: 'invalid_origin', message: 'Request origin is not allowed.' },
    });

    const expiredLogout = await expiredDevice.fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { origin: baseUrl },
    });
    expect(expiredLogout.status).toBe(401);
    expect(await expiredLogout.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    });
    expect(expiredLogout.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);
    expect(await migrationPool.query('SELECT id FROM sessions WHERE user_id = $1', [ownerId])).toMatchObject({ rows: [] });
  });

  it('expires sessions at 24 hours idle and seven days absolute despite recent activity', async () => {
    const idleDevice = createApiSession();
    expect((await signIn(idleDevice)).status).toBe(200);
    clock.advance(23 * 60 * 60 * 1000);
    expect((await idleDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(200);
    clock.advance(24 * 60 * 60 * 1000);
    const idleExpiry = await idleDevice.fetch(`${baseUrl}/auth/session`);
    expect(idleExpiry.status).toBe(401);
    expect(idleExpiry.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);

    const absoluteDevice = createApiSession();
    expect((await signIn(absoluteDevice)).status).toBe(200);
    for (let day = 0; day < 7; day++) {
      clock.advance(23 * 60 * 60 * 1000);
      expect((await absoluteDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(200);
    }
    clock.advance(6 * 60 * 60 * 1000);
    expect((await absoluteDevice.fetch(`${baseUrl}/auth/session`)).status).toBe(200);
    clock.advance(60 * 60 * 1000);
    const absoluteExpiry = await absoluteDevice.fetch(`${baseUrl}/auth/session`);
    expect(absoluteExpiry.status).toBe(401);
    expect(absoluteExpiry.headers.getSetCookie()[0]).toMatch(/;\s*Max-Age=0(?:;|$)/i);
    expect(await migrationPool.query('SELECT id FROM sessions WHERE user_id = $1', [ownerId])).toMatchObject({ rows: [] });
  });

  it('uses the same exact idle and absolute boundaries for session and tenant routes', async () => {
    const idleMs = 24 * 60 * 60 * 1000;
    const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
    const tenantUrl = `${baseUrl}/documents`;
    const sessionUrl = `${baseUrl}/auth/session`;

    for (const [validUrl, expiredUrl] of [
      [tenantUrl, sessionUrl],
      [sessionUrl, tenantUrl],
    ]) {
      const client = createApiSession();
      expect((await signIn(client)).status).toBe(200);
      clock.advance(idleMs - 1);
      expect((await client.fetch(validUrl)).status).toBe(200);
      clock.advance(idleMs);
      const expired = await client.fetch(expiredUrl);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual(unauthenticated);
    }

    for (const [validUrl, expiredUrl] of [
      [tenantUrl, sessionUrl],
      [sessionUrl, tenantUrl],
    ]) {
      const client = createApiSession();
      expect((await signIn(client)).status).toBe(200);
      for (let day = 0; day < 7; day++) {
        clock.advance(23 * 60 * 60 * 1000);
        expect((await client.fetch(validUrl)).status).toBe(200);
      }
      clock.advance(7 * 60 * 60 * 1000 - 1);
      expect((await client.fetch(validUrl)).status).toBe(200);
      clock.advance(1);
      const expired = await client.fetch(expiredUrl);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual(unauthenticated);
    }
  });

  it('keeps concurrent refreshes monotonic across auth and tenant routes', async () => {
    const signedIn = await signIn(createApiSession());
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie()[0].split(';', 1)[0];
    const originalActivity = clock.now();
    clock.advance(10 * 60 * 1000);
    const laterClock = new TestClock(new Date(originalActivity.getTime() + 60 * 60 * 1000));
    const laterServer = createServer(createApp(undefined, laterClock));
    const laterUrl = await listen(laterServer);

    try {
      const [earlier, later] = await Promise.all([
        fetch(`${baseUrl}/documents`, { headers: { cookie } }),
        fetch(`${laterUrl}/auth/session`, { headers: { cookie } }),
      ]);
      expect(earlier.status).toBe(200);
      expect(later.status).toBe(200);
      expect(await later.json()).toEqual({ user: { id: ownerId, email: emailDisplay } });

      const activity = await migrationPool.query<{ last_activity_at: Date }>(
        'SELECT last_activity_at FROM sessions WHERE user_id = $1', [ownerId],
      );
      expect(activity.rows[0].last_activity_at.getTime()).toBe(laterClock.now().getTime());
      expect((await fetch(`${baseUrl}/auth/session`, { headers: { cookie } })).status).toBe(200);
      const afterOlderRefresh = await migrationPool.query<{ last_activity_at: Date }>(
        'SELECT last_activity_at FROM sessions WHERE user_id = $1', [ownerId],
      );
      expect(afterOlderRefresh.rows[0].last_activity_at.getTime()).toBe(laterClock.now().getTime());
    } finally {
      await close(laterServer);
    }
  });

  it('applies session expiry to documents, reports, and atomic draft saves', async () => {
    for (const { path, init, validStatus } of [
      { path: '/documents', init: undefined, validStatus: 200 },
      { path: '/reports/summary?start=2026-10-01&end=2026-10-31', init: undefined, validStatus: 200 },
      {
        path: '/documents/draft-save',
        init: { method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: '{}' },
        validStatus: 422,
      },
    ]) {
      const client = createApiSession();
      expect((await signIn(client)).status).toBe(200);
      expect((await client.fetch(`${baseUrl}${path}`, init)).status).toBe(validStatus);
      clock.advance(24 * 60 * 60 * 1000);
      const expired = await client.fetch(`${baseUrl}${path}`, init);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual({
        error: { code: 'unauthenticated', message: 'Sign in to continue.' },
      });
    }
  });

  it('throttles canonical email and IP attempts, then allows requests after window', async () => {
    await close(server);
    await startServer({ maxRequests: 2, windowMs: 60_000 });
    const client = createApiSession();
    expect((await signIn(client, emailDisplay.toUpperCase(), 'Wrong🔐9')).status).toBe(401);
    expect((await signIn(client, ` ${emailCanonical} `, 'Wrong🔐9')).status).toBe(401);
    const blocked = await signIn(client, emailCanonical, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests. Try again later.' },
    });

    clock.advance(60_001);
    expect((await signIn(client, emailCanonical, PASSWORD)).status).toBe(200);
  });
});
