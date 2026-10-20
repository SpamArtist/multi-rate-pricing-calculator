import type { LineInput, Document, SaveBody } from './draft-save.test.types.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';

const clock = new TestClock('2026-10-14T08:00:00.000Z');
const server = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 100 } }));
const ownerIds: string[] = [];
let baseUrl = '';

const line = (description: string, id?: string): LineInput => ({
  ...(id ? { id } : {}), description, quantity: 1, unitPriceCents: 100, discountCents: 0, taxRateBasisPoints: 0,
});
const body = (lineItems: LineInput[], documentId?: string): SaveBody => ({
  mutationId: randomUUID(), ...(documentId ? { documentId } : {}),
  title: 'Draft', customerName: 'Customer', issueDate: '2026-10-14', lineItems,
});

async function signIn(email: string) {
  const client = createApiSession();
  const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'A🔐b$cD' }),
  });
  expect(response.status).toBe(201);
  ownerIds.push((await response.json() as { user: { id: string } }).user.id);
  return client;
}

function request(body: unknown): RequestInit {
  return { method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function save(client: ReturnType<typeof createApiSession>, values: SaveBody) {
  return client.fetch(`${baseUrl}/documents/draft-save`, request(values));
}

async function detail(client: ReturnType<typeof createApiSession>, id: string): Promise<Document> {
  const response = await client.fetch(`${baseUrl}/documents/${id}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Document>;
}

describe('atomic draft save', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const ownerId of ownerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it('keeps database round trips bounded as aggregate line counts grow', async () => {
    const client = await signIn('aggregate-statement-count@example.com');
    const counts: Array<Record<string, number>> = [];
    for (const size of [2, 20]) {
      const statements = vi.spyOn(Client.prototype, 'query');
      const measured = async (values: SaveBody, expectedStatus: number) => {
        statements.mockClear();
        const response = await save(client, values);
        expect(response.status).toBe(expectedStatus);
        return { document: await response.json() as Document, count: statements.mock.calls.length };
      };
      try {
        const created = await measured(body(Array.from({ length: size }, (_, index) => line(`Line ${index}`))), 201);
        const metadata = await measured({ ...body(created.document.lineItems.map(item => line(item.description, item.id)), created.document.id), title: 'Metadata only' }, 200);
        const retained = metadata.document.lineItems.filter((_, index) => index % 2 === 0).reverse();
        const mixed = await measured(body(retained.flatMap(item => [
          { ...line(`Changed ${item.description}`, item.id), unitPriceCents: 250 }, line('Inserted'),
        ]), created.document.id), 200);
        expect(mixed.document.lineItems.filter((_, index) => index % 2 === 0).map(item => item.id))
          .toEqual(retained.map(item => item.id));
        expect(mixed.document.lineItems.map(item => item.position)).toEqual(Array.from({ length: size }, (_, index) => index + 1));
        expect(mixed.document.amounts.totalCents).toBe(size / 2 * 350);
        const emptied = await measured(body([], created.document.id), 200);
        expect(emptied.document.lineItems).toEqual([]);
        counts.push({ create: created.count, metadata: metadata.count, mixed: mixed.count, empty: emptied.count });
      } finally {
        statements.mockRestore();
      }
    }
    expect(counts[1]).toEqual(counts[0]);
  });

  it('does not rewrite unchanged lines during metadata-only saves', async () => {
    const client = await signIn('aggregate-metadata-only@example.com');
    const original = await (await save(client, body([line('Untouched')]))).json() as Document;
    await migrationPool.query(`
      CREATE FUNCTION reject_metadata_line_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.document_id = '${original.id}'::uuid THEN
          RAISE EXCEPTION 'metadata save must not rewrite lines';
        END IF;
        RETURN NEW;
      END $$
    `);
    await migrationPool.query('CREATE TRIGGER reject_metadata_line_rewrite BEFORE UPDATE ON line_items FOR EACH ROW EXECUTE FUNCTION reject_metadata_line_rewrite()');
    try {
      const response = await save(client, {
        ...body(original.lineItems.map(item => line(item.description, item.id)), original.id), title: 'New title',
      });
      expect(response.status).toBe(200);
      const updated = await response.json() as Document;
      expect(updated.title).toBe('New title');
      expect(updated.lineItems).toEqual(original.lineItems);
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_metadata_line_rewrite ON line_items');
      await migrationPool.query('DROP FUNCTION IF EXISTS reject_metadata_line_rewrite()');
    }
  });

  it('saves one mixed update with stable IDs, contiguous positions, and final aggregate amounts', async () => {
    const client = await signIn('aggregate-order@example.com');
    const firstResponse = await save(client, body([line('Alpha'), line('Bravo'), line('Charlie')]));
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as Document;
    const [alpha, bravo, charlie] = first.lineItems;
    const update = body([
      { ...line('Charlie revised', charlie.id), unitPriceCents: 250 },
      line('Delta'),
      { ...line('Alpha', alpha.id), quantity: 2 },
    ], first.id);
    update.title = 'Revised draft';
    update.customerName = 'New customer';
    const updatedResponse = await save(client, update);
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json() as Document;
    expect(updated).toMatchObject({ id: first.id, title: 'Revised draft', customerName: 'New customer' });
    expect(updated.lineItems.map(item => [item.id, item.position, item.description])).toEqual([
      [charlie.id, 1, 'Charlie revised'], [expect.any(String), 2, 'Delta'], [alpha.id, 3, 'Alpha'],
    ]);
    expect(updated.lineItems.map(item => item.id)).not.toContain(bravo.id);
    expect(updated.amounts.totalCents).toBe(550);
    expect(await detail(client, first.id)).toEqual(updated);
  });

  it('keeps one ordered line set across aggregate and legacy mutations', async () => {
    const client = await signIn('aggregate-legacy-interleave@example.com');
    const created = await save(client, body([line('Alpha'), line('Bravo'), line('Charlie')]));
    expect(created.status).toBe(201);
    const original = await created.json() as Document;
    const [alpha, bravo, charlie] = original.lineItems;
    const route = `${baseUrl}/documents/${original.id}/line-items`;
    const inserted = await client.fetch(route, request({ ...line('Inserted'), position: 2 }));
    expect(inserted.status).toBe(201);
    const added = await inserted.json() as Document['lineItems'][number];
    const moved = await client.fetch(`${route}/${charlie.id}`, {
      ...request({ position: 1, quantity: 2, unitPriceCents: 250 }), method: 'PATCH',
    });
    expect(moved.status).toBe(200);
    const current = await detail(client, original.id);
    expect(current.lineItems.map(item => item.id)).toEqual([charlie.id, alpha.id, added.id, bravo.id]);
    expect(current.amounts.totalCents).toBe(800);

    const reordered = await save(client, body([
      line('Bravo edited', bravo.id), { ...line('Charlie', charlie.id), quantity: 2, unitPriceCents: 250 },
      line('Replacement'), line('Alpha', alpha.id),
    ], original.id));
    expect(reordered.status).toBe(200);
    const saved = await reordered.json() as Document;
    const deleted = await client.fetch(`${route}/${charlie.id}`, { ...request(undefined), method: 'DELETE' });
    expect(deleted.status).toBe(204);
    const final = await detail(client, original.id);
    expect(final.lineItems.map(item => [item.id, item.position, item.description])).toEqual([
      [bravo.id, 1, 'Bravo edited'], [saved.lineItems[2].id, 2, 'Replacement'], [alpha.id, 3, 'Alpha'],
    ]);
    expect(final.amounts.totalCents).toBe(300);
  });

  it('replays a committed create and update with original response; changed key conflicts', async () => {
    const client = await signIn('aggregate-replay@example.com');
    const create = body([line('First')]);
    const createdResponse = await save(client, create);
    const created = await createdResponse.json() as Document;
    expect(createdResponse.status).toBe(201);
    const replayResponse = await save(client, create);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(created);
    const modifiedCreate = await save(client, { ...create, title: 'Different' });
    expect(modifiedCreate.status).toBe(409);
    expect((await modifiedCreate.json() as { error: { code: string } }).error.code).toBe('idempotency_conflict');

    const update = body([line('Changed', created.lineItems[0].id), line('New')], created.id);
    const updated = await (await save(client, update)).json() as Document;
    const later = body([line('Later', updated.lineItems[0].id)], created.id);
    expect((await save(client, later)).status).toBe(200);
    const replayUpdate = await save(client, update);
    expect(replayUpdate.status).toBe(200);
    expect(await replayUpdate.json()).toEqual(updated);
    expect((await detail(client, created.id)).lineItems.map(item => item.description)).toEqual(['Later']);
    const list = await client.fetch(`${baseUrl}/documents`);
    expect((await list.json() as { totalItems: number }).totalItems).toBe(1);
  });

  it('serializes concurrent retries of a new document under one mutation ID', async () => {
    const client = await signIn('aggregate-concurrent-replay@example.com');
    const create = body([line('One creation')]);
    const responses = await Promise.all([save(client, create), save(client, create)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const [first, second] = await Promise.all(responses.map(response => response.json() as Promise<Document>));
    expect(first).toEqual(second);
    const list = await client.fetch(`${baseUrl}/documents`);
    expect((await list.json() as { totalItems: number }).totalItems).toBe(1);
  });

  it('keeps the prior aggregate after validation fails and allows the corrected mutation ID', async () => {
    const client = await signIn('aggregate-invalid@example.com');
    const original = await (await save(client, body([line('Original')]))).json() as Document;
    const update = body([line('Changed', original.lineItems[0].id), line('Invalid')], original.id);
    update.title = 'Changed title';
    update.lineItems[1].discountCents = 101;
    const rejected = await save(client, update);
    expect(rejected.status).toBe(422);
    expect((await rejected.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toHaveProperty('lineItems[1].discountCents');
    expect(await detail(client, original.id)).toEqual(original);
    update.lineItems[1].discountCents = 100;
    const corrected = await save(client, update);
    expect(corrected.status).toBe(200);
    expect((await corrected.json() as Document).lineItems).toHaveLength(2);
  });

  it('rejects unknown prototype-named fields at document and line level', async () => {
    const client = await signIn('aggregate-prototype-fields@example.com');
    for (const payload of [
      `{"mutationId":"${randomUUID()}","title":"Draft","customerName":"Customer","issueDate":"2026-10-14","lineItems":[],"__proto__":"unknown"}`,
      `{"mutationId":"${randomUUID()}","title":"Draft","customerName":"Customer","issueDate":"2026-10-14","lineItems":[{"description":"Line","quantity":1,"unitPriceCents":100,"discountCents":0,"taxRateBasisPoints":0,"__proto__":"unknown"}]}`,
    ]) {
      const response = await client.fetch(`${baseUrl}/documents/draft-save`, {
        method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: payload,
      });
      expect(response.status).toBe(422);
      const fields = (await response.json() as { error: { fields: Record<string, string> } }).error.fields;
      expect(Object.keys(fields).some(key => key.endsWith('__proto__'))).toBe(true);
    }
  });

  it('uses the same numeric line rules as legacy line insertion', async () => {
    const client = await signIn('aggregate-validation-parity@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, request({
      title: 'Legacy draft', issueDate: '2026-10-14',
    }));
    expect(created.status).toBe(201);
    const legacyId = (await created.json() as Document).id;
    for (const [field, invalidValue] of [
      ['quantity', 0], ['unitPriceCents', -1], ['discountCents', 101], ['taxRateBasisPoints', 10_001],
    ] as const) {
      const invalidLine = { ...line('Line'), [field]: invalidValue };
      const aggregate = await save(client, body([invalidLine]));
      const legacy = await client.fetch(`${baseUrl}/documents/${legacyId}/line-items`, request(invalidLine));
      expect(aggregate.status).toBe(422);
      expect(legacy.status).toBe(422);
      const aggregateFields = (await aggregate.json() as { error: { fields: Record<string, string> } }).error.fields;
      const legacyFields = (await legacy.json() as { error: { fields: Record<string, string> } }).error.fields;
      expect(aggregateFields[`lineItems[0].${field}`]).toBe(legacyFields[field]);
    }
  });

  it('rejects invalid, duplicate, missing, and foreign line IDs without modifying either owner', async () => {
    const a = await signIn('aggregate-ids-a@example.com');
    const b = await signIn('aggregate-ids-b@example.com');
    const first = await (await save(a, body([line('Owner A')]))).json() as Document;
    const otherA = await (await save(a, body([line('Other A')]))).json() as Document;
    const second = await (await save(b, body([line('Owner B')]))).json() as Document;
    const attempts = [
      { value: body([line('Duplicate', first.lineItems[0].id), line('Duplicate', first.lineItems[0].id)], first.id), status: 422 },
      { value: body([line('Unknown', randomUUID())], first.id), status: 404 },
      { value: body([line('Foreign', second.lineItems[0].id)], first.id), status: 404 },
      { value: body([line('Other document', otherA.lineItems[0].id)], first.id), status: 404 },
      { value: body([line('No target', first.lineItems[0].id)]), status: 404 },
      { value: body([line('Wrong UUID', 'not-an-id')], first.id), status: 422 },
    ];
    for (const attempt of attempts) {
      const response = await save(a, attempt.value);
      expect(response.status).toBe(attempt.status);
    }
    expect(await detail(a, first.id)).toEqual(first);
    expect(await detail(a, otherA.id)).toEqual(otherA);
    expect(await detail(b, second.id)).toEqual(second);
    const inaccessible = await save(b, body([line('Steal')], first.id));
    expect(inaccessible.status).toBe(404);
  });

  it('rolls back earlier line writes when a database error occurs later in the transaction', async () => {
    const client = await signIn('aggregate-rollback@example.com');
    const original = await (await save(client, body([line('Original')]))).json() as Document;
    await migrationPool.query(`
      CREATE FUNCTION reject_atomic_draft_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${original.id}'::uuid AND NEW.title = 'Trigger failure' THEN
          RAISE EXCEPTION 'injected draft save failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await migrationPool.query('CREATE TRIGGER reject_atomic_draft_update BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION reject_atomic_draft_update()');
    try {
      const update = body([line('Changed', original.lineItems[0].id), line('Inserted')], original.id);
      update.title = 'Trigger failure';
      expect((await save(client, update)).status).toBe(500);
      expect(await detail(client, original.id)).toEqual(original);
      const retried = { ...update, title: 'Recovered' };
      const response = await save(client, retried);
      expect(response.status).toBe(200);
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_atomic_draft_update ON documents');
      await migrationPool.query('DROP FUNCTION IF EXISTS reject_atomic_draft_update()');
    }
  });

  it('serializes a draft save racing finalization and keeps the finalized snapshot consistent', async () => {
    const client = await signIn('aggregate-finalization-race@example.com');
    const original = await (await save(client, body([line('Before')]))).json() as Document;
    const update = body([line('After', original.lineItems[0].id)], original.id);
    const [saveResponse, finalizeResponse] = await Promise.all([
      save(client, update),
      client.fetch(`${baseUrl}/documents/${original.id}/finalize`, request({})),
    ]);
    expect([200, 409]).toContain(saveResponse.status);
    expect(finalizeResponse.status).toBe(200);
    const finalized = await detail(client, original.id);
    expect(finalized.status).toBe('finalized');
    expect(finalized.lineItems).toHaveLength(1);
    expect(['Before', 'After']).toContain(finalized.lineItems[0].description);
    expect(finalized.lineItems[0].amounts).toEqual(finalized.amounts);
    expect((await save(client, body([line('Too late', original.lineItems[0].id)], original.id))).status).toBe(409);
  });
});
