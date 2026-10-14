import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool, withOwner } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

type LineItem = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  taxRateBasisPoints: number;
  amounts: Record<string, number>;
};

type Document = {
  id: string;
  title: string;
  customerName: string;
  issueDate: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  lineItems: LineItem[];
  amounts: Record<string, number>;
};

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

async function signedInClient(email: string): Promise<ReturnType<typeof createApiSession>> {
  const client = createApiSession();
  const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function createDocument(client: ReturnType<typeof createApiSession>, title: string): Promise<Document> {
  const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
    title,
    customerName: '  Copy customer  ',
    issueDate: '2026-10-14',
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<Document>;
}

async function addLine(
  client: ReturnType<typeof createApiSession>,
  documentId: string,
  input: { description: string; quantity: number; unitPriceCents: number; discountCents?: number; taxRateBasisPoints?: number },
): Promise<LineItem> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', input));
  expect(response.status).toBe(201);
  return response.json() as Promise<LineItem>;
}

function lineInputs(document: Document): unknown[] {
  return document.lineItems.map(({ position, description, quantity, unitPriceCents, discountCents, taxRateBasisPoints, amounts }) => ({
    position, description, quantity, unitPriceCents, discountCents, taxRateBasisPoints, amounts,
  }));
}

function lineValues(document: Document): unknown[] {
  return document.lineItems.map(({ position, description, quantity, unitPriceCents, discountCents, taxRateBasisPoints }) => ({
    position, description, quantity, unitPriceCents, discountCents, taxRateBasisPoints,
  }));
}

async function expectNoSnapshots(ownerId: string, documentId: string): Promise<void> {
  await withOwner(ownerId, async connection => {
    const document = await connection.query(
      `SELECT finalized_subtotal_cents, finalized_discount_cents, finalized_taxable_cents,
              finalized_tax_cents, finalized_total_cents
       FROM documents WHERE id = $1`,
      [documentId],
    );
    expect(document.rows).toEqual([{
      finalized_subtotal_cents: null,
      finalized_discount_cents: null,
      finalized_taxable_cents: null,
      finalized_tax_cents: null,
      finalized_total_cents: null,
    }]);
    const lines = await connection.query(
      `SELECT finalized_subtotal_cents, finalized_taxable_cents, finalized_tax_cents, finalized_total_cents
       FROM line_items WHERE document_id = $1 ORDER BY position`,
      [documentId],
    );
    expect(lines.rows.length).toBeGreaterThan(0);
    for (const line of lines.rows) {
      expect(line).toEqual({
        finalized_subtotal_cents: null,
        finalized_taxable_cents: null,
        finalized_tax_cents: null,
        finalized_total_cents: null,
      });
    }
  });
}

