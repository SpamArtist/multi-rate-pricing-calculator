import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool, testPool, withOwner } from '../support/db-fixture.js';
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

type Line = { id: string; position: number; description: string; quantity: number; unitPriceCents: number; discountCents: number; taxRateBasisPoints: number };
type Detail = { id: string; lineItems: Line[]; amounts: Record<string, number> };

describe('draft line mutations', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), testPool.end(), closeDatabase()]);
  });

  it('inserts at each position, partially edits, moves both ways, deletes, and keeps ordered IDs stable', async () => {
    const { client } = await signedInClient('line-mutations-order@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Line mutation order', issueDate: '2026-10-14',
    }));
    expect(created.status).toBe(201);
    const document = await created.json() as { id: string };
    const route = `${baseUrl}/documents/${document.id}/line-items`;

    async function readDetail(): Promise<Detail> {
      const response = await client.fetch(`${baseUrl}/documents/${document.id}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<Detail>;
    }

    async function insert(description: string, position?: number): Promise<string> {
      const response = await client.fetch(route, jsonRequest('POST', {
        description,
        quantity: description === 'A' ? 2 : 1,
        unitPriceCents: description.charCodeAt(0) * 100,
        ...(description === 'A' ? { discountCents: 10, taxRateBasisPoints: 1000 } : {}),
        ...(position === undefined ? {} : { position }),
      }));
      expect(response.status).toBe(201);
      const line = await response.json() as { id: string };
      return line.id;
    }

    const a = await insert('A');
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[a, 1, 'A']]);

    const b = await insert('B', 1);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[b, 1, 'B'], [a, 2, 'A']]);

    const c = await insert('C', 3);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[b, 1, 'B'], [a, 2, 'A'], [c, 3, 'C']]);

    const d = await insert('D', 2);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[b, 1, 'B'], [d, 2, 'D'], [a, 3, 'A'], [c, 4, 'C']]);

    const movedToStart = await client.fetch(`${route}/${c}`, jsonRequest('PATCH', { position: 1 }));
    expect(movedToStart.status).toBe(200);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[c, 1, 'C'], [b, 2, 'B'], [d, 3, 'D'], [a, 4, 'A']]);

    const movedToEnd = await client.fetch(`${route}/${c}`, jsonRequest('PATCH', { position: 4 }));
    expect(movedToEnd.status).toBe(200);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[b, 1, 'B'], [d, 2, 'D'], [a, 3, 'A'], [c, 4, 'C']]);

    const partialEdit = await client.fetch(`${route}/${a}`, jsonRequest('PATCH', { quantity: 3 }));
    expect(partialEdit.status).toBe(200);
    expect(await partialEdit.json()).toMatchObject({
      id: a, description: 'A', position: 3, quantity: 3, unitPriceCents: 6500,
      discountCents: 10, taxRateBasisPoints: 1000,
      amounts: { subtotalCents: 19500, discountCents: 10, taxableCents: 19490, taxCents: 1949, totalCents: 21439 },
    });
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[b, 1, 'B'], [d, 2, 'D'], [a, 3, 'A'], [c, 4, 'C']]);

    const removed = await client.fetch(`${route}/${b}`, jsonRequest('DELETE'));
    expect(removed.status).toBe(204);
    expect((await readDetail()).lineItems.map(line => [line.id, line.position, line.description]))
      .toEqual([[d, 1, 'D'], [a, 2, 'A'], [c, 3, 'C']]);
  });

  it('rejects invalid partial edits and unsafe document totals without changing saved lines', async () => {
    const { client } = await signedInClient('line-mutations-validation@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Line mutation validation', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };
    const route = `${baseUrl}/documents/${document.id}/line-items`;
    const inserted = await client.fetch(route, jsonRequest('POST', {
      description: 'Discounted work', quantity: 1, unitPriceCents: 100, discountCents: 90,
    }));
    const savedLine = await inserted.json() as Line;

    for (const { body, field } of [
      { body: {}, field: 'body' },
      { body: { position: 0 }, field: 'position' },
      { body: { position: 2 }, field: 'position' },
      { body: { ownerId: 'client-owned' }, field: 'ownerId' },
    ]) {
      const response = await client.fetch(`${route}/${savedLine.id}`, jsonRequest('PATCH', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields)
        .toHaveProperty(field);
    }

    const invalidPartialEdit = await client.fetch(`${route}/${savedLine.id}`, jsonRequest('PATCH', { unitPriceCents: 80 }));
    expect(invalidPartialEdit.status).toBe(422);
    expect((await invalidPartialEdit.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toHaveProperty('discountCents');

    const combinedErrors = await client.fetch(`${route}/${savedLine.id}`, jsonRequest('PATCH', {
      unitPriceCents: 80, position: 2,
    }));
    expect(combinedErrors.status).toBe(422);
    expect((await combinedErrors.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ discountCents: expect.any(String), position: expect.any(String) });

    const invalidInsert = await client.fetch(route, jsonRequest('POST', {
      quantity: 1, unitPriceCents: 1, position: 3,
    }));
    expect(invalidInsert.status).toBe(422);
    expect((await invalidInsert.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toHaveProperty('position');

    const afterInvalid = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(await afterInvalid.json()).toMatchObject({
      lineItems: [expect.objectContaining({
        id: savedLine.id, position: 1, description: 'Discounted work', quantity: 1,
        unitPriceCents: 100, discountCents: 90,
      })],
      amounts: { subtotalCents: 100, discountCents: 90, taxableCents: 10, totalCents: 10 },
    });

    const unsafeCreated = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Safe aggregate boundary', issueDate: '2026-10-14',
    }));
    const unsafeDocument = await unsafeCreated.json() as { id: string };
    const unsafeRoute = `${baseUrl}/documents/${unsafeDocument.id}/line-items`;
    const maximum = await client.fetch(unsafeRoute, jsonRequest('POST', {
      description: 'Maximum safe', quantity: Number.MAX_SAFE_INTEGER, unitPriceCents: 1,
    }));
    const zero = await client.fetch(unsafeRoute, jsonRequest('POST', { description: 'Zero', quantity: 1, unitPriceCents: 0 }));
    expect(maximum.status).toBe(201);
    expect(zero.status).toBe(201);
    const zeroLine = await zero.json() as Line;

    const unsafeEdit = await client.fetch(`${unsafeRoute}/${zeroLine.id}`, jsonRequest('PATCH', { unitPriceCents: 1 }));
    expect(unsafeEdit.status).toBe(422);
    expect((await unsafeEdit.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toHaveProperty('body');
    const unchangedAggregate = await client.fetch(`${baseUrl}/documents/${unsafeDocument.id}`);
    expect(await unchangedAggregate.json()).toMatchObject({
      lineItems: [expect.objectContaining({ description: 'Maximum safe', unitPriceCents: 1 }),
        expect.objectContaining({ id: zeroLine.id, description: 'Zero', unitPriceCents: 0 })],
      amounts: { subtotalCents: Number.MAX_SAFE_INTEGER, totalCents: Number.MAX_SAFE_INTEGER },
    });
  });

  it('mutates accumulated drafts beyond the per-row parameter limit', async () => {
    const { client, ownerId } = await signedInClient('line-mutations-large@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Accumulated draft', issueDate: '2026-10-14',
    }));
    const document = await created.json() as Detail;
    const size = 9_363; // Seven parameters per retained line would exceed PostgreSQL's 65,535 limit.
    await withOwner(ownerId, connection => connection.query(
      `INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents)
       SELECT $1, position, 'Accumulated line', 1, 100 FROM generate_series(1, $2::integer) AS position`,
      [document.id, size],
    ));
    const route = `${baseUrl}/documents/${document.id}/line-items`;
    const inserted = await client.fetch(route, jsonRequest('POST', {
      description: 'New line', quantity: 2, unitPriceCents: 150, position: 1,
    }));
    expect(inserted.status).toBe(201);
    const line = await inserted.json() as Line;
    const moved = await client.fetch(`${route}/${line.id}`, jsonRequest('PATCH', {
      position: size + 1, unitPriceCents: 200,
    }));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id: line.id, position: size + 1, unitPriceCents: 200 });
    const deleted = await client.fetch(`${route}/${line.id}`, jsonRequest('DELETE'));
    expect(deleted.status).toBe(204);
    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    const saved = await detail.json() as Detail;
    expect(saved.lineItems.map(item => item.position)).toEqual(Array.from({ length: size }, (_, index) => index + 1));
    expect(saved.amounts.totalCents).toBe(size * 100);
  });

  it('accepts uppercase UUID route IDs for a saved line', async () => {
    const { client } = await signedInClient('line-mutations-uppercase@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Case normalized IDs', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };
    const inserted = await client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      quantity: 1, unitPriceCents: 100,
    }));
    const line = await inserted.json() as Line;
    const response = await client.fetch(
      `${baseUrl}/documents/${document.id.toUpperCase()}/line-items/${line.id.toUpperCase()}`,
      jsonRequest('PATCH', { description: 'Updated' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: line.id, description: 'Updated' });
  });

  it('rolls back a reordered set after a later failure and finalizes the committed order', async () => {
    const { client } = await signedInClient('line-mutations-rollback@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Rollback order', customerName: 'Customer', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };
    const route = `${baseUrl}/documents/${document.id}/line-items`;
    const saved: Line[] = [];
    for (const description of ['First', 'Middle', 'Last']) {
      const inserted = await client.fetch(route, jsonRequest('POST', { description, quantity: 1, unitPriceCents: 100 }));
      expect(inserted.status).toBe(201);
      saved.push(await inserted.json() as Line);
    }
    await migrationPool.query(`
      CREATE FUNCTION reject_legacy_reorder() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${document.id}'::uuid THEN RAISE EXCEPTION 'injected legacy reorder failure'; END IF;
        RETURN NEW;
      END $$
    `);
    await migrationPool.query('CREATE TRIGGER reject_legacy_reorder BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION reject_legacy_reorder()');
    try {
      const failed = await client.fetch(`${route}/${saved[2].id}`, jsonRequest('PATCH', { position: 1 }));
      expect(failed.status).toBe(500);
      const unchanged = await client.fetch(`${baseUrl}/documents/${document.id}`);
      expect((await unchanged.json() as Detail).lineItems.map(item => [item.id, item.position]))
        .toEqual(saved.map((item, index) => [item.id, index + 1]));
    } finally {
      await migrationPool.query('DROP TRIGGER IF EXISTS reject_legacy_reorder ON documents');
      await migrationPool.query('DROP FUNCTION IF EXISTS reject_legacy_reorder()');
    }
    const moved = await client.fetch(`${route}/${saved[2].id}`, jsonRequest('PATCH', { position: 1 }));
    expect(moved.status).toBe(200);
    const finalized = await client.fetch(`${baseUrl}/documents/${document.id}/finalize`, jsonRequest('POST', {}));
    expect(finalized.status).toBe(200);
    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    const finalizedDocument = await finalized.json() as Detail;
    const detailDocument = await detail.json() as Detail;
    expect(detailDocument).toEqual(finalizedDocument);
    expect(detailDocument.lineItems.map(item => [item.id, item.position]))
      .toEqual([[saved[2].id, 1], [saved[0].id, 2], [saved[1].id, 3]]);
  });

  it('returns same 404 for foreign and missing document or line IDs', async () => {
    const ownerA = await signedInClient('line-mutations-owner-a@example.com');
    const ownerB = await signedInClient('line-mutations-owner-b@example.com');
    const documentAResponse = await ownerA.client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Owner A draft', issueDate: '2026-10-14',
    }));
    const documentA = await documentAResponse.json() as { id: string };
    const lineResponse = await ownerA.client.fetch(`${baseUrl}/documents/${documentA.id}/line-items`, jsonRequest('POST', {
      description: 'Private line', quantity: 1, unitPriceCents: 100,
    }));
    const lineA = await lineResponse.json() as Line;
    const documentBResponse = await ownerB.client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Owner B draft', issueDate: '2026-10-14',
    }));
    const documentB = await documentBResponse.json() as { id: string };

    const foreignDocument = await ownerB.client.fetch(
      `${baseUrl}/documents/${documentA.id}/line-items/${lineA.id}`,
      jsonRequest('PATCH', { description: 'Stolen' }),
    );
    const foreignLine = await ownerB.client.fetch(
      `${baseUrl}/documents/${documentB.id}/line-items/${lineA.id}`,
      jsonRequest('PATCH', { description: 'Stolen' }),
    );
    const foreignDelete = await ownerB.client.fetch(
      `${baseUrl}/documents/${documentA.id}/line-items/${lineA.id}`,
      jsonRequest('DELETE'),
    );
    const foreignLineDelete = await ownerB.client.fetch(
      `${baseUrl}/documents/${documentB.id}/line-items/${lineA.id}`,
      jsonRequest('DELETE'),
    );
    const missingLine = await ownerB.client.fetch(
      `${baseUrl}/documents/${documentB.id}/line-items/00000000-0000-4000-8000-000000000000`,
      jsonRequest('DELETE'),
    );
    expect(foreignDocument.status).toBe(404);
    expect(foreignLine.status).toBe(404);
    expect(foreignDelete.status).toBe(404);
    expect(foreignLineDelete.status).toBe(404);
    expect(missingLine.status).toBe(404);
    const missingPayload = await missingLine.json();
    expect(await foreignDocument.json()).toEqual(missingPayload);
    expect(await foreignLine.json()).toEqual(missingPayload);
    expect(await foreignDelete.json()).toEqual(missingPayload);
    expect(await foreignLineDelete.json()).toEqual(missingPayload);

    const source = await ownerA.client.fetch(`${baseUrl}/documents/${documentA.id}`);
    expect(await source.json()).toMatchObject({ lineItems: [expect.objectContaining({ id: lineA.id, description: 'Private line' })] });
    const target = await ownerB.client.fetch(`${baseUrl}/documents/${documentB.id}`);
    expect(await target.json()).toMatchObject({ lineItems: [], amounts: { totalCents: 0 } });
  });

  it('rejects finalized line mutations without changing fixed rows', async () => {
    const { client, ownerId } = await signedInClient('line-mutations-finalized@example.com');
    const documentId = randomUUID();
    const lineId = randomUUID();
    const seedClient = await migrationPool.connect();
    try {
      await seedClient.query('BEGIN');
      await seedClient.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
      await seedClient.query(
        `INSERT INTO documents (
           id, owner_id, title, customer_name, issue_date, status, finalized_at,
           finalized_subtotal_cents, finalized_discount_cents, finalized_taxable_cents,
           finalized_tax_cents, finalized_total_cents
         ) VALUES ($1, $2, 'Fixed snapshot', 'Customer', '2026-10-14', 'finalized', now(), 100, 0, 100, 0, 100)`,
        [documentId, ownerId],
      );
      await seedClient.query(
        `INSERT INTO line_items (
           id, document_id, position, description, quantity, unit_price_cents, discount_cents,
           tax_rate_basis_points, finalized_subtotal_cents, finalized_taxable_cents,
           finalized_tax_cents, finalized_total_cents
         ) VALUES ($1, $2, 1, 'Fixed line', 1, 100, 0, 0, 100, 100, 0, 100)`,
        [lineId, documentId],
      );
      await seedClient.query('COMMIT');
    } catch (error) {
      await seedClient.query('ROLLBACK');
      throw error;
    } finally {
      seedClient.release();
    }
    const route = `${baseUrl}/documents/${documentId}/line-items/${lineId}`;

    for (const response of [
      await client.fetch(route, jsonRequest('PATCH', { description: 'Changed' })),
      await client.fetch(route, jsonRequest('DELETE')),
      await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', {
        quantity: 1, unitPriceCents: 1,
      })),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_state' } });
    }

    const unchanged = await client.fetch(`${baseUrl}/documents/${documentId}`);
    expect(await unchanged.json()).toMatchObject({
      status: 'finalized',
      lineItems: [expect.objectContaining({ id: lineId, position: 1, description: 'Fixed line', unitPriceCents: 100 })],
      amounts: { subtotalCents: 100, totalCents: 100 },
    });
  });
});
