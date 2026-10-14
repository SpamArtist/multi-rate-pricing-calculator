import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TestClock } from '../support/test-clock.js';

describe('GET /health', () => {
  const clock = new TestClock('2026-10-01T00:30:00.000Z');
  const app = createApp(undefined, clock);
  const server = createServer(app);
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeDatabase();
  });

  it('checks the runtime database role and returns deterministic health time', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      database: 'ok',
      checkedAt: '2026-10-01T00:30:00.000Z',
    });

    clock.advance(24 * 60 * 60 * 1000);
    const nextDay = await fetch(`${baseUrl}/health`);
    expect((await nextDay.json()).checkedAt).toBe('2026-10-02T00:30:00.000Z');
  });

  it('uses stable error shape when database check fails', async () => {
    const unavailable = createApp(async () => { throw new Error('connection detail must stay private'); }, clock);
    const testServer = unavailable.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => testServer.once('listening', resolve));
    const address = testServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: 'database_unavailable', message: 'Database unavailable.' },
      });
    } finally {
      await new Promise<void>((resolve, reject) => testServer.close(error => error ? reject(error) : resolve()));
    }
  });
});
