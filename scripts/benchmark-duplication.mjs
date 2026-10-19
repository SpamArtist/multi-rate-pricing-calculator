// Run only against a disposable database and a server configured to use it.
// Usage: BENCH_BASE_URL=http://127.0.0.1:4194 BENCH_VARIANT=baseline-off \
//   node --env-file-if-exists=.env scripts/benchmark-duplication.mjs
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import argon2 from 'argon2';
import { Pool } from 'pg';

const base = process.env.BENCH_BASE_URL ?? 'http://127.0.0.1:4194';
const variant = process.env.BENCH_VARIANT ?? 'unlabeled';
const candidateBase = process.env.BENCH_CANDIDATE_URL;
const candidateVariant = process.env.BENCH_CANDIDATE_VARIANT ?? 'candidate';
const samplesPerCase = Number(process.env.BENCH_SAMPLES ?? 40);
const vacuumBetweenSamples = process.env.BENCH_VACUUM === '1';
const warmups = 5;
const runtimeUrl = new URL(process.env.DATABASE_URL ?? '');
const migratorUrl = new URL(process.env.MIGRATOR_DATABASE_URL ?? '');
const baseUrl = new URL(base);
assert.equal(baseUrl.hostname, '127.0.0.1');
assert.equal(baseUrl.port, '4194');
if (candidateBase) {
  const candidateUrl = new URL(candidateBase);
  assert.equal(candidateUrl.hostname, '127.0.0.1');
  assert.equal(candidateUrl.port, '4195');
  assert.notEqual(variant, candidateVariant, 'Variant labels must differ');
}
assert.equal(runtimeUrl.hostname, '127.0.0.1');
assert.equal(runtimeUrl.port, '5433', 'Benchmark runtime requires isolated port 5433');
assert.equal(runtimeUrl.pathname, '/pricing');
assert.equal(migratorUrl.hostname, '127.0.0.1');
assert.equal(migratorUrl.port, '5433', 'Benchmark cleanup requires isolated port 5433');
assert.equal(migratorUrl.pathname, '/pricing');
assert.ok(Number.isInteger(samplesPerCase) && samplesPerCase >= 1 && samplesPerCase <= 500);
const pool = new Pool({ connectionString: migratorUrl.toString(), max: 1 });
if (process.argv[2] === '--cleanup') {
  assert.equal(process.argv.length, 4);
  const ledger = JSON.parse(await readFile(process.argv[3], 'utf8'));
  assert.match(ledger.runId, /^[0-9a-f-]{36}$/i);
  assert.match(ledger.ownerId, /^[0-9a-f-]{36}$/i);
  assert.equal(ledger.ownerEmail, `dup-bench-${ledger.runId}@example.test`);
  const found = await pool.query('SELECT email_canonical FROM users WHERE id=$1', [ledger.ownerId]);
  if (found.rowCount) {
    assert.equal(found.rows[0].email_canonical, ledger.ownerEmail);
    await pool.query('DELETE FROM users WHERE id=$1', [ledger.ownerId]);
  }
  ledger.pending = [];
  ledger.phase = 'clean';
  await writeFile(`${process.argv[3]}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
  await rename(`${process.argv[3]}.tmp`, process.argv[3]);
  await pool.end();
  process.exit(0);
}
assert.equal(process.argv.length, 2);
const runId = randomUUID();
const outputDir = `.artifacts/duplication-${runId}`;
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const ledgerPath = `${outputDir}/cleanup-ledger.json`;
const resultPath = `${outputDir}/results.json`;
const summaryPath = `${outputDir}/summary.json`;
const pending = new Set();
const cleanup = [];
const samples = [];
const ownerId = randomUUID();
const ownerEmail = `dup-bench-${runId}@example.test`;
let cookie;

async function persistLedger(phase = 'running') {
  await writeFile(`${ledgerPath}.tmp`, JSON.stringify({ runId, ownerId, ownerEmail, phase,
    pending: [...pending] }, null, 2), { mode: 0o600, flush: true });
  await rename(`${ledgerPath}.tmp`, ledgerPath);
}

async function request(path, method = 'GET', body, endpoint = base) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { origin: endpoint, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const headerAt = performance.now();
  const payload = await response.text();
  const parsedAt = performance.now();
  let data;
  try { data = payload ? JSON.parse(payload) : null; } catch { data = null; }
  return { response, data, headerAt, parsedAt, bytes: Buffer.byteLength(payload) };
}

async function expectStatus(path, method, body, status, endpoint = base) {
  const result = await request(path, method, body, endpoint);
  assert.equal(result.response.status, status, `${method} ${path} returned ${result.response.status}`);
  return result;
}

const lines = count => Array.from({ length: count }, (_, index) => ({
  description: `Bench item ${index + 1}`, quantity: 3, unitPriceCents: 1999,
  discountCents: 100, taxRateBasisPoints: 725,
}));

async function createSource(count, state) {
  const connection = await pool.connect();
  let id;
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    const created = await connection.query(`
      INSERT INTO documents (owner_id, title, customer_name, issue_date)
      VALUES ($1, $2, 'Synthetic benchmark customer', '2026-10-18') RETURNING id
    `, [ownerId, `Benchmark ${count} ${state}`]);
    id = created.rows[0].id;
    const fixtureLines = lines(count).map((line, index) => ({ ...line, position: index + 1 }));
    await connection.query(`
      INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents,
        discount_cents, tax_rate_basis_points)
      SELECT $1, input.position, input.description, input.quantity, input.unit_price_cents,
        input.discount_cents, input.tax_rate_basis_points
      FROM jsonb_to_recordset($2::jsonb) AS input(position integer, description text,
        quantity bigint, unit_price_cents bigint, discount_cents bigint, tax_rate_basis_points integer)
    `, [id, JSON.stringify(fixtureLines.map(line => ({
      position: line.position, description: line.description, quantity: line.quantity,
      unit_price_cents: line.unitPriceCents, discount_cents: line.discountCents,
      tax_rate_basis_points: line.taxRateBasisPoints,
    })))]);
    const subtotal = 3 * 1999 * count;
    const discount = 100 * count;
    const taxable = subtotal - discount;
    const tax = Math.round((3 * 1999 - 100) * 725 / 10000) * count;
    await connection.query(`
      UPDATE documents SET draft_subtotal_cents=$2, draft_discount_cents=$3,
        draft_taxable_cents=$4, draft_tax_cents=$5, draft_total_cents=$6 WHERE id=$1
    `, [id, subtotal, discount, taxable, tax, taxable + tax]);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  if (state === 'finalized') await expectStatus(`/documents/${id}/finalize`, 'POST', {}, 200);
  return id;
}

try {
  const counts = await pool.query(`SELECT (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM documents)::int AS documents,
    (SELECT count(*) FROM line_items)::int AS lines`);
  assert.deepEqual(counts.rows[0], { users: 0, documents: 0, lines: 0 },
    'Benchmark requires an empty disposable database; recover old ledger first');
  await persistLedger();
  const password = randomBytes(6).toString('base64url');
  await pool.query(`INSERT INTO users (id, email_display, email_canonical, password_hash)
    VALUES ($1, $2, $2, $3)`, [ownerId, ownerEmail, await argon2.hash(password)]);
  const signin = await expectStatus('/auth/sign-in', 'POST', { email: ownerEmail, password }, 200);
  assert.equal(signin.data.user.id, ownerId, 'HTTP server must use the disposable database');
  cookie = signin.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  if (candidateBase) {
    const session = await expectStatus('/auth/session', 'GET', undefined, 200, candidateBase);
    assert.equal(session.data.user.id, ownerId, 'Candidate server must use the disposable database');
  }

  const cases = [];
  for (const state of ['draft', 'finalized']) {
    for (const count of [2, 40, 350]) {
      cases.push({ key: `${state}-${count}`, state, count, sourceId: await createSource(count, state) });
    }
  }

  for (let round = -warmups; round < samplesPerCase; round += 1) {
    for (const [caseIndex, testCase] of cases.entries()) {
      const variants = candidateBase
        ? [{ base, label: variant }, { base: candidateBase, label: candidateVariant }]
        : [{ base, label: variant }];
      if ((round + caseIndex) % 2 === 0) variants.reverse();
      for (const current of variants) {
        if (vacuumBetweenSamples) {
          await pool.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) line_items');
          await pool.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) documents');
        }
        const start = performance.now();
        const duplicated = await expectStatus(`/documents/${testCase.sourceId}/duplicate`, 'POST',
          { issueDate: '2026-10-19' }, 201, current.base);
      const total = duplicated.parsedAt - start;
      const copy = duplicated.data;
      pending.add(copy.id);
      await persistLedger();
      assert.equal(copy.status, 'draft');
      assert.equal(copy.issueDate, '2026-10-19');
      assert.equal(copy.lineItems.length, testCase.count);
      assert.equal(copy.lineItems[0].description, 'Bench item 1');
      if (round >= 0) samples.push({ variant: current.label, case: testCase.key, round,
        requestId: duplicated.response.headers.get('x-duplication-request-id'),
        headersMs: +(duplicated.headerAt - start).toFixed(3),
        bodyMs: +(duplicated.parsedAt - duplicated.headerAt).toFixed(3),
        totalMs: +total.toFixed(3), bytes: duplicated.bytes });
      await expectStatus(`/documents/${copy.id}`, 'DELETE', undefined, 204);
      pending.delete(copy.id);
      const missing = await expectStatus(`/documents/${copy.id}`, 'GET', undefined, 404);
      assert.equal(missing.data.error.code, 'not_found');
      cleanup.push({ case: testCase.key, round, deleted: true, get404: true });
      await persistLedger();
      }
    }
  }
  await writeFile(resultPath, JSON.stringify({ runId, variants: candidateBase ? [variant, candidateVariant] : [variant],
    samplesPerCase, warmups, vacuumBetweenSamples, samples,
    cleanupCount: cleanup.length, fixtures: cases.map(({ key, count, state }) => ({ key, count, state })) }, null, 2),
  { mode: 0o600 });
  const quantile = (values, fraction) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(fraction * sorted.length) - 1];
  };
  const summary = cases.map(testCase => {
    const byVariant = Object.fromEntries((candidateBase ? [variant, candidateVariant] : [variant]).map(label => {
      const matching = samples.filter(sample => sample.case === testCase.key && sample.variant === label);
      const times = matching.map(sample => sample.totalMs);
      return [label, { count: times.length, p50Ms: quantile(times, 0.5), p90Ms: quantile(times, 0.9),
        ...(times.length >= 200 ? { p95Ms: quantile(times, 0.95) } : {}) }];
    }));
    const baseline = samples.filter(sample => sample.case === testCase.key && sample.variant === variant);
    const candidate = samples.filter(sample => sample.case === testCase.key && sample.variant === candidateVariant);
    const paired = candidateBase ? baseline.map((sample, index) => sample.totalMs - candidate[index].totalMs) : [];
    return { case: testCase.key, byVariant, ...(candidateBase ? { paired: {
      count: paired.length, medianSavingsMs: quantile(paired, 0.5), positivePairs: paired.filter(value => value > 0).length,
      firstHalfMedianMs: quantile(paired.slice(0, Math.floor(paired.length / 2)), 0.5),
      lastHalfMedianMs: quantile(paired.slice(Math.floor(paired.length / 2)), 0.5),
    } } : {}) };
  });
  await writeFile(summaryPath, JSON.stringify({ runId, quantileMethod: 'nearest rank', summary }, null, 2),
    { mode: 0o600 });
  console.log(JSON.stringify({ resultPath, summaryPath, sampleCount: samples.length, cleanupCount: cleanup.length }));
} finally {
  for (const id of pending) {
    try {
      await expectStatus(`/documents/${id}`, 'DELETE', undefined, 204);
      await expectStatus(`/documents/${id}`, 'GET', undefined, 404);
      pending.delete(id);
    } catch { /* Ledger allows recovery if the server is unavailable. */ }
  }
  if (pending.size === 0) {
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
    await persistLedger('clean');
  } else {
    await persistLedger();
  }
  await pool.end();
}
