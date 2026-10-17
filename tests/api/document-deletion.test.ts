import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const clock = new TestClock('2026-10-14T08:00:00.000Z');
const server = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 100 } }));
const createdOwnerIds: string[] = [];
const inspectionPool = new Pool({
  connectionString: process.env.BOOTSTRAP_DATABASE_URL
    ?? 'postgres://pricing_bootstrap:pricing_bootstrap@127.0.0.1:5432/pricing',
});
let baseUrl = '';

async function listen(): Promise<string> {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function signedInClient(email: string): Promise<{ client: ReturnType<typeof createApiSession>; ownerId: string }> {
  const client = createApiSession();
  const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'A🔐b$cD' }),
  });
  expect(response.status).toBe(201);
  const result = await response.json() as { user: { id: string } };
  createdOwnerIds.push(result.user.id);
  return { client, ownerId: result.user.id };
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      origin: baseUrl,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function createDocument(client: ReturnType<typeof createApiSession>, title: string, customerName = ''): Promise<{ id: string }> {
  const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
    title, customerName, issueDate: '2026-10-14',
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

async function addLine(client: ReturnType<typeof createApiSession>, documentId: string, description: string): Promise<{ id: string }> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', {
    description, quantity: 1, unitPriceCents: 1000,
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

describe('draft deletion', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([inspectionPool.end(), migrationPool.end(), closeDatabase()]);
  });

  it('requires a session, hides foreign drafts, and cascades owned draft lines', async () => {
    const ownerA = await signedInClient(`delete-owner-a-${randomUUID()}@example.com`);
    const ownerB = await signedInClient(`delete-owner-b-${randomUUID()}@example.com`);
    const draft = await createDocument(ownerA.client, 'Delete me');
    const lines = await Promise.all([
      addLine(ownerA.client, draft.id, 'First line'),
      addLine(ownerA.client, draft.id, 'Second line'),
    ]);
    const missingId = '00000000-0000-4000-8000-000000000000';

    const unauthenticated = await fetch(`${baseUrl}/documents/${draft.id}`, {
      method: 'DELETE', headers: { origin: baseUrl },
    });
    expect(unauthenticated.status).toBe(401);

    const foreign = await ownerB.client.fetch(`${baseUrl}/documents/${draft.id}`, jsonRequest('DELETE'));
    const missing = await ownerB.client.fetch(`${baseUrl}/documents/${missingId}`, jsonRequest('DELETE'));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await (await ownerA.client.fetch(`${baseUrl}/documents/${draft.id}`)).json())
      .toMatchObject({ id: draft.id, status: 'draft', lineItems: expect.arrayContaining(lines.map(line => expect.objectContaining({ id: line.id }))) });

    const lineIds = lines.map(line => line.id);
    const before = await inspectionPool.query(
      'SELECT id FROM line_items WHERE document_id = $1 OR id = ANY($2::uuid[])',
      [draft.id, lineIds],
    );
    expect(before.rowCount).toBe(2);
    const deleted = await ownerA.client.fetch(`${baseUrl}/documents/${draft.id}`, jsonRequest('DELETE'));
    expect(deleted.status).toBe(204);

    const detail = await ownerA.client.fetch(`${baseUrl}/documents/${draft.id}`);
    expect(detail.status).toBe(404);
    for (const line of lines) {
      const lineAccess = await ownerA.client.fetch(
        `${baseUrl}/documents/${draft.id}/line-items/${line.id}`,
        jsonRequest('PATCH', { description: 'Must stay gone' }),
      );
      expect(lineAccess.status).toBe(404);
    }
    const after = await inspectionPool.query(
      'SELECT id FROM line_items WHERE document_id = $1 OR id = ANY($2::uuid[])',
      [draft.id, lineIds],
    );
    expect(after.rows).toEqual([]);
  });

  it('rejects finalized deletion without changing its snapshot', async () => {
    const { client } = await signedInClient(`delete-finalized-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Keep fixed', 'Customer');
    await addLine(client, document.id, 'Fixed line');
    const finalizedResponse = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
    expect(finalizedResponse.status).toBe(200);
    const finalized = await finalizedResponse.json();

    const rejected = await client.fetch(`${baseUrl}/documents/${document.id}`, jsonRequest('DELETE'));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_state' } });
    const after = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(await after.json()).toEqual(finalized);
  });
});
