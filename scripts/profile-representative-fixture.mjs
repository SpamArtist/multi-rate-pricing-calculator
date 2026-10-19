import assert from 'node:assert/strict';
import { statfs } from 'node:fs/promises';
import process from 'node:process';

const parentCount = 100000;
const batchSize = 50;
const minimumFreeBytes = 5 * 1024 ** 3;
const titlePrefix = 'Representative synthetic parent ';
const sources = [
  { state: 'draft', count: 337 },
  { state: 'finalized', count: 411 },
  { state: 'draft', count: 411 },
  { state: 'finalized', count: 337 },
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkFreeSpace() {
  const filesystem = await statfs(process.cwd());
  const freeBytes = filesystem.bavail * filesystem.bsize;
  assert.ok(freeBytes >= minimumFreeBytes,
    `Representative fixture stopped: ${(freeBytes / 1024 ** 3).toFixed(2)} GiB free; require at least 5 GiB`);
  return freeBytes;
}

// The caller must durably record these synthetic owners before calling either
// export. Use an idle privileged client on the disposable database. All writes
// belong to those owners; no policies, indexes, constraints or schema are changed.
export async function createRepresentativeParents({ admin, owners }) {
  assert.equal(owners.length, 3);
  assert.equal(new Set(owners).size, 3);
  assert.ok(owners.every(owner => typeof owner === 'string' && uuid.test(owner)));
  await checkFreeSpace();
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL statement_timeout = '180s'");
    const inserted = await admin.query(`WITH fixture AS (
      SELECT serial, CASE WHEN serial < 4 THEN 1 ELSE (serial % 3) + 1 END AS owner_index,
        CASE WHEN serial < 4 THEN serial IN (1, 3)
          ELSE floor((serial + 1) * 45 / 100.0) > floor(serial * 45 / 100.0) END AS finalized
      FROM generate_series(0, $3::int - 1) AS serial
    )
      INSERT INTO documents (owner_id, title, customer_name, issue_date, status, finalized_at,
        finalized_subtotal_cents, finalized_discount_cents, finalized_taxable_cents,
        finalized_tax_cents, finalized_total_cents)
      SELECT ($1::uuid[])[owner_index],
        $2::text || serial, 'Synthetic representative customer', '2026-10-18'::date,
        CASE WHEN finalized THEN 'finalized' ELSE 'draft' END,
        CASE WHEN finalized THEN now() END,
        CASE WHEN finalized THEN 0 END, CASE WHEN finalized THEN 0 END,
        CASE WHEN finalized THEN 0 END, CASE WHEN finalized THEN 0 END, CASE WHEN finalized THEN 0 END
      FROM fixture ORDER BY owner_index, serial
      RETURNING id, title, owner_id`, [owners, titlePrefix, parentCount]);
    assert.equal(inserted.rowCount, parentCount);
    const parents = inserted.rows.map(row => {
      assert.ok(row.title.startsWith(titlePrefix));
      const serial = Number(row.title.slice(titlePrefix.length));
      assert.ok(Number.isInteger(serial) && serial >= 0 && serial < parentCount);
      const intended = sources[serial] ?? {
        state: Math.floor((serial + 1) * 45 / 100) > Math.floor(serial * 45 / 100) ? 'finalized' : 'draft',
        count: 300 + (serial * 37) % 151,
      };
      return { id: row.id, serial, state: intended.state, count: intended.count, owner: row.owner_id };
    }).sort((left, right) => left.serial - right.serial);
    assert.ok(parents.every((parent, index) => parent.serial === index));
    await admin.query('COMMIT');
    return parents;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

// Range is [from, to), with serials equal to positions in the complete parent
// array. Populate [0, 4) first for the source-only stage, then append disjoint
// ranges such as [4, 1000) and [1000, 10000). Existing lines are rejected.
// Empty parents already have the intended state, with zero finalized snapshots
// where applicable; population fills their matching inputs and monetary totals.
export async function populateRepresentativeParents({ admin, parents, from, to, onProgress, beforeBatch }) {
  assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= parents.length);
  let completedParents = 0;
  let insertedLines = 0;
  for (let offset = from; offset < to; offset += batchSize) {
    await beforeBatch?.();
    const freeBytes = await checkFreeSpace();
    const batch = parents.slice(offset, Math.min(offset + batchSize, to));
    for (const [index, parent] of batch.entries()) {
      assert.equal(parent.serial, offset + index);
      assert.match(parent.id, uuid);
      assert.ok(Number.isInteger(parent.count) && parent.count >= 300 && parent.count <= 450);
      assert.ok(['draft', 'finalized'].includes(parent.state));
    }
    const ids = batch.map(parent => parent.id);
    await admin.query('BEGIN');
    try {
      await admin.query("SET LOCAL statement_timeout = '180s'");
      const locked = await admin.query('SELECT id FROM documents WHERE id = ANY($1::uuid[]) FOR UPDATE', [ids]);
      assert.equal(locked.rowCount, batch.length, 'Representative parent disappeared');
      const existing = await admin.query('SELECT id FROM line_items WHERE document_id = ANY($1::uuid[]) LIMIT 1', [ids]);
      assert.equal(existing.rowCount, 0, 'Representative population range was already populated');
      const inserted = await admin.query(`WITH inputs AS MATERIALIZED (
        SELECT item.id AS document_id, item.state, position,
          'Service ' || ((item.serial * 449 + position) % 1000000 + 1) || ' / line ' || position AS description,
          (1 + (item.serial + position) % 50)::bigint AS quantity,
          (100 + (item.serial * 97 + position * 113) % 100000)::bigint AS unit_price_cents,
          ((item.serial * 13 + position * 17) % 10001)::bigint AS discount_basis_points,
          ((item.serial * 23 + position * 29) % 10001)::int AS tax_rate_basis_points
        FROM jsonb_to_recordset($1::jsonb) AS item(id uuid, serial int, state text, count int)
        CROSS JOIN LATERAL generate_series(1, item.count) AS position
      ), discounted AS MATERIALIZED (
        SELECT *, quantity * unit_price_cents AS subtotal_cents,
          quantity * unit_price_cents * discount_basis_points / 10000 AS discount_cents
        FROM inputs
      ), priced AS MATERIALIZED (
        SELECT *, subtotal_cents - discount_cents AS taxable_cents,
          ((subtotal_cents - discount_cents) * tax_rate_basis_points + 5000) / 10000 AS tax_cents
        FROM discounted
      )
      INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents,
        discount_cents, tax_rate_basis_points, finalized_subtotal_cents, finalized_taxable_cents,
        finalized_tax_cents, finalized_total_cents)
      SELECT document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points,
        CASE WHEN state = 'finalized' THEN subtotal_cents END,
        CASE WHEN state = 'finalized' THEN taxable_cents END,
        CASE WHEN state = 'finalized' THEN tax_cents END,
        CASE WHEN state = 'finalized' THEN taxable_cents + tax_cents END
      FROM priced`, [JSON.stringify(batch)]);
      const expectedLines = batch.reduce((sum, parent) => sum + parent.count, 0);
      assert.equal(inserted.rowCount, expectedLines);
      const finalizedIds = batch.filter(parent => parent.state === 'finalized').map(parent => parent.id);
      const updated = await admin.query(`WITH totals AS (
        SELECT document_id, sum(quantity * unit_price_cents)::bigint AS subtotal_cents,
          sum(discount_cents)::bigint AS discount_cents,
          sum(quantity * unit_price_cents - discount_cents)::bigint AS taxable_cents,
          sum(((quantity * unit_price_cents - discount_cents) * tax_rate_basis_points + 5000) / 10000)::bigint AS tax_cents
        FROM line_items WHERE document_id = ANY($1::uuid[]) GROUP BY document_id
      )
      UPDATE documents AS target SET
        draft_subtotal_cents = totals.subtotal_cents,
        draft_discount_cents = totals.discount_cents,
        draft_taxable_cents = totals.taxable_cents,
        draft_tax_cents = totals.tax_cents,
        draft_total_cents = totals.taxable_cents + totals.tax_cents,
        status = CASE WHEN target.id = ANY($2::uuid[]) THEN 'finalized' ELSE 'draft' END,
        finalized_at = CASE WHEN target.id = ANY($2::uuid[]) THEN now() END,
        finalized_subtotal_cents = CASE WHEN target.id = ANY($2::uuid[]) THEN totals.subtotal_cents END,
        finalized_discount_cents = CASE WHEN target.id = ANY($2::uuid[]) THEN totals.discount_cents END,
        finalized_taxable_cents = CASE WHEN target.id = ANY($2::uuid[]) THEN totals.taxable_cents END,
        finalized_tax_cents = CASE WHEN target.id = ANY($2::uuid[]) THEN totals.tax_cents END,
        finalized_total_cents = CASE WHEN target.id = ANY($2::uuid[]) THEN totals.taxable_cents + totals.tax_cents END
      FROM totals WHERE target.id = totals.document_id`, [ids, finalizedIds]);
      assert.equal(updated.rowCount, batch.length);
      await admin.query('COMMIT');
      completedParents += batch.length;
      insertedLines += expectedLines;
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    await onProgress?.({ phase: 'populate', from, to, completedParents, insertedLines, freeBytes });
  }
  return { completedParents, insertedLines };
}
