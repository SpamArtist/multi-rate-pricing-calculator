import type { DocumentRef, LineRef } from './finalization.test.types.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

async function createDocument(client: ReturnType<typeof createApiSession>, title: string, customerName = ''): Promise<DocumentRef> {
  const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
    title, customerName, issueDate: '2026-10-14',
  }));
  expect(response.status).toBe(201);
  return response.json() as Promise<DocumentRef>;
}

async function addLine(
  client: ReturnType<typeof createApiSession>,
  documentId: string,
  values: { description: string; quantity: number; unitPriceCents: number; discountCents?: number; taxRateBasisPoints?: number },
): Promise<LineRef> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', values));
  expect(response.status).toBe(201);
  return response.json() as Promise<LineRef>;
}

describe('document finalization', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('keeps snapshot database round trips bounded as line counts grow', async () => {
    const { client } = await signedInClient(`finalize-statement-count-${randomUUID()}@example.com`);
    const counts: number[] = [];
    for (const size of [1, 20]) {
      const created = await client.fetch(`${baseUrl}/documents/draft-save`, jsonRequest('POST', {
        mutationId: randomUUID(), title: 'Many snapshots', customerName: 'Customer', issueDate: '2026-10-14',
        lineItems: Array.from({ length: size }, (_, index) => ({
          description: `Line ${index}`, quantity: 2, unitPriceCents: 101, discountCents: 1, taxRateBasisPoints: 1900,
        })),
      }));
      expect(created.status).toBe(201);
      const document = await created.json() as DocumentRef;
      const statements = vi.spyOn(Client.prototype, 'query');
      try {
        const response = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
        expect(response.status).toBe(200);
        const finalized = await response.json() as { lineItems: Array<{ amounts: { totalCents: number } }>; amounts: { totalCents: number } };
        expect(finalized.lineItems).toHaveLength(size);
        expect(finalized.lineItems.every(item => item.amounts.totalCents === 239)).toBe(true);
        expect(finalized.amounts.totalCents).toBe(239 * size);
        counts.push(statements.mock.calls.length);
      } finally {
        statements.mockRestore();
      }
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it('finalizes a persisted line set beyond the per-row parameter limit', async () => {
    const { client, ownerId } = await signedInClient(`finalize-large-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Large accumulated draft', 'Customer');
    const size = 13_108; // Five bind parameters per snapshot would exceed PostgreSQL's 65,535 limit.
    await withOwner(ownerId, connection => connection.query(
      `INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents)
       SELECT $1, position, 'Accumulated line', 1, 100 FROM generate_series(1, $2::integer) AS position`,
      [document.id, size],
    ));
    const response = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
    expect(response.status).toBe(200);
    const finalized = await response.json() as { status: string; lineItems: unknown[]; amounts: { totalCents: number } };
    expect(finalized.status).toBe('finalized');
    expect(finalized.lineItems).toHaveLength(size);
    expect(finalized.amounts.totalCents).toBe(100 * size);
  });

  it('reports all completeness errors and keeps failed drafts editable', async () => {
    const { client } = await signedInClient(`finalize-completeness-${randomUUID()}@example.com`);
    const empty = await createDocument(client, 'Empty draft');

    const missing = await client.fetch(`${baseUrl}/documents/${empty.id}/finalize`, jsonRequest('POST'));
    expect(missing.status).toBe(422);
    expect((await missing.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ customerName: expect.any(String), lineItems: expect.any(String) });
    const afterMissing = await client.fetch(`${baseUrl}/documents/${empty.id}`);
    expect(await afterMissing.json()).toMatchObject({ status: 'draft', customerName: '', finalizedAt: null, lineItems: [] });

    const line = await addLine(client, empty.id, { description: '  ', quantity: 1, unitPriceCents: 1000 });
    const blankDescription = await client.fetch(`${baseUrl}/documents/${empty.id}/finalize`, jsonRequest('POST', {}));
    expect(blankDescription.status).toBe(422);
    expect((await blankDescription.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ customerName: expect.any(String), 'lineItems[0].description': expect.any(String) });
    const unchanged = await client.fetch(`${baseUrl}/documents/${empty.id}`);
    expect(await unchanged.json()).toMatchObject({
      status: 'draft', finalizedAt: null,
      lineItems: [expect.objectContaining({ id: line.id, description: '' })],
    });

    const fixedCustomer = await client.fetch(`${baseUrl}/documents/${empty.id}`, jsonRequest('PATCH', { customerName: 'Retained customer' }));
    expect(fixedCustomer.status).toBe(200);
    const fixedDescription = await client.fetch(
      `${baseUrl}/documents/${empty.id}/line-items/${line.id}`,
      jsonRequest('PATCH', { description: 'Service' }),
    );
    expect(fixedDescription.status).toBe(200);
    const finalized = await client.fetch(`${baseUrl}/documents/${empty.id}/finalize`, jsonRequest('POST'));
    expect(finalized.status).toBe(200);
    expect(await finalized.json()).toMatchObject({ status: 'finalized', customerName: 'Retained customer' });
  });

  it('writes exact line and document snapshots, reads frozen amounts, and rejects every finalized mutation', async () => {
    const { client, ownerId } = await signedInClient(`finalize-snapshot-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Snapshot workshop', 'Alpen Studio');
    const first = await addLine(client, document.id, {
      description: 'Brand workshop', quantity: 3, unitPriceCents: 1999, discountCents: 1000, taxRateBasisPoints: 1900,
    });
    const second = await addLine(client, document.id, {
      description: 'Print-ready files', quantity: 2, unitPriceCents: 250, taxRateBasisPoints: 750,
    });

    const response = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
    expect(response.status).toBe(200);
    const finalized = await response.json() as {
      id: string; status: string; finalizedAt: string | null;
      lineItems: Array<{ id: string; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
    };
    expect(finalized).toMatchObject({
      id: document.id, status: 'finalized', finalizedAt: clock.now().toISOString(),
      lineItems: [
        { id: first.id, amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 } },
        { id: second.id, amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 } },
      ],
      amounts: { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 },
    });

    await withOwner(ownerId, async connection => {
      await connection.query('UPDATE line_items SET tax_rate_basis_points = 0 WHERE id = $1', [first.id]);
    });
    const frozenRead = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(frozenRead.status).toBe(200);
    const frozen = await frozenRead.json() as {
      status: string; lineItems: Array<{ id: string; taxRateBasisPoints: number; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
    };
    expect(frozen.status).toBe('finalized');
    expect(frozen.lineItems[0]).toMatchObject({
      id: first.id, taxRateBasisPoints: 0,
      amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 },
    });
    expect(frozen.amounts).toEqual({
      subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484,
    });

    const mutationResponses = await Promise.all([
      client.fetch(`${baseUrl}/documents/${document.id}`, jsonRequest('PATCH', { title: 'Changed' })),
      client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', { quantity: 1, unitPriceCents: 100 })),
      client.fetch(`${baseUrl}/documents/${document.id}/line-items/${first.id}`, jsonRequest('PATCH', { description: 'Changed' })),
      client.fetch(`${baseUrl}/documents/${document.id}/line-items/${second.id}`, jsonRequest('DELETE')),
      client.fetch(`${baseUrl}/documents/${document.id}`, jsonRequest('DELETE')),
      client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST', {})),
    ]);
    for (const mutation of mutationResponses) {
      expect(mutation.status).toBe(409);
      expect(await mutation.json()).toMatchObject({ error: { code: 'invalid_state' } });
    }
  });

  it('rolls back partial snapshot writes when a line snapshot write fails', async () => {
    const { client, ownerId } = await signedInClient(`finalize-rollback-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Rollback workshop', 'Customer');
    const marker = `rollback-trigger-${randomUUID()}`;
    await addLine(client, document.id, { description: marker, quantity: 1, unitPriceCents: 1250, taxRateBasisPoints: 1900 });
    await migrationPool.query(`
      CREATE OR REPLACE FUNCTION public.fail_test_line_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.description = '${marker}' AND NEW.finalized_total_cents IS NOT NULL THEN
          RAISE EXCEPTION 'forced snapshot failure';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await migrationPool.query('CREATE TRIGGER fail_test_line_snapshot BEFORE UPDATE ON line_items FOR EACH ROW EXECUTE FUNCTION public.fail_test_line_snapshot()');
    try {
      const failed = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
      expect(failed.status).toBe(500);
      const state = await withOwner(ownerId, connection => connection.query(
        `SELECT d.status, d.finalized_subtotal_cents, d.finalized_total_cents,
                l.finalized_subtotal_cents AS line_subtotal, l.finalized_total_cents AS line_total
         FROM documents d JOIN line_items l ON l.document_id = d.id WHERE d.id = $1`,
        [document.id],
      ));
      expect(state.rows).toEqual([{
        status: 'draft', finalized_subtotal_cents: null, finalized_total_cents: null,
        line_subtotal: null, line_total: null,
      }]);
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS fail_test_line_snapshot ON line_items');
      await migrationPool.query('DROP FUNCTION IF EXISTS public.fail_test_line_snapshot()');
    }

    const repaired = await client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      description: 'Additional line', quantity: 1, unitPriceCents: 0,
    }));
    expect(repaired.status).toBe(201);
  });

  it('rolls back the complete line snapshot set when the document transition fails', async () => {
    const { client, ownerId } = await signedInClient(`finalize-document-rollback-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Atomic transition', 'Customer');
    for (const price of [100, 250, 500]) {
      await addLine(client, document.id, { description: `Line ${price}`, quantity: 2, unitPriceCents: price, taxRateBasisPoints: 1900 });
    }
    await migrationPool.query(`
      CREATE FUNCTION fail_test_document_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${document.id}'::uuid AND NEW.status = 'finalized' THEN
          RAISE EXCEPTION 'forced document transition failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await migrationPool.query('CREATE TRIGGER fail_test_document_transition BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fail_test_document_transition()');
    try {
      const failed = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
      expect(failed.status).toBe(500);
      const state = await withOwner(ownerId, connection => connection.query(
        `SELECT d.status, d.finalized_at, d.finalized_total_cents,
          l.finalized_subtotal_cents, l.finalized_taxable_cents, l.finalized_tax_cents, l.finalized_total_cents AS line_total
         FROM documents d JOIN line_items l ON l.document_id = d.id WHERE d.id = $1`,
        [document.id],
      ));
      expect(state.rows).toEqual(Array.from({ length: 3 }, () => ({
        status: 'draft', finalized_at: null, finalized_total_cents: null,
        finalized_subtotal_cents: null, finalized_taxable_cents: null, finalized_tax_cents: null, line_total: null,
      })));
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS fail_test_document_transition ON documents');
      await migrationPool.query('DROP FUNCTION IF EXISTS fail_test_document_transition()');
    }
    const retried = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'finalized', amounts: { totalCents: 2023 } });
  });

  it('serializes concurrent line edits against finalization', async () => {
    const { client } = await signedInClient(`finalize-race-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Race workshop', 'Customer');
    const line = await addLine(client, document.id, { description: 'Original', quantity: 1, unitPriceCents: 1000, taxRateBasisPoints: 1900 });
    const [edit, finalize] = await Promise.all([
      client.fetch(`${baseUrl}/documents/${document.id}/line-items/${line.id}`, jsonRequest('PATCH', { unitPriceCents: 2000 })),
      client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST')),
    ]);
    expect([200, 409]).toContain(edit.status);
    expect(finalize.status).toBe(200);
    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(detail.status).toBe(200);
    const saved = await detail.json() as {
      status: string; lineItems: Array<{ unitPriceCents: number; amounts: Record<string, number> }>;
    };
    expect(saved.status).toBe('finalized');
    expect(saved.lineItems[0].unitPriceCents).toBe(edit.status === 200 ? 2000 : 1000);
    expect(saved.lineItems[0].amounts.subtotalCents).toBe(edit.status === 200 ? 2000 : 1000);
  });

  it('rejects unsafe persisted numeric inputs without freezing the draft', async () => {
    const { client, ownerId } = await signedInClient(`finalize-unsafe-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Unsafe numeric input', 'Customer');
    const line = await addLine(client, document.id, { description: 'Zero price', quantity: 1, unitPriceCents: 0 });
    await withOwner(ownerId, async connection => {
      await connection.query('UPDATE line_items SET quantity = $1 WHERE id = $2', ['9007199254740992', line.id]);
    });

    const invalid = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST', {}));
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toHaveProperty('lineItems[0].quantity');
    const unchanged = await withOwner(ownerId, connection => connection.query(
      `SELECT d.status, d.finalized_total_cents, l.finalized_total_cents AS line_total
       FROM documents d JOIN line_items l ON l.document_id = d.id WHERE d.id = $1`,
      [document.id],
    ));
    expect(unchanged.rows).toEqual([{ status: 'draft', finalized_total_cents: null, line_total: null }]);

    await withOwner(ownerId, async connection => {
      await connection.query('UPDATE line_items SET quantity = 1 WHERE id = $1', [line.id]);
    });
    const repaired = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST'));
    expect(repaired.status).toBe(200);
  });

  it('returns indistinguishable 404 for foreign and missing finalize/delete requests', async () => {
    const ownerA = await signedInClient(`finalize-owner-a-${randomUUID()}@example.com`);
    const ownerB = await signedInClient(`finalize-owner-b-${randomUUID()}@example.com`);
    const owned = await createDocument(ownerA.client, 'Private draft');
    const missingId = '00000000-0000-4000-8000-000000000000';

    for (const method of ['POST', 'DELETE'] as const) {
      const route = method === 'POST' ? '/finalize' : '';
      const foreign = await ownerB.client.fetch(`${baseUrl}/documents/${owned.id}${route}`, jsonRequest(method, method === 'POST' ? {} : undefined));
      const missing = await ownerB.client.fetch(`${baseUrl}/documents/${missingId}${route}`, jsonRequest(method, method === 'POST' ? {} : undefined));
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
    }

    const removed = await ownerA.client.fetch(`${baseUrl}/documents/${owned.id}`, jsonRequest('DELETE'));
    expect(removed.status).toBe(204);
    const gone = await ownerA.client.fetch(`${baseUrl}/documents/${owned.id}`);
    expect(gone.status).toBe(404);
  });

  it('rejects client-controlled finalization fields', async () => {
    const { client } = await signedInClient(`finalize-input-${randomUUID()}@example.com`);
    const document = await createDocument(client, 'Strict finalization', 'Customer');
    const unexpected = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST', {
      status: 'finalized', finalizedAt: clock.now().toISOString(), amounts: { totalCents: 1 },
    }));
    expect(unexpected.status).toBe(422);
    expect((await unexpected.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ status: expect.any(String), finalizedAt: expect.any(String), amounts: expect.any(String) });
    const unchanged = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(await unchanged.json()).toMatchObject({ status: 'draft', finalizedAt: null, amounts: { totalCents: 0 } });
  });
});