describe('document duplication', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('duplicates drafts and finalized documents as fresh drafts with copied inputs and no snapshots', async () => {
    const client = await signedInClient('document-duplication@example.com');
    const created = await createDocument(client, '  Source workshop  ');
    const firstLine = await addLine(client, created.id, {
      description: '  Brand workshop  ', quantity: 3, unitPriceCents: 1999, discountCents: 1000, taxRateBasisPoints: 1900,
    });
    await addLine(client, created.id, {
      description: 'Print-ready files', quantity: 2, unitPriceCents: 250, taxRateBasisPoints: 750,
    });
    const movedLine = await client.fetch(
      `${baseUrl}/documents/${created.id}/line-items/${firstLine.id}`,
      jsonRequest('PATCH', { position: 2 }),
    );
    expect(movedLine.status).toBe(200);

    const sourceBeforeDraftCopy = await client.fetch(`${baseUrl}/documents/${created.id}`);
    const sourceDraft = await sourceBeforeDraftCopy.json() as Document;
    const draftCopyResponse = await client.fetch(
      `${baseUrl}/documents/${created.id}/duplicate`,
      jsonRequest('POST', { issueDate: '2026-11-02' }),
    );
    expect(draftCopyResponse.status).toBe(201);
    const draftCopy = await draftCopyResponse.json() as Document;
    expect(draftCopy).toMatchObject({
      title: sourceDraft.title,
      customerName: sourceDraft.customerName,
      issueDate: '2026-11-02',
      status: 'draft',
      finalizedAt: null,
    });
    expect(draftCopy.id).not.toBe(sourceDraft.id);
    expect(draftCopy.createdAt).not.toBe(sourceDraft.createdAt);
    expect(draftCopy.updatedAt).not.toBe(sourceDraft.updatedAt);
    expect(draftCopy.lineItems.map(line => line.id)).not.toEqual(sourceDraft.lineItems.map(line => line.id));
    expect(draftCopy.lineItems.every(line => !sourceDraft.lineItems.some(sourceLine => sourceLine.id === line.id))).toBe(true);
    expect(draftCopy.lineItems.map(line => line.position)).toEqual([1, 2]);
    expect(lineInputs(draftCopy)).toEqual(lineInputs(sourceDraft));
    expect(draftCopy.amounts).toEqual(sourceDraft.amounts);
    expect(await (await client.fetch(`${baseUrl}/documents/${created.id}`)).json()).toEqual(sourceDraft);
    await expectNoSnapshots((await client.fetch(`${baseUrl}/auth/session`).then(response => response.json()) as { user: { id: string } }).user.id, draftCopy.id);

    const editableCopy = await client.fetch(`${baseUrl}/documents/${draftCopy.id}`, jsonRequest('PATCH', { title: 'Editable copy' }));
    expect(editableCopy.status).toBe(200);
    expect(await editableCopy.json()).toMatchObject({ status: 'draft', title: 'Editable copy' });

    const finalizeResponse = await client.fetch(`${baseUrl}/documents/${created.id}/finalize`, jsonRequest('POST', {}));
    expect(finalizeResponse.status).toBe(200);
    const session = await client.fetch(`${baseUrl}/auth/session`).then(response => response.json()) as { user: { id: string } };
    await withOwner(session.user.id, connection => connection.query(
      `UPDATE line_items SET tax_rate_basis_points = 0 WHERE document_id = $1 AND position = 1`,
      [created.id],
    ));
    const finalizedBeforeCopyResponse = await client.fetch(`${baseUrl}/documents/${created.id}`);
    const finalizedBeforeCopy = await finalizedBeforeCopyResponse.json() as Document;
    expect(finalizedBeforeCopy).toMatchObject({
      status: 'finalized',
      amounts: { totalCents: 6484 },
    });
    expect(finalizedBeforeCopy.lineItems[0]).toMatchObject({ taxRateBasisPoints: 0, amounts: { taxCents: 38 } });
    const finalizedCopyResponse = await client.fetch(
      `${baseUrl}/documents/${created.id}/duplicate`,
      jsonRequest('POST', { issueDate: '2026-12-25' }),
    );
    expect(finalizedCopyResponse.status).toBe(201);
    const finalizedCopy = await finalizedCopyResponse.json() as Document;
    expect(finalizedCopy).toMatchObject({
      title: finalizedBeforeCopy.title,
      customerName: finalizedBeforeCopy.customerName,
      issueDate: '2026-12-25',
      status: 'draft',
      finalizedAt: null,
    });
    expect(finalizedCopy.id).not.toBe(finalizedBeforeCopy.id);
    expect(finalizedCopy.createdAt).not.toBe(finalizedBeforeCopy.createdAt);
    expect(finalizedCopy.updatedAt).not.toBe(finalizedBeforeCopy.updatedAt);
    expect(finalizedCopy.lineItems.every(line => !finalizedBeforeCopy.lineItems.some(sourceLine => sourceLine.id === line.id))).toBe(true);
    expect(finalizedCopy.lineItems.map(line => line.position)).toEqual([1, 2]);
    expect(lineValues(finalizedCopy)).toEqual(lineValues(finalizedBeforeCopy));
    expect(finalizedCopy.amounts.totalCents).toBe(6446);
    expect(finalizedCopy.amounts.totalCents).not.toBe(finalizedBeforeCopy.amounts.totalCents);
    expect(await (await client.fetch(`${baseUrl}/documents/${created.id}`)).json()).toEqual(finalizedBeforeCopy);
    await expectNoSnapshots(session.user.id, finalizedCopy.id);
  });

  it('rejects missing or invalid dates, unknown fields, and foreign or missing IDs without copying', async () => {
    const owner = await signedInClient('document-duplication-owner@example.com');
    const otherOwner = await signedInClient('document-duplication-other@example.com');
    const source = await createDocument(owner, 'Protected source');

    for (const body of [
      {},
      { issueDate: null },
      { issueDate: '2026-02-30' },
      { issueDate: '2026-2-03' },
      { issueDate: '2026-10-14', status: 'finalized' },
    ]) {
      const response = await owner.fetch(`${baseUrl}/documents/${source.id}/duplicate`, jsonRequest('POST', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields)
        .toHaveProperty(body.issueDate === '2026-10-14' ? 'status' : 'issueDate');
    }

    const noBody = await owner.fetch(`${baseUrl}/documents/${source.id}/duplicate`, jsonRequest('POST'));
    expect(noBody.status).toBe(422);
    expect((await noBody.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty('issueDate');

    const foreign = await otherOwner.fetch(
      `${baseUrl}/documents/${source.id}/duplicate`,
      jsonRequest('POST', { issueDate: '2026-11-02' }),
    );
    const missing = await otherOwner.fetch(
      `${baseUrl}/documents/00000000-0000-4000-8000-000000000000/duplicate`,
      jsonRequest('POST', { issueDate: '2026-11-02' }),
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());

    const list = await owner.fetch(`${baseUrl}/documents`);
    expect(await list.json()).toMatchObject({ totalItems: 1 });
  });
});
