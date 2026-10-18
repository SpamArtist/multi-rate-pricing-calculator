// Diagnostic only: exact bulk-copy SQL, unchanged policies, rollback-only fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { summarizeInsertProfile } from './profile-duplication-insert-report.mjs';

const url = new URL(process.env.INSERT_PROFILE_DATABASE_URL ??
  'postgres://pricing_bootstrap:pricing_bootstrap@127.0.0.1:5433/pricing');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5433', 'Profiler requires disposable PostgreSQL on port 5433');
assert.equal(url.pathname, '/pricing');
const samples = Number(process.env.INSERT_PROFILE_SAMPLES ?? 40);
const maxInsertMs = process.env.INSERT_PROFILE_MAX_MS === undefined ? undefined : Number(process.env.INSERT_PROFILE_MAX_MS);
assert.ok(maxInsertMs === undefined || Number.isFinite(maxInsertMs) && maxInsertMs > 0);
const warmups = 5;
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 200);
const parentCounts = (process.env.INSERT_PROFILE_PARENTS ?? '100,33086').split(',').map(Number);
assert.ok(parentCounts.length <= 4 && parentCounts.every(n => Number.isInteger(n) && n >= 8 && n <= 100000));
const lineCounts = [2, 40, 337, 411];
const modes = ['plain', 'plan-off', 'plan-on'];
// Extract the actual INSERT so future route changes cannot silently leave a stale benchmark.
const route = await readFile(new URL('../src/server/documents.ts', import.meta.url), 'utf8');
const duplicateRoute = route.split("router.post('/:id/duplicate'")[1]?.split("router.post('/:id/finalize'")[0];
const match = duplicateRoute?.match(/transaction\.execute\(sql`(\s*INSERT INTO line_items[^`]+)`\)/);
assert.ok(match, 'Bulk-copy SQL moved; update profiler extraction before measuring');
const insertSql = match[1].replaceAll('${copyId}', '$1').replaceAll('${source.id}', '$2').trim();
assert.ok(!insertSql.includes('${'), 'Unexpected SQL interpolation');
const runId = randomUUID();
const output = `.artifacts/insert-profile-${runId}`;
await mkdir(output, { recursive: true });
const pool = new Pool({ connectionString: url.toString(), max: 1 });
const results = { runId, samples, warmups, parentCounts, lineCounts, modes, insertSql, cases: [], workloads: [], records: [] };
let client;
let transactionOpen = false;
const roundMs = n => +n.toFixed(3);

async function beginWorkload() {
  // Remove previous rollback debris before collecting a different population's plans.
  await client.query('VACUUM (ANALYZE) line_items');
  await client.query('VACUUM (ANALYZE) documents');
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query('SET LOCAL track_io_timing=on');
}

async function relationSizes() {
  return (await client.query(`SELECT relname,pg_relation_size(oid)::text AS heap_bytes,
    pg_indexes_size(oid)::text AS index_bytes FROM pg_class
    WHERE oid IN ('documents'::regclass,'line_items'::regclass) ORDER BY relname`)).rows;
}

async function timed(record, name, operation) {
  const start = performance.now();
  try { return await operation(); }
  finally { record.markers.push({ name, startMs: roundMs(start - record.started), durationMs: roundMs(performance.now() - start) }); }
}

async function fixture(parentCount) {
  const owner = randomUUID();
  const foreignOwner = randomUUID();
  for (const id of [owner, foreignOwner]) {
    await client.query(`INSERT INTO users (id,email_display,email_canonical,password_hash)
      VALUES ($1,$2,$2,'$argon2id$diagnostic-fixture')`, [id, `${id}@example.test`]);
  }
  await client.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date)
    SELECT $1,'Diagnostic parent','Synthetic customer','2026-10-18' FROM generate_series(1,$2)`, [foreignOwner, parentCount * 2]);
  await client.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date)
    SELECT $1,'Diagnostic parent','Synthetic customer','2026-10-18' FROM generate_series(1,$2)`, [owner, parentCount - 8]);
  const cases = [];
  for (const state of ['draft', 'finalized']) {
    for (const count of lineCounts) {
      const source = (await client.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date,
        draft_subtotal_cents,draft_taxable_cents,draft_total_cents)
        VALUES ($1,'Diagnostic source','Synthetic customer','2026-10-18',$2,$2,$2) RETURNING id`, [owner, count * 200])).rows[0].id;
      await client.query(`INSERT INTO line_items (document_id,position,description,quantity,unit_price_cents)
        SELECT $1,n,'Synthetic item ' || n,2,100 FROM generate_series(1,$2) AS n`, [source, count]);
      if (state === 'finalized') {
        await client.query(`UPDATE line_items SET finalized_subtotal_cents=200,finalized_taxable_cents=200,
          finalized_tax_cents=0,finalized_total_cents=200 WHERE document_id=$1`, [source]);
        await client.query(`UPDATE documents SET status='finalized',finalized_at=now(),
          finalized_subtotal_cents=$2,finalized_discount_cents=0,finalized_taxable_cents=$2,
          finalized_tax_cents=0,finalized_total_cents=$2 WHERE id=$1`, [source, count * 200]);
      }
      cases.push({ key: `${parentCount}-${state}-${count}`, parentCount, state, count, source, owner });
    }
  }
  await client.query('ANALYZE documents');
  await client.query('ANALYZE line_items');
  return cases;
}

