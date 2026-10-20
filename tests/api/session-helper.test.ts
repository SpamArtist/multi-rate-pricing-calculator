import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiSession } from '../support/api-session.js';

describe('API test session helper', () => {
  const server = createServer((request, response) => {
    if (request.url === '/login/alice') response.setHeader('Set-Cookie', 'session=alice-token; HttpOnly; SameSite=Lax');
    if (request.url === '/login/bob') response.setHeader('Set-Cookie', 'session=bob-token; HttpOnly; SameSite=Lax');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ cookie: request.headers.cookie ?? '' }));
  });
  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  it('keeps cookie state isolated per user session', async () => {
    const alice = createApiSession();
    const bob = createApiSession();
    await alice.fetch(`${baseUrl}/login/alice`);
    await bob.fetch(`${baseUrl}/login/bob`);
    const aliceSession = await (await alice.fetch(`${baseUrl}/session`)).json() as { cookie: string };
    const bobSession = await (await bob.fetch(`${baseUrl}/session`)).json() as { cookie: string };
    expect(aliceSession.cookie).toBe('session=alice-token');
    expect(bobSession.cookie).toBe('session=bob-token');
  });
});
