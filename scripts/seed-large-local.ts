import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import pg from 'pg';

const { Client } = pg;
const DOCUMENT_COUNT = 100_000;
const MIN_LINES = 300;
const MAX_LINES = 450;
const BATCH_SIZE = 50;
const RUN_ID = 'large-local-v1';
const FIRST_DAY = Date.parse('1980-01-01T00:00:00.000Z');
const LAST_DAY = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const DAY_MS = 86_400_000;
const PASSWORD_PATH = join('.artifacts', `${RUN_ID}-password.txt`);

type SeedDocument = {
  index: number;
  title: string;
  customerName: string;
  issueDate: string;
  lineCount: number;
  finalized: boolean;
};

type InsertedDocument = { id: string; title: string };

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function issueDate(index: number): string {
  if (index === 0) return '1980-01-01';
  if (index === DOCUMENT_COUNT - 1) return new Date(LAST_DAY).toISOString().slice(0, 10);
  const days = Math.floor((LAST_DAY - FIRST_DAY) / DAY_MS);
  return new Date(FIRST_DAY + randomInt(0, days) * DAY_MS).toISOString().slice(0, 10);
}

function documentAt(index: number): SeedDocument {
  const serial = String(index + 1).padStart(6, '0');
  return {
    index,
    title: `Load ${RUN_ID} Document ${serial}`,
    customerName: `Load ${RUN_ID} Customer ${serial}`,
    issueDate: issueDate(index),
    lineCount: index === 0 ? MIN_LINES : index === DOCUMENT_COUNT - 1 ? MAX_LINES : randomInt(MIN_LINES, MAX_LINES),
    finalized: Math.floor((index + 1) * 45 / 100) > Math.floor(index * 45 / 100),
  };
}