async function measure(testCase, mode, round) {
  const record = { case: testCase.key, mode, round, started: performance.now(), markers: [] };
  await timed(record, 'sample.savepoint', () => client.query('SAVEPOINT sample'));
  try {
    await timed(record, 'tenant.role', () => client.query('SET LOCAL ROLE pricing_runtime'));
    await timed(record, 'tenant.bind', () => client.query("SELECT set_config('app.user_id',$1,true)", [testCase.owner]));
    await timed(record, 'source.lock_read', () => client.query('SELECT * FROM documents WHERE id=$1 LIMIT 1 FOR UPDATE', [testCase.source]));
    const inserted = await timed(record, 'copy.document_insert', () => client.query(`INSERT INTO documents
      (owner_id,title,customer_name,issue_date) VALUES ($1,'Diagnostic source','Synthetic customer','2026-10-19') RETURNING id`, [testCase.owner]));
    const id = inserted.rows[0].id;
    const prefix = mode === 'plain' ? '' : `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE, FORMAT JSON, TIMING ${mode === 'plan-on' ? 'ON' : 'OFF'}) `;
    const insertedLines = await timed(record, 'copy.lines_insert', () => client.query(prefix + insertSql, [id, testCase.source]));
    if (mode === 'plain') assert.equal(insertedLines.rowCount, testCase.count);
    else record.plan = insertedLines.rows[0]['QUERY PLAN'][0];
    const verified = await timed(record, 'copy.verify', () => client.query(`SELECT count(*)::int AS count,
      min(position) AS first, max(position) AS last,
      bool_and(quantity=2 AND unit_price_cents=100 AND discount_cents=0 AND tax_rate_basis_points=0
        AND description='Synthetic item ' || position AND finalized_total_cents IS NULL) AS correct
      FROM line_items WHERE document_id=$1`, [id]));
    assert.deepEqual(verified.rows[0], { count: testCase.count, first: 1, last: testCase.count, correct: true });
  } finally {
    await timed(record, 'sample.rollback', () => client.query('ROLLBACK TO SAVEPOINT sample'));
    await client.query('RELEASE SAVEPOINT sample');
  }
  delete record.started;
  if (round >= 0) results.records.push(record);
}

