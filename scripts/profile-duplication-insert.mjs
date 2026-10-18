// Disposable-database experiment; application SQL and migrations remain unchanged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { summarizeInsertProfile } from './profile-duplication-insert-report.mjs';
import { verifyDuplicationIsolation } from './profile-duplication-isolation.mjs';

function localUrl(value) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5433', 'Profiler requires disposable PostgreSQL on port 5433');
  assert.equal(url.pathname, '/pricing');
  return url.toString();
}
const connectionString = localUrl(process.env.INSERT_PROFILE_DATABASE_URL ??
  'postgres://pricing_bootstrap:pricing_bootstrap@127.0.0.1:5433/pricing');
const runtimeConnectionString = localUrl(process.env.INSERT_PROFILE_RUNTIME_URL ??
  'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5433/pricing');
const samples = Number(process.env.INSERT_PROFILE_SAMPLES ?? 40);
const maxInsertMs = process.env.INSERT_PROFILE_MAX_MS === undefined ? undefined : Number(process.env.INSERT_PROFILE_MAX_MS);
assert.ok(maxInsertMs === undefined || Number.isFinite(maxInsertMs) && maxInsertMs > 0);
const warmups = 5;
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 200);
const parentCounts = (process.env.INSERT_PROFILE_PARENTS ?? '100,33086').split(',').map(Number);
assert.ok(parentCounts.length <= 4 && parentCounts.every(n => Number.isInteger(n) && n >= 8 && n <= 100000));
const variants = (process.env.INSERT_PROFILE_VARIANTS ?? 'baseline,scalar').split(',');
assert.ok(variants.length > 0 && variants.length <= 2 && variants.every(v => ['baseline', 'scalar'].includes(v)));
assert.equal(new Set(variants).size, variants.length);
const lineCounts = (process.env.INSERT_PROFILE_LINES ?? '2,40,337,411').split(',').map(Number);
assert.ok(lineCounts.length > 0 && lineCounts.every(n => [2, 40, 337, 411].includes(n)));
assert.equal(new Set(lineCounts).size, lineCounts.length);
const sourceLineCount = lineCounts.reduce((sum, n) => sum + n, 0) * 2 + 1;
const modes = ['plain', 'plan-off', 'plan-on'];
const route = await readFile(new URL('../src/server/documents.ts', import.meta.url), 'utf8');
const duplicateRoute = route.split("router.post('/:id/duplicate'")[1]?.split("router.post('/:id/finalize'")[0];
const match = duplicateRoute?.match(/transaction\.execute\(sql`(\s*INSERT INTO line_items[^`]+)`\)/);
assert.ok(match, 'Bulk-copy SQL moved; update profiler extraction before measuring');
const insertSql = match[1].replaceAll('${copyId}', '$1').replaceAll('${source.id}', '$2').trim();
assert.ok(!insertSql.includes('${'), 'Unexpected SQL interpolation');
const scalarUsing = `(SELECT parent.owner_id FROM public.documents AS parent
  WHERE parent.id = line_items.document_id) = nullif(current_setting('app.user_id', true), '')::uuid`;
const runId = randomUUID();
const recoveryPath = process.argv[2] === '--cleanup' ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || process.argv.length === 4 && recoveryPath, 'Usage: script [--cleanup ledger.json]');
const output = `.artifacts/insert-profile-${runId}`;
await mkdir(output, { recursive: true });
const ledgerPath = recoveryPath ?? `${output}/cleanup-ledger.json`;
const ledger = recoveryPath ? JSON.parse(await readFile(recoveryPath, 'utf8')) : { runId, owners: [], phase: 'starting' };
const pool = new Pool({ connectionString, max: 2 });
const runtimePool = new Pool({ connectionString: runtimeConnectionString, max: 4, connectionTimeoutMillis: 5000 });
const results = { runId, lifecycle: 'committed-fixtures-per-copy-transaction', samples, warmups,
  fixtureMaintenance: 'vacuum-empty-tables-reindex-committed-fixtures-vacuum-analyze-before-every-sample',
  parentCounts, lineCounts, sourceLineCount, variants, modes, insertSql, scalarUsing, cases: [], workloads: [], records: [], isolation: [] };
let admin;
let worker;
let ownsLock = false;
let prepared = false;
let workerCleanupError;
const roundMs = n => +n.toFixed(3);
async function saveLedger() {
  await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
  await rename(`${ledgerPath}.tmp`, ledgerPath);
}
const rotate = (values, n) => [...values.slice(n % values.length), ...values.slice(0, n % values.length)];
async function policy() {
  return (await admin.query(`SELECT policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename='line_items' AND policyname='line_items_owner_isolation'`)).rows[0];
}
async function setPolicy(variant) {
  // Autocommitted before runtime work: no ALTER POLICY lock in measured transactions.
  await admin.query(`ALTER POLICY line_items_owner_isolation ON public.line_items USING (${variant === 'scalar' ? scalarUsing : ledger.originalPolicy.qual})`);
  const actual = await policy();
  assert.deepEqual({ ...actual, qual: ledger.originalPolicy.qual }, ledger.originalPolicy, 'Only USING may change');
  return actual;
}
async function vacuum() {
  // AUTO may skip sparse index cleanup, retaining dead item identifiers and heap pages.
  await admin.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) public.line_items');
  await admin.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) public.documents');
}
async function sizes() {
  return (await admin.query(`SELECT relname,reltuples,relpages,pg_relation_size(oid)::text AS heap_bytes,
    pg_indexes_size(oid)::text AS index_bytes FROM pg_class
    WHERE oid IN ('documents'::regclass,'line_items'::regclass) ORDER BY relname`)).rows;
}
async function counts() {
  return (await admin.query(`SELECT (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM documents)::int AS documents,(SELECT count(*) FROM line_items)::int AS lines`)).rows[0];
}
async function cleanOwners() {
  if (!ledger.owners.length) return;
  assert.ok(ledger.owners.every(id => /^[0-9a-f-]{36}$/.test(id)));
  const owned = (await admin.query('SELECT id,email_canonical,password_hash FROM users WHERE id=ANY($1::uuid[])', [ledger.owners])).rows;
  assert.ok(owned.every(row => row.email_canonical === `insert-profile-${ledger.runId}-${row.id}@example.test`
    && row.password_hash === '$argon2id$diagnostic-fixture'), 'Cleanup ledger must identify only this run’s synthetic fixtures');
  await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ledger.owners]);
  ledger.owners = [];
  await saveLedger();
}
async function fixture(parentCount) {
  assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 });
  await vacuum(); // Truncate the empty heap before new live fixtures can pin old pages.
  const emptySizes = await sizes();
  assert.ok(emptySizes.every(table => table.heap_bytes === '0'), 'Empty heaps must be truncated before fixture setup');
  const owner = randomUUID();
  const foreignOwner = randomUUID();
  ledger.owners = [owner, foreignOwner];
  ledger.phase = 'fixture-pending';
  await saveLedger(); // Durable owner IDs before any possible fixture COMMIT.
  await admin.query('BEGIN');
  try {
    for (const id of ledger.owners) {
      await admin.query(`INSERT INTO users (id,email_display,email_canonical,password_hash)
        VALUES ($1,$2,$2,'$argon2id$diagnostic-fixture')`, [id, `insert-profile-${runId}-${id}@example.test`]);
    }
    await admin.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date)
      SELECT $1,'Diagnostic parent','Synthetic customer','2026-10-18' FROM generate_series(1,$2)`, [foreignOwner, parentCount * 2]);
    const foreignDocument = (await admin.query('SELECT id FROM documents WHERE owner_id=$1 LIMIT 1', [foreignOwner])).rows[0].id;
    await admin.query(`INSERT INTO line_items (document_id,position,description,quantity,unit_price_cents)
      VALUES ($1,1,'Foreign fixture',2,100)`, [foreignDocument]);
    await admin.query(`UPDATE documents SET draft_subtotal_cents=200,draft_taxable_cents=200,draft_total_cents=200 WHERE id=$1`, [foreignDocument]);
    await admin.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date)
      SELECT $1,'Diagnostic parent','Synthetic customer','2026-10-18' FROM generate_series(1,$2)`, [owner, parentCount - lineCounts.length * 2]);
    const cases = [];
    for (const state of ['draft', 'finalized']) for (const count of lineCounts) {
      const source = (await admin.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date,
        draft_subtotal_cents,draft_taxable_cents,draft_total_cents)
        VALUES ($1,'Diagnostic source','Synthetic customer','2026-10-18',$2,$2,$2) RETURNING id`, [owner, count * 200])).rows[0].id;
      await admin.query(`INSERT INTO line_items (document_id,position,description,quantity,unit_price_cents)
        SELECT $1,n,'Synthetic item ' || n,2,100 FROM generate_series(1,$2) AS n`, [source, count]);
      if (state === 'finalized') {
        await admin.query(`UPDATE line_items SET finalized_subtotal_cents=200,finalized_taxable_cents=200,
          finalized_tax_cents=0,finalized_total_cents=200 WHERE document_id=$1`, [source]);
        await admin.query(`UPDATE documents SET status='finalized',finalized_at=now(),
          finalized_subtotal_cents=$2,finalized_discount_cents=0,finalized_taxable_cents=$2,
          finalized_tax_cents=0,finalized_total_cents=$2 WHERE id=$1`, [source, count * 200]);
      }
      cases.push({ key: `${parentCount}-${state}-${count}`, parentCount, state, count, source, owner });
    }
    await admin.query('COMMIT');
    ledger.phase = 'fixture-committed';
    await saveLedger();
    // VACUUM cannot shrink old indexes. Remove storage inherited from earlier experiments.
    await admin.query('REINDEX TABLE public.line_items');
    await admin.query('REINDEX TABLE public.documents');
    await vacuum();
    return { cases, owner, foreignOwner, foreignDocument, emptySizes };
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}
async function timed(record, name, operation) {
  const start = performance.now();
  try { return await operation(); }
  finally { record.markers.push({ name, startMs: roundMs(start - record.started), durationMs: roundMs(performance.now() - start) }); }
}
async function measure(testCase, variant, mode, round) {
  await vacuum(); // Outside timings; prevents sample-to-sample dead tuple and estimate inflation.
  const record = { case: testCase.key, variant, mode, round, before: await sizes(), started: performance.now(), markers: [] };
  let id;
  let verification;
  await timed(record, 'transaction.begin', () => worker.query('BEGIN'));
  try {
    await timed(record, 'tenant.bind', () => worker.query("SELECT set_config('app.user_id',$1,true)", [testCase.owner]));
    const source = await timed(record, 'source.lock_read', () => worker.query('SELECT * FROM documents WHERE id=$1 LIMIT 1 FOR UPDATE', [testCase.source]));
    assert.equal(source.rowCount, 1);
    const inserted = await timed(record, 'copy.document_insert', () => worker.query(`INSERT INTO documents
      (owner_id,title,customer_name,issue_date) VALUES ($1,'Diagnostic source','Synthetic customer','2026-10-19') RETURNING id`, [testCase.owner]));
    id = inserted.rows[0].id;
    const prefix = mode === 'plain' ? '' : `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE, FORMAT JSON, TIMING ${mode === 'plan-on' ? 'ON' : 'OFF'}) `;
    const copied = await timed(record, 'copy.lines_insert', () => worker.query(prefix + insertSql, [id, testCase.source]));
    if (mode === 'plain') assert.equal(copied.rowCount, testCase.count);
    else record.plan = copied.rows[0]['QUERY PLAN'][0];
    await timed(record, 'copy.amounts_write', () => worker.query(`UPDATE documents SET
      draft_subtotal_cents=$2,draft_taxable_cents=$2,draft_total_cents=$2 WHERE id=$1`, [id, testCase.count * 200]));
    await timed(record, 'transaction.commit', () => worker.query('COMMIT'));
  } catch (error) { await worker.query('ROLLBACK'); throw error; }
  finally {
    if (id) {
      const verified = await admin.query(`SELECT count(*)::int AS count,min(position) AS first,max(position) AS last,
        bool_and(quantity=2 AND unit_price_cents=100 AND discount_cents=0 AND tax_rate_basis_points=0
          AND description='Synthetic item ' || position AND finalized_subtotal_cents IS NULL
          AND finalized_taxable_cents IS NULL AND finalized_tax_cents IS NULL AND finalized_total_cents IS NULL) AS correct
        FROM line_items WHERE document_id=$1`, [id]);
      // Save evidence of committed rows; errors still fall back to owner-ledger cleanup.
      record.committedRows = verified.rows[0].count;
      verification = verified.rows[0];
      await admin.query('DELETE FROM documents WHERE id=$1 AND owner_id=$2', [id, testCase.owner]);
      assert.equal((await admin.query('SELECT id FROM documents WHERE id=$1', [id])).rowCount, 0);
    }
  }
  assert.equal(record.committedRows, testCase.count);
  assert.deepEqual(verification, { count: testCase.count, first: 1, last: testCase.count, correct: true });
  delete record.started;
  if (round >= 0) results.records.push(record);
}