function password(): string {
  mkdirSync('.artifacts', { recursive: true });
  try {
    const existing = readFileSync(PASSWORD_PATH, 'utf8').trim();
    if (existing.length >= 6 && existing.length <= 10) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const value = randomBytes(8).toString('base64url').slice(0, 10);
  writeFileSync(PASSWORD_PATH, `${value}\n`, { mode: 0o600 });
  return value;
}

async function withOwner<T>(client: pg.Client, ownerId: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function createOwners(client: pg.Client, hash: string): Promise<string[]> {
  const ids: string[] = [];
  for (let owner = 1; owner <= 3; owner += 1) {
    const email = `load-${RUN_ID}-${owner}@example.test`;
    const result = await client.query<{ id: string }>(`
      INSERT INTO users (email_display, email_canonical, password_hash)
      VALUES ($1, $1, $2)
      ON CONFLICT (email_canonical) DO UPDATE SET
        email_display = EXCLUDED.email_display,
        password_hash = EXCLUDED.password_hash
      RETURNING id
    `, [email, hash]);
    ids.push(result.rows[0].id);
  }
  return ids;
}

async function completedForOwner(client: pg.Client, ownerId: string, owner: number): Promise<number> {
  return withOwner(client, ownerId, async () => {
    const result = await client.query<{ count: string; last_title: string | null }>(`
      SELECT count(*)::text AS count, max(title) AS last_title
      FROM documents WHERE owner_id = $1 AND title LIKE $2
    `, [ownerId, `Load ${RUN_ID} Document %`]);
    const count = Number(result.rows[0].count);
    if (count > 0) {
      const lastIndex = owner + (count - 1) * 3;
      if (result.rows[0].last_title !== documentAt(lastIndex).title) {
        throw new Error(`Noncontiguous seed documents for owner ${owner + 1}; refusing unsafe resume.`);
      }
    }
    return count;
  });
}

async function insertBatch(client: pg.Client, ownerId: string, batch: SeedDocument[]): Promise<void> {
  await withOwner(client, ownerId, async () => {
    const inserted = await client.query<InsertedDocument>(`
      INSERT INTO documents (owner_id, title, customer_name, issue_date)
      SELECT $1::uuid, source.title, source.customer_name, source.issue_date
      FROM jsonb_to_recordset($2::jsonb)
        AS source(title text, customer_name text, issue_date date)
      RETURNING id, title
    `, [ownerId, JSON.stringify(batch.map(doc => ({
      title: doc.title, customer_name: doc.customerName, issue_date: doc.issueDate,
    })))]);
    const ids = new Map(inserted.rows.map(row => [row.title, row.id]));
    if (ids.size !== batch.length) throw new Error('Unexpected document insert count.');
    const lines = batch.map(doc => ({
      document_id: ids.get(doc.title), line_count: doc.lineCount, finalized: doc.finalized,
    }));
    await client.query(`
      WITH source AS MATERIALIZED (
        SELECT input.document_id, input.finalized, position,
          ('Service ' || (1 + floor(random() * 1000000))::int || ' / line ' || position) AS description,
          (1 + floor(random() * 50))::bigint AS quantity,
          (100 + floor(random() * 100000))::bigint AS unit_price_cents,
          floor(random() * 10001)::int AS discount_basis_points,
          floor(random() * 10001)::int AS tax_rate_basis_points
        FROM jsonb_to_recordset($1::jsonb)
          AS input(document_id uuid, line_count int, finalized boolean)
        CROSS JOIN LATERAL generate_series(1, input.line_count) AS position
      ), priced AS MATERIALIZED (
        SELECT *, quantity * unit_price_cents AS subtotal_cents,
          (quantity * unit_price_cents * discount_basis_points / 10000) AS discount_cents
        FROM source
      ), totaled AS MATERIALIZED (
        SELECT *, subtotal_cents - discount_cents AS taxable_cents,
          ((subtotal_cents - discount_cents) * tax_rate_basis_points + 5000) / 10000 AS tax_cents
        FROM priced
      )
      INSERT INTO line_items (
        document_id, position, description, quantity, unit_price_cents, discount_cents,
        tax_rate_basis_points, finalized_subtotal_cents, finalized_taxable_cents,
        finalized_tax_cents, finalized_total_cents
      )
      SELECT document_id, position, description, quantity, unit_price_cents, discount_cents,
        tax_rate_basis_points,
        CASE WHEN finalized THEN subtotal_cents END,
        CASE WHEN finalized THEN taxable_cents END,
        CASE WHEN finalized THEN tax_cents END,
        CASE WHEN finalized THEN taxable_cents + tax_cents END
      FROM totaled
    `, [JSON.stringify(lines)]);
    const finalizedIds = batch.filter(doc => doc.finalized).map(doc => ids.get(doc.title));
    if (finalizedIds.length > 0) {
      await client.query(`
        UPDATE documents AS target SET status = 'finalized', finalized_at = now(),
          finalized_subtotal_cents = totals.subtotal_cents,
          finalized_discount_cents = totals.discount_cents,
          finalized_taxable_cents = totals.taxable_cents,
          finalized_tax_cents = totals.tax_cents,
          finalized_total_cents = totals.total_cents
        FROM (
          SELECT document_id, sum(finalized_subtotal_cents) AS subtotal_cents,
            sum(discount_cents) AS discount_cents,
            sum(finalized_taxable_cents) AS taxable_cents,
            sum(finalized_tax_cents) AS tax_cents,
            sum(finalized_total_cents) AS total_cents
          FROM line_items WHERE document_id = ANY($1::uuid[]) GROUP BY document_id
        ) AS totals
        WHERE target.id = totals.document_id
      `, [finalizedIds]);
    }
  });
}

async function main(): Promise<void> {
  const filesystem = statfsSync('.');
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const expectedLines = DOCUMENT_COUNT * (MIN_LINES + MAX_LINES) / 2;
  const estimatedBytes = expectedLines * 320;
  if (freeBytes < estimatedBytes && !process.argv.includes('--allow-low-space')) {
    throw new Error(`Need ~${(estimatedBytes / 2 ** 30).toFixed(1)} GiB free for ${expectedLines.toLocaleString()} expected lines; ${(freeBytes / 2 ** 30).toFixed(1)} GiB available. Run with --allow-low-space only after moving PostgreSQL data to a larger volume.`);
  }
  const connectionString = process.env.MIGRATOR_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATOR_DATABASE_URL is required.');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('seed-large-local-v1')) AS locked",
    );
    if (!lock.rows[0].locked) throw new Error('This seed is already running.');
    const batchLimit = process.argv.find(arg => arg.startsWith('--batches='));
    let batchesRemaining = batchLimit ? Number(batchLimit.split('=')[1]) : Number.POSITIVE_INFINITY;
    if (batchLimit && (!Number.isInteger(batchesRemaining) || batchesRemaining < 1)) {
      throw new Error('--batches must be a positive integer.');
    }
    const hash = await argon2.hash(password(), { type: argon2.argon2id });
    const ownerIds = await createOwners(client, hash);
    for (let owner = 0; owner < ownerIds.length; owner += 1) {
      const ownerId = ownerIds[owner];
      const ownerCount = Math.floor((DOCUMENT_COUNT + 2 - owner) / 3);
      let completed = await completedForOwner(client, ownerId, owner);
      while (completed < ownerCount) {
        const count = Math.min(BATCH_SIZE, ownerCount - completed);
        const batch = Array.from({ length: count }, (_, offset) => documentAt(owner + (completed + offset) * 3));
        await insertBatch(client, ownerId, batch);
        batchesRemaining -= 1;
        completed += count;
        if (completed % 1000 < BATCH_SIZE || completed === ownerCount || batchesRemaining === 0) {
          process.stdout.write(`Owner ${owner + 1}: ${completed}/${ownerCount} documents\n`);
          const currentFilesystem = statfsSync('.');
          if (currentFilesystem.bavail * currentFilesystem.bsize < 5 * 2 ** 30) {
            throw new Error('Less than 5 GiB free. Seed stopped after committed batch; rerun to resume after adding space.');
          }
        }
        if (batchesRemaining === 0) return;
      }
    }
    process.stdout.write(`Seed complete. Login: load-${RUN_ID}-{1,2,3}@example.test; password: ${PASSWORD_PATH}\n`);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
