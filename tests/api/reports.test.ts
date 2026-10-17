import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const clock = new TestClock('2026-10-03T12:00:00.000Z');
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

async function signedInClient(email: string): Promise<ReturnType<typeof createApiSession>> {
  const client = createApiSession();
  const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email, password: 'A🔐b$cD' }),
  });
  expect(response.status).toBe(201);
  const result = await response.json() as { user: { id: string } };
  createdOwnerIds.push(result.user.id);
  return client;
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

async function createDraft(
  client: ReturnType<typeof createApiSession>,
  title: string,
  issueDate: string,
): Promise<string> {
  const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
    title,
    customerName: 'Summary customer',
    issueDate,
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function addLine(
  client: ReturnType<typeof createApiSession>,
  documentId: string,
  input: { quantity: number; unitPriceCents: number; discountCents?: number; taxRateBasisPoints?: number },
): Promise<void> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', {
    description: 'Reportable work',
    ...input,
  }));
  expect(response.status).toBe(201);
}

async function finalize(client: ReturnType<typeof createApiSession>, documentId: string): Promise<void> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/finalize`, jsonRequest('POST', {}));
  expect(response.status).toBe(200);
}

async function createFinalized(
  client: ReturnType<typeof createApiSession>,
  title: string,
  issueDate: string,
  line: { quantity: number; unitPriceCents: number; discountCents?: number; taxRateBasisPoints?: number },
): Promise<string> {
  const documentId = await createDraft(client, title, issueDate);
  await addLine(client, documentId, line);
  await finalize(client, documentId);
  return documentId;
}

describe('issue-date summary report', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('requires authentication and validates strict inclusive date query', async () => {
    const unauthenticated = await createApiSession().fetch(
      `${baseUrl}/reports/summary?start=2026-09-30&end=2026-10-31`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: 'unauthenticated' } });

    const client = await signedInClient('reports-validation@example.com');
    for (const { query, fields } of [
      { query: '', fields: ['start', 'end'] },
      { query: '?start=2026-02-30&end=2026-03-31', fields: ['start'] },
      { query: '?start=2026-09-30', fields: ['end'] },
      { query: '?start=2026-10-01&end=2026-09-30', fields: ['end'] },
      { query: '?start=2026-09-30&start=2026-10-01&end=2026-10-31', fields: ['start'] },
      { query: '?start=2026-09-30&end=2026-10-31&search=Acme', fields: ['search'] },
    ]) {
      const response = await client.fetch(`${baseUrl}/reports/summary${query}`);
      expect(response.status).toBe(422);
      const result = await response.json() as { error: { code: string; fields: Record<string, string> } };
      expect(result.error.code).toBe('validation_failed');
      for (const field of fields) expect(result.error.fields[field]).toEqual(expect.any(String));
    }
  });

  it('counts owned finalized snapshots once by inclusive issue date, excluding drafts and other owners', async () => {
    const owner = await signedInClient('reports-owner@example.com');
    const otherOwner = await signedInClient('reports-other-owner@example.com');
    await createFinalized(owner, 'September issue', '2026-09-30', {
      quantity: 2, unitPriceCents: 1000, discountCents: 100, taxRateBasisPoints: 1000,
    });
    await createFinalized(owner, 'October issue', '2026-10-01', { quantity: 1, unitPriceCents: 500 });
    await createFinalized(owner, 'November issue', '2026-11-01', { quantity: 1, unitPriceCents: 1000 });
    const draftId = await createDraft(owner, 'Unfinalized draft', '2026-10-15');
    await addLine(owner, draftId, { quantity: 1, unitPriceCents: 9000 });
    await createFinalized(otherOwner, 'Private issue', '2026-09-30', { quantity: 1, unitPriceCents: 70000 });

    const fullRange = await owner.fetch(
      `${baseUrl}/reports/summary?start=2026-09-30&end=2026-11-01`,
    );
    expect(fullRange.status).toBe(200);
    expect(fullRange.headers.get('cache-control')).toBe('private, no-store');
    expect(await fullRange.json()).toEqual({
      start: '2026-09-30',
      end: '2026-11-01',
      finalizedDocumentCount: 3,
      amounts: {
        subtotalCents: 3500,
        discountCents: 100,
        taxableCents: 3400,
        taxCents: 190,
        totalCents: 3590,
      },
    });

    const septemberOnly = await owner.fetch(
      `${baseUrl}/reports/summary?start=2026-09-30&end=2026-09-30`,
    );
    expect(septemberOnly.status).toBe(200);
    expect(await septemberOnly.json()).toMatchObject({
      finalizedDocumentCount: 1,
      amounts: { subtotalCents: 2000, discountCents: 100, taxableCents: 1900, taxCents: 190, totalCents: 2090 },
    });

    const octoberOnly = await owner.fetch(
      `${baseUrl}/reports/summary?start=2026-10-01&end=2026-10-31`,
    );
    expect(octoberOnly.status).toBe(200);
    expect(await octoberOnly.json()).toMatchObject({
      finalizedDocumentCount: 1,
      amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 0, totalCents: 500 },
    });

    const otherOwnerReport = await otherOwner.fetch(
      `${baseUrl}/reports/summary?start=2026-09-30&end=2026-09-30`,
    );
    expect(otherOwnerReport.status).toBe(200);
    expect(await otherOwnerReport.json()).toMatchObject({
      finalizedDocumentCount: 1,
      amounts: { subtotalCents: 70000, totalCents: 70000 },
    });

    const noMatches = await owner.fetch(
      `${baseUrl}/reports/summary?start=2026-12-01&end=2026-12-31`,
    );
    expect(noMatches.status).toBe(200);
    expect(await noMatches.json()).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
      finalizedDocumentCount: 0,
      amounts: { subtotalCents: 0, discountCents: 0, taxableCents: 0, taxCents: 0, totalCents: 0 },
    });
  });

  it('rejects aggregate totals outside the safe JSON integer range', async () => {
    const client = await signedInClient('reports-overflow@example.com');
    for (const title of ['Maximum snapshot one', 'Maximum snapshot two']) {
      const documentId = await createDraft(client, title, '2026-10-14');
      await addLine(client, documentId, { quantity: Number.MAX_SAFE_INTEGER, unitPriceCents: 1 });
      await finalize(client, documentId);
    }

    const response = await client.fetch(
      `${baseUrl}/reports/summary?start=2026-10-01&end=2026-10-31`,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'validation_failed',
        fields: { start: expect.any(String) },
      },
    });
  });
});