try {
  admin = await pool.connect();
  for (const sql of ["SET statement_timeout='30s'", "SET lock_timeout='2s'"]) await admin.query(sql);
  ownsLock = (await admin.query("SELECT pg_try_advisory_lock(hashtext('duplication-insert-profiler')) AS locked")).rows[0].locked;
  assert.equal(ownsLock, true, 'Another profiler is active');
  if (recoveryPath) {
    assert.ok(ledger.originalPolicy && Array.isArray(ledger.owners));
    await setPolicy('baseline');
    await cleanOwners();
    assert.deepEqual(await policy(), ledger.originalPolicy);
    results.policyRestored = true;
    ledger.phase = 'clean';
    await saveLedger();
    results.remaining = await counts();
  } else {
    assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 }, 'Profiler requires an empty disposable DB; use its ledger to recover interrupted runs');
    ledger.originalPolicy = await policy();
    assert.ok(ledger.originalPolicy?.qual.includes('EXISTS'), 'Expected original EXISTS policy before experiment');
    await saveLedger();
    prepared = true;
    worker = await pool.connect();
    await worker.query('SET track_io_timing=on');
    await worker.query("SET statement_timeout='30s'");
    await worker.query("SET lock_timeout='2s'");
    await worker.query('SET ROLE pricing_runtime');
    results.runtime = (await worker.query(`SELECT current_user,rolsuper,rolbypassrls,
      row_security_active('documents') AS documents_rls,row_security_active('line_items') AS lines_rls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(results.runtime, { current_user: 'pricing_runtime', rolsuper: false, rolbypassrls: false, documents_rls: true, lines_rls: true });
    results.environment = (await worker.query(`SELECT version(),current_setting('jit') AS jit,
      current_setting('jit_above_cost') AS jit_above_cost,current_setting('shared_buffers') AS shared_buffers,
      current_setting('work_mem') AS work_mem,current_setting('track_io_timing') AS track_io_timing`)).rows[0];
    results.policies = (await admin.query('SELECT tablename,policyname,qual,with_check FROM pg_policies ORDER BY tablename,policyname')).rows;
    results.indexes = (await admin.query("SELECT tablename,indexdef FROM pg_indexes WHERE tablename IN ('documents','line_items') ORDER BY tablename,indexname")).rows;
    results.triggers = (await admin.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('documents','line_items') ORDER BY c.relname,t.tgname`)).rows;
    for (const parents of parentCounts) {
      await setPolicy('baseline');
      const fixtures = await fixture(parents);
      const { cases } = fixtures;
      const workload = { parents, totalParents: parents * 3, totalLines: sourceLineCount, emptySizes: fixtures.emptySizes, sizesBefore: await sizes() };
      results.workloads.push(workload);
      results.cases.push(...cases.map(({ key, parentCount, state, count }) => ({ key, parentCount, state, count })));
      for (const variant of variants) {
        const installedPolicy = await setPolicy(variant);
        results.isolation.push({ parents, variant, installedPolicy,
          checks: await verifyDuplicationIsolation({ runtimePool, admin, ...fixtures, source: cases[0].source }) });
      }
      for (let round = -warmups; round < samples; round += 1) {
        for (const variant of rotate(variants, round + warmups)) {
          await setPolicy(variant);
          for (const testCase of rotate(cases, round + warmups)) {
            for (const mode of rotate(modes, round + warmups)) await measure(testCase, variant, mode, round);
          }
        }
        if (round >= 0 && (round + 1) % 10 === 0) console.log(JSON.stringify({ parents, measuredRounds: round + 1 }));
      }
      for (const testCase of cases) {
        const source = (await admin.query(`SELECT d.status,count(l.id)::int AS lines FROM documents d
          JOIN line_items l ON l.document_id=d.id WHERE d.id=$1 GROUP BY d.status`, [testCase.source])).rows[0];
        assert.deepEqual(source, { status: testCase.state, lines: testCase.count });
      }
      assert.deepEqual(await counts(), { users: 2, documents: parents * 3, lines: sourceLineCount });
      await vacuum();
      workload.sizesAfter = await sizes();
      await setPolicy('baseline');
      await cleanOwners();
    }
  }
} finally {
  try {
    if (worker) {
      try { await worker.query('ROLLBACK'); }
      catch (error) { workerCleanupError = error; results.workerCleanupFailed = true; }
      finally { worker.release(workerCleanupError); }
    }
    if (admin && ownsLock && prepared) {
      await admin.query('ROLLBACK');
      await setPolicy('baseline');
      await cleanOwners();
      assert.deepEqual(await policy(), ledger.originalPolicy);
      results.policyRestored = true;
      results.remaining = await counts();
      ledger.phase = 'clean';
      await saveLedger();
    }
  } finally {
    if (admin) admin.release();
    await Promise.all([pool.end(), runtimePool.end()]);
    await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ output, remaining: results.remaining, policyRestored: results.policyRestored, measured: results.records.length }));
  }
}
if (workerCleanupError) throw workerCleanupError;
assert.deepEqual(results.remaining, { users: 0, documents: 0, lines: 0 });
if (!recoveryPath) {
  const { summary, comparisons, markdown } = summarizeInsertProfile(results);
  await writeFile(`${output}/summary.json`, JSON.stringify({ summary, comparisons }, null, 2), { mode: 0o600 });
  await writeFile(`${output}/report.md`, markdown, { mode: 0o600 });
  console.table(comparisons.length ? comparisons : summary);
  if (maxInsertMs !== undefined) assert.ok(summary.every(row => row.plainMs <= maxInsertMs),
    `Insert median exceeds diagnostic budget ${maxInsertMs} ms; see ${output}/report.md`);
}
