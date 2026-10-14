import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool, withOwner } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const clock = new TestClock('2026-10-14T08:00:00.000Z');
const server = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 100 } }));
const createdOwnerIds: string[] = [];
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

describe('document drafts', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('requires title and real issue date, rejects client-controlled fields, and saves an empty draft', async () => {
    const { client } = await signedInClient('documents-create@example.com');

    const empty = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {}));
    expect(empty.status).toBe(422);
    expect((await empty.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ title: expect.any(String), issueDate: expect.any(String) });

    for (const { body, field } of [
      { body: { title: '   ', issueDate: '2026-10-14' }, field: 'title' },
      { body: { title: 'Draft', issueDate: '2026-02-30' }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: null }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: '2026-2-03' }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: '2026-10-14', ownerId: 'client-owned' }, field: 'ownerId' },
      { body: { title: 'Draft', issueDate: '2026-10-14', status: 'finalized' }, field: 'status' },
      { body: { title: 'Draft', issueDate: '2026-10-14', amounts: {} }, field: 'amounts' },
      { body: { title: 'Draft', issueDate: '2026-10-14', lineItems: [] }, field: 'lineItems' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty(field);
    }

    const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: '  Brand workshop  ',
      issueDate: '2026-10-14',
    }));
    expect(response.status).toBe(201);
    const document = await response.json() as {
      id: string;
      title: string;
      customerName: string;
      issueDate: string;
      status: string;
      lineItems: unknown[];
      amounts: Record<string, number>;
      ownerId?: string;
    };
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(document).toMatchObject({
      title: 'Brand workshop',
      customerName: '',
      issueDate: '2026-10-14',
      status: 'draft',
      lineItems: [],
      amounts: {
        subtotalCents: 0,
        discountCents: 0,
        taxableCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    });
    expect(document).not.toHaveProperty('ownerId');
    expect(document).not.toHaveProperty('passwordHash');
    expect(document).not.toHaveProperty('sessionToken');

    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(document);

    const list = await client.fetch(`${baseUrl}/documents`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [expect.objectContaining({ id: document.id, title: 'Brand workshop', issueDate: '2026-10-14' })],
      page: 1,
      pageSize: 25,
      totalItems: 1,
      totalPages: 1,
    });
  });

  it('patches only supplied metadata, trims text, and preserves omission', async () => {
    const { client } = await signedInClient('documents-patch@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Quarterly review', issueDate: '2026-10-14', customerName: 'First customer',
    }));
    const original = await created.json() as { id: string; title: string; issueDate: string; customerName: string };

    const changedCustomer = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', {
      customerName: '  Alpen Studio  ',
    }));
    expect(changedCustomer.status).toBe(200);
    expect(await changedCustomer.json()).toMatchObject({
      title: 'Quarterly review', issueDate: '2026-10-14', customerName: 'Alpen Studio',
    });

    const changedTitleAndDate = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', {
      title: '  Revised review ', issueDate: '2026-11-02',
    }));
    expect(changedTitleAndDate.status).toBe(200);
    expect(await changedTitleAndDate.json()).toMatchObject({
      title: 'Revised review', issueDate: '2026-11-02', customerName: 'Alpen Studio',
    });

    for (const { body, field } of [
      { body: {}, field: 'body' },
      { body: { title: '   ' }, field: 'title' },
      { body: { title: null }, field: 'title' },
      { body: { issueDate: null }, field: 'issueDate' },
      { body: { issueDate: '2026-02-30' }, field: 'issueDate' },
      { body: { customerName: null }, field: 'customerName' },
      { body: { ownerId: 'another-owner' }, field: 'ownerId' },
      { body: { status: 'finalized' }, field: 'status' },
      { body: { amounts: {} }, field: 'amounts' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty(field);
    }

    const unchanged = await client.fetch(`${baseUrl}/documents/${original.id}`);
    expect(await unchanged.json()).toMatchObject({
      title: 'Revised review', issueDate: '2026-11-02', customerName: 'Alpen Studio',
    });
  });

  it('returns ordered line inputs and exact derived amounts without exposing ownership', async () => {
    const { client, ownerId } = await signedInClient('documents-order@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Brand workshop', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };

    await withOwner(ownerId, client => client.query(
      `INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points)
       VALUES ($1, 2, 'Print-ready files', 2, 250, 0, 750),
              ($1, 1, 'Brand workshop', 3, 1999, 1000, 1900)`,
      [document.id],
    ));

    const response = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      lineItems: Array<{ position: number; description: string; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
      ownerId?: string;
    };
    expect(result.lineItems.map(line => [line.position, line.description])).toEqual([
      [1, 'Brand workshop'],
      [2, 'Print-ready files'],
    ]);
    expect(result.lineItems.map(line => line.amounts)).toEqual([
      { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 },
      { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 },
    ]);
    expect(result.amounts).toEqual({
      subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484,
    });
    expect(result).not.toHaveProperty('ownerId');
  });

  it('keeps documents private and makes foreign and missing IDs indistinguishable', async () => {
    const ownerA = await signedInClient('documents-owner-a@example.com');
    const ownerB = await signedInClient('documents-owner-b@example.com');
    const created = await ownerA.client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Private draft', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };

    const foreignRead = await ownerB.client.fetch(`${baseUrl}/documents/${document.id}`);
    const missingRead = await ownerB.client.fetch(`${baseUrl}/documents/00000000-0000-4000-8000-000000000000`);
    expect(foreignRead.status).toBe(404);
    expect(missingRead.status).toBe(404);
    const missingPayload = await missingRead.json();
    expect(await foreignRead.json()).toEqual(missingPayload);

    const foreignWrite = await ownerB.client.fetch(`${baseUrl}/documents/${document.id}`, jsonRequest('PATCH', { title: 'Changed' }));
    expect(foreignWrite.status).toBe(404);
    expect(await foreignWrite.json()).toEqual(missingPayload);

    const ownerList = await ownerB.client.fetch(`${baseUrl}/documents`);
    expect((await ownerList.json() as { items: unknown[] }).items).toEqual([]);

    const unauthenticatedRead = await fetch(`${baseUrl}/documents/${document.id}`);
    const unauthenticatedCreate = await fetch(`${baseUrl}/documents`, {
      method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No session', issueDate: '2026-10-14' }),
    });
    const unauthenticatedPatch = await fetch(`${baseUrl}/documents/${document.id}`, {
      method: 'PATCH', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No session' }),
    });
    expect(unauthenticatedRead.status).toBe(401);
    expect(unauthenticatedCreate.status).toBe(401);
    expect(unauthenticatedPatch.status).toBe(401);
  });
});