try {
  const start = performance.now();
  client = await pool.connect();
  results.connectMs = roundMs(performance.now() - start);
  await client.query("SET statement_timeout='30s'");
  await client.query("SET lock_timeout='2s'");
  assert.equal((await client.query("SELECT pg_try_advisory_lock(hashtext('duplication-insert-profiler')) AS locked")).rows[0].locked, true,
    'Another profiler is active');
  const initial = (await client.query('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM documents)::int AS documents')).rows[0];
  assert.deepEqual(initial, { users: 0, documents: 0 }, 'Profiler requires an empty disposable DB');
  await beginWorkload();
  results.environment = (await client.query(`SELECT version(), current_setting('jit') AS jit,
    current_setting('jit_above_cost') AS jit_above_cost,
    current_setting('jit_inline_above_cost') AS jit_inline_above_cost,
    current_setting('jit_optimize_above_cost') AS jit_optimize_above_cost,
    current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem,
    current_setting('track_io_timing') AS track_io_timing`)).rows[0];
  results.policies = (await client.query('SELECT tablename,policyname,qual,with_check FROM pg_policies ORDER BY tablename,policyname')).rows;
  results.triggers = (await client.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('documents','line_items') ORDER BY c.relname,t.tgname`)).rows;
  results.indexes = (await client.query("SELECT tablename,indexdef FROM pg_indexes WHERE tablename IN ('documents','line_items') ORDER BY tablename,indexname")).rows;
  results.constraints = (await client.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid IN ('documents'::regclass,'line_items'::regclass) ORDER BY conname`)).rows;
  await client.query('SET LOCAL ROLE pricing_runtime');
  results.runtime = (await client.query(`SELECT current_user,rolsuper,rolbypassrls,
    row_security_active('documents') AS documents_rls,row_security_active('line_items') AS lines_rls
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(results.runtime.rolsuper, false);
  assert.equal(results.runtime.rolbypassrls, false);
  assert.equal(results.runtime.documents_rls, true);
  assert.equal(results.runtime.lines_rls, true);
  await client.query('RESET ROLE');
  for (const parents of parentCounts) {
    if (!transactionOpen) await beginWorkload();
    const cases = await fixture(parents);
    const workload = { parents, totalParents: parents * 3, totalLines: 1580,
      sizesBefore: await relationSizes(),
      statistics: (await client.query(`SELECT c.relname,c.reltuples,c.relpages,s.n_live_tup,s.n_dead_tup,
        s.last_analyze,s.last_autoanalyze,s.last_vacuum,s.last_autovacuum FROM pg_class c
        JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE c.relname IN ('documents','line_items')`)).rows };
    results.workloads.push(workload);
    results.cases.push(...cases.map(({ key, parentCount, state, count }) => ({ key, parentCount, state, count })));
    for (let round = -warmups; round < samples; round += 1) {
      // Rotate both case and probe order so diagnostics do not always get the warmest cache.
      const offset = (round + warmups) % cases.length;
      for (const testCase of [...cases.slice(offset), ...cases.slice(0, offset)]) {
        const modeOffset = (round + warmups) % modes.length;
        for (const mode of [...modes.slice(modeOffset), ...modes.slice(0, modeOffset)]) await measure(testCase, mode, round);
      }
      if (round >= 0 && (round + 1) % 10 === 0) console.log(JSON.stringify({ parents, measuredRounds: round + 1 }));
    }
    for (const testCase of cases) {
      const source = (await client.query(`SELECT d.status,count(l.id)::int AS lines FROM documents d
        JOIN line_items l ON l.document_id=d.id WHERE d.id=$1 GROUP BY d.status`, [testCase.source])).rows[0];
      assert.deepEqual(source, { status: testCase.state, lines: testCase.count });
    }
    assert.equal((await client.query('SELECT count(*)::int AS count FROM documents')).rows[0].count, parents * 3);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM line_items')).rows[0].count, 1580);
    workload.sizesAfter = await relationSizes();
    const rollbackStart = performance.now();
    await client.query('ROLLBACK');
    transactionOpen = false;
    workload.rollbackMs = roundMs(performance.now() - rollbackStart);
  }
} finally {
  if (client) {
    if (transactionOpen) await client.query('ROLLBACK');
    results.remaining = (await client.query('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM documents)::int AS documents, (SELECT count(*) FROM line_items)::int AS lines')).rows[0];
    client.release();
  }
  await pool.end();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, remaining: results.remaining, measured: results.records.length }));
}
assert.deepEqual(results.remaining, { users: 0, documents: 0, lines: 0 });
const { summary, markdown } = summarizeInsertProfile(results);
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
await writeFile(`${output}/report.md`, markdown, { mode: 0o600 });
console.table(summary);
if (maxInsertMs !== undefined) {
  assert.ok(summary.every(row => row.plainMs <= maxInsertMs), `Insert median exceeds diagnostic budget ${maxInsertMs} ms; see ${output}/report.md`);
}
