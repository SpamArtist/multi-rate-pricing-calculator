import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';

describe('request body rejection', () => {
  const server = createServer(createApp());
  const client = createApiSession();
  let baseUrl = '';
  let ownerId = '';

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `body-${randomUUID()}@example.com`, password: 'Abc123' }),
    });
    expect(response.status).toBe(201);
    ownerId = (await response.json()).user.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (ownerId) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it.each<{ name: string; body: string; headers: Record<string, string>; status: number; code: string }>([
    { name: 'oversized body', body: JSON.stringify({ title: 'x'.repeat(70_000) }), headers: {}, status: 413, code: 'request_too_large' },
    { name: 'unsupported charset', body: '{}', headers: { 'content-type': 'application/json; charset=iso-8859-1' }, status: 415, code: 'unsupported_encoding' },
    { name: 'unsupported encoding', body: '{}', headers: { 'content-encoding': 'unsupported' }, status: 415, code: 'unsupported_encoding' },
    { name: 'malformed JSON', body: '{', headers: {}, status: 422, code: 'validation_failed' },
  ])('returns a deterministic rejection for $name', async ({ body, headers, status, code }) => {
    const response = await client.fetch(`${baseUrl}/documents/draft-save`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl, ...headers }, body,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    const documents = await client.fetch(`${baseUrl}/documents`);
    expect((await documents.json()).totalItems).toBe(0);
  });
});
