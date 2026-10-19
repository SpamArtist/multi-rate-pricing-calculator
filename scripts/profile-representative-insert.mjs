// Measurement only: policies and endpoint code stay unchanged; HTTP UUID mode
// temporarily switches the disposable line-ID default with ledgered recovery.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { build } from 'esbuild';
import { Pool } from 'pg';
import argon2 from 'argon2';
import { createRepresentativeParents, populateRepresentativeParents } from './profile-representative-fixture.mjs';
import { verifyHttpCopy } from './profile-duplication-http-checks.mjs';
import { measurePrimaryKeyProbes } from './profile-index-probes.mjs';
import { measureUuidHttp } from './profile-uuid-http.mjs';
import { measureSerialCosts, serialFilesystem } from './profile-serial-costs.mjs';

function local(value) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5433'); assert.equal(url.pathname, '/pricing');
  return url.href;
}
const adminUrl = local(process.env.REPRESENTATIVE_DATABASE_URL ?? 'postgres://pricing_bootstrap:pricing_bootstrap@127.0.0.1:5433/pricing');
const runtimeUrl = local(process.env.REPRESENTATIVE_RUNTIME_URL ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5433/pricing');
const samples = Number(process.env.REPRESENTATIVE_SAMPLES ?? 20);
const uuidLocality = process.env.REPRESENTATIVE_UUID_LOCALITY === '1';
const uuidHttp = process.env.REPRESENTATIVE_UUID_HTTP === '1';
const serialCosts = process.env.REPRESENTATIVE_SERIAL_COSTS === '1';
assert.ok([uuidLocality, uuidHttp, serialCosts].filter(Boolean).length <= 1, 'Choose one experiment');
const levels = (process.env.REPRESENTATIVE_LEVELS ?? '1004,10004').split(',').map(Number);
assert.ok(Number.isInteger(samples) && samples >= 5 && samples <= 100);
assert.ok(levels.length && levels.every((n, i) => Number.isInteger(n) && n >= 4 && n <= 20004 && (!i || n > levels[i - 1])));
const recovery = process.argv[2] === '--cleanup' ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || process.argv.length === 4 && recovery);
const runId = randomUUID();
const output = resolve(`.artifacts/representative-insert-${runId}`);
await mkdir(output, { recursive: true });
const ledgerPath = recovery ?? `${output}/cleanup-ledger.json`;
const ledger = recovery ? JSON.parse(await readFile(recovery, 'utf8')) : { kind: 'representative-insert', runId, owners: [], phase: 'starting' };
const results = { runId, levels, samples, experiment: serialCosts ? 'serial-costs' : uuidHttp ? 'uuid-http' : uuidLocality ? 'uuid-locality' : 'baseline', records: [], http: [], uuidHttp: [], phases: [], checks: [], indexProbes: [] };
const pool = new Pool({ connectionString: adminUrl, max: 2 });
let admin, worker, child, childExit;
let prepared = false, locked = false, interrupted = false;
process.on('SIGTERM', () => { interrupted = true; });
process.on('SIGINT', () => { interrupted = true; });
const round = n => +n.toFixed(3);
const base = 'http://127.0.0.1:4194';
const hash = value => createHash('sha256').update(value).digest('hex');
async function saveLedger() {
  await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
  await rename(`${ledgerPath}.tmp`, ledgerPath);
}
async function policies() {
  return (await admin.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
}
async function databaseIdentity() {
  return (await admin.query("SELECT current_database() database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,system_identifier::text FROM pg_control_system()")).rows[0];
}
async function schemaInventory() {
  return {
    defaults: (await admin.query("SELECT table_name,column_name,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
    indexes: (await admin.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
    constraints: (await admin.query("SELECT conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname")).rows,
    acls: (await admin.query("SELECT c.relname,a.attname,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 ORDER BY c.relname,a.attnum")).rows,
  };
}
async function counts() {
  return (await admin.query('SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM documents)::int documents,(SELECT count(*) FROM line_items)::int lines')).rows[0];
}
async function inventory() {
  return { relations: (await admin.query(`SELECT relname,reltuples,relpages,relallvisible,
    pg_relation_size(oid)::text heap_bytes,pg_indexes_size(oid)::text index_bytes FROM pg_class
    WHERE oid IN ('documents'::regclass,'line_items'::regclass)`)).rows,
    stats: (await admin.query("SELECT tablename,attname,n_distinct,avg_width,correlation FROM pg_stats WHERE tablename IN ('documents','line_items')")).rows,
    io: (await admin.query("SELECT relname,indexrelname,idx_blks_read,idx_blks_hit FROM pg_statio_user_indexes WHERE relname IN ('documents','line_items')")).rows,
    tableStats: (await admin.query("SELECT relname,n_live_tup,n_dead_tup,last_vacuum,last_autovacuum,last_analyze,last_autoanalyze FROM pg_stat_user_tables WHERE relname IN ('documents','line_items')")).rows };
}
async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  if (await Promise.race([childExit, delay(5000, 'timeout', { ref: false })]) === 'timeout') { child.kill('SIGKILL'); await childExit; }
  child = undefined;
}
async function request(path, method = 'GET', body, cookie) {
  const start = performance.now();
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000),
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data, totalMs: round(performance.now() - start),
    requestId: response.headers.get('x-duplication-request-id'), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function startServer(mode, level) {
  await stopServer();
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(4194, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  let ready = false;
  const tracePath = `${output}/traces-${level}-${mode}.ndjson`;
  child = spawn(process.execPath, [`${output}/server.mjs`], { env: { ...process.env,
    DATABASE_URL: runtimeUrl, API_PORT: '4194', PRICING_DUPLICATION_TRACE: mode === 'on' ? '1' : '0',
    PRICING_DUPLICATION_TRACE_FILE: tracePath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stdout.on('data', b => { if (b.toString().includes('API listening')) ready = true; });
  child.stderr.on('data', () => {});
  for (let n = 0; n < 100; n++) {
    if (ready) { assert.equal((await request('/health')).status, 200); return tracePath; }
    assert.equal(child.exitCode, null); await delay(100);
  }
  throw new Error('Server startup timeout');
}
async function cleanup() {
  assert.equal(ledger.kind, 'representative-insert');
  assert.match(ledger.runId, /^[0-9a-f-]{36}$/);
  if (ledger.databaseIdentity) assert.deepEqual(await databaseIdentity(), ledger.databaseIdentity, 'Recovery ledger belongs to another database');
  assert.deepEqual(await policies(), ledger.policies, 'Policy changed: inspect before fixture cleanup');
  const users = (await admin.query('SELECT id,email_canonical FROM users')).rows;
  assert.ok(users.every(row => ledger.owners.includes(row.id) && row.email_canonical === `representative-${ledger.runId}-${row.id.slice(0, 8)}@example.test`), 'Unrelated users: refusing broad fixture cleanup');
  const foreign = (await admin.query('SELECT count(*)::int n FROM documents WHERE NOT (owner_id=ANY($1::uuid[]))', [ledger.owners])).rows[0].n;
  assert.equal(foreign, 0, 'Unrelated documents: refusing broad fixture cleanup');
  // The DB was empty on entry and all current tenant rows belong to this ledger.
  // Truncate only this verified disposable fixture, avoiding millions of cascading deletes.
  await admin.query('BEGIN');
  try {
    await admin.query('LOCK TABLE users,documents,line_items,draft_save_mutations IN ACCESS EXCLUSIVE MODE');
    const current = (await admin.query('SELECT id,email_canonical FROM users')).rows;
    assert.ok(current.every(row => ledger.owners.includes(row.id) && row.email_canonical === `representative-${ledger.runId}-${row.id.slice(0, 8)}@example.test`));
    assert.equal((await admin.query('SELECT count(*)::int n FROM documents WHERE NOT (owner_id=ANY($1::uuid[]))', [ledger.owners])).rows[0].n, 0);
    if (ledger.phase === 'clean' && ledger.schema) assert.deepEqual(await schemaInventory(), ledger.schema, 'A clean ledger must not overwrite newer schema state');
    if (ledger.uuidHttpDefault) {
      assert.equal(ledger.uuidHttpDefault, 'gen_random_uuid()');
      await admin.query('ALTER TABLE public.line_items ALTER COLUMN id SET DEFAULT gen_random_uuid()');
    }
    if (ledger.diagnosticIdGrant) await admin.query('REVOKE INSERT(id) ON line_items FROM pricing_runtime');
    if (ledger.schema) assert.deepEqual(await schemaInventory(), ledger.schema, 'Unexpected schema changes: refusing fixture cleanup');
    await admin.query('TRUNCATE TABLE line_items,documents,draft_save_mutations');
    await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ledger.owners]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
  assert.deepEqual(await policies(), ledger.policies, 'Policy changed during measurement');
  results.policyUnchanged = true;
  if (ledger.schema) { assert.deepEqual(await schemaInventory(), ledger.schema); results.schemaUnchanged = true; }
  results.remaining = await counts();
  assert.deepEqual(results.remaining, { users: 0, documents: 0, lines: 0 });
  ledger.phase = 'clean'; await saveLedger();
}
async function setUuidDefault(variant) {
  assert.ok(uuidHttp && ['v4', 'v7'].includes(variant));
  assert.equal(ledger.uuidHttpDefault, 'gen_random_uuid()');
  await admin.query(`ALTER TABLE public.line_items ALTER COLUMN id SET DEFAULT ${variant === 'v7' ? 'uuidv7()' : 'gen_random_uuid()'}`);
  const current = await schemaInventory();
  const changed = current.defaults.find(c => c.table_name === 'line_items' && c.column_name === 'id');
  assert.equal(changed.column_default, variant === 'v7' ? 'uuidv7()' : 'gen_random_uuid()');
  changed.column_default = ledger.uuidHttpDefault;
  assert.deepEqual(current, ledger.schema, 'Only the disposable line-ID default may change');
  assert.deepEqual(await policies(), ledger.policies);
  ledger.phase = `uuid-http-${variant}`; await saveLedger();
}
const route = await readFile('src/server/documents.ts', 'utf8');
const section = route.split("router.post('/:id/duplicate'")[1]?.split("router.post('/:id/finalize'")[0];
const match = section?.match(/transaction\.execute\(sql`(\s*INSERT INTO line_items[^`]+)`\)/);
assert.ok(match);
const insertSql = match[1].replaceAll('${copyId}', '$1').replaceAll('${source.id}', '$2');
assert.ok(!insertSql.includes('${'));
results.insertSql = insertSql;
const candidateSql = insertSql.replace(/INSERT INTO line_items\s*\(/, 'INSERT INTO line_items (id,').replace(/SELECT\s+/, 'SELECT uuidv7(), ');
assert.notEqual(candidateSql, insertSql);
assert.ok(candidateSql.includes('SELECT uuidv7(), $1'));
const explicitV4Sql = candidateSql.replace('uuidv7()', 'gen_random_uuid()');
if (uuidLocality) { results.candidateSql = candidateSql; results.explicitV4Sql = explicitV4Sql; }
async function measure(source, level, mode, sample, variant = 'v4') {
  assert.equal(interrupted, false, 'Interrupted');
  const record = { level, case: `${source.state}-${source.count}`, mode, round: sample, variant, markers: {} };
  let id;
  async function timed(name, fn) { const start = performance.now(); try { return await fn(); } finally { record.markers[name] = round(performance.now() - start); } }
  await worker.query('BEGIN');
  try {
    await worker.query("SELECT set_config('app.user_id',$1,true)", [source.owner]);
    await timed('source.lock', () => worker.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [source.id]));
    id = (await timed('document.insert', () => worker.query("INSERT INTO documents(owner_id,title,customer_name,issue_date) VALUES($1,'Synthetic copy','Synthetic customer','2026-10-19') RETURNING id", [source.owner]))).rows[0].id;
    const prefix = mode === 'plain' ? '' : `EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,VERBOSE,FORMAT JSON,TIMING ${mode === 'plan-on' ? 'ON' : 'OFF'}) `;
    const sqlText = variant === 'v7' ? candidateSql : variant === 'v4-explicit' ? explicitV4Sql : insertSql;
    const inserted = await timed('lines.insert', () => worker.query(prefix + sqlText, [id, source.id]));
    if (mode === 'plain') assert.equal(inserted.rowCount, source.count);
    else record.plan = inserted.rows[0]['QUERY PLAN'][0];
    await timed('transaction.commit', () => worker.query('COMMIT'));
    const copied = (await admin.query(`SELECT position,description,quantity,unit_price_cents,discount_cents,tax_rate_basis_points,
      finalized_subtotal_cents,finalized_taxable_cents,finalized_tax_cents,finalized_total_cents FROM line_items WHERE document_id=$1 ORDER BY position`, [id])).rows;
    assert.deepEqual(copied, source.expectedCopy);
    if (uuidLocality) {
      const ids = (await admin.query('SELECT id,uuid_extract_version(id)::int version FROM line_items WHERE document_id=$1', [id])).rows;
      assert.equal(ids.length, source.count);
      assert.ok(ids.every(row => row.version === (variant === 'v7' ? 7 : 4)));
      assert.equal(new Set(ids.map(row => row.id)).size, source.count);
      const sourceIds = new Set(source.before.map(row => row.id));
      assert.ok(ids.every(row => !sourceIds.has(row.id)));
      record.idVersion = ids[0].version;
    } else await admin.query('DELETE FROM documents WHERE id=$1', [id]);
    if (sample >= 0) results.records.push(record);
    return id;
  } catch (error) { await worker.query('ROLLBACK'); throw error; }
}
async function httpPhase(sources, level, email, password) {
  for (const mode of ['off', 'on']) {
    const path = await startServer(mode, level);
    const login = await request('/auth/sign-in', 'POST', { email, password });
    assert.equal(login.status, 200); assert.ok(login.cookie);
    const inputs = [];
    for (const source of sources.slice(0, 2)) {
      const response = await request(`/documents/${source.id}`, 'GET', undefined, login.cookie);
      assert.equal(response.status, 200); inputs.push(response.data);
    }
    for (let sample = -5; sample < (mode === 'on' ? 10 : samples); sample++) for (const [index, source] of inputs.entries()) {
      assert.equal(interrupted, false, 'Interrupted');
      const response = await request(`/documents/${source.id}/duplicate`, 'POST', { issueDate: '2026-10-19' }, login.cookie);
      assert.equal(response.status, 201); verifyHttpCopy(response.data, source);
      if (sample >= 0) results.http.push({ level, mode, case: `${sources[index].state}-${sources[index].count}`, round: sample,
        totalMs: response.totalMs, requestId: response.requestId });
      assert.equal((await request(`/documents/${response.data.id}`, 'DELETE', undefined, login.cookie)).status, 204);
      assert.equal((await request(`/documents/${response.data.id}`, 'GET', undefined, login.cookie)).status, 404);
    }
    if (mode === 'on') {
      const records = results.http.filter(r => r.level === level && r.mode === mode);
      let matched = false;
      for (let i = 0; i < 50; i++) {
        const lines = await readFile(path, 'utf8');
        const map = new Map(lines.slice(0, lines.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => { const t = JSON.parse(line); return [t.requestId, t]; }));
        if (records.every(r => map.has(r.requestId))) { for (const r of records) r.trace = map.get(r.requestId); matched = true; break; }
        await delay(100);
      }
      assert.ok(matched, 'Missing HTTP traces');
    }
    assert.equal((await request('/auth/logout', 'POST', undefined, login.cookie)).status, 204);
    await stopServer();
  }
}
try {
  admin = await pool.connect();
  await admin.query("SET statement_timeout='180s'"); await admin.query("SET lock_timeout='3s'");
  locked = (await admin.query("SELECT pg_try_advisory_lock(hashtext('duplication-insert-profiler')) locked")).rows[0].locked;
  assert.ok(locked);
  if (recovery) { assert.equal(ledger.kind, 'representative-insert'); results.recoveredRunId = ledger.runId; prepared = true; }
  else {
    assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 });
    ledger.policies = await policies();
    ledger.schema = await schemaInventory();
    ledger.databaseIdentity = await databaseIdentity();
    assert.ok(ledger.policies.find(p => p.policyname === 'line_items_owner_isolation').qual.includes('EXISTS'));
    if (uuidLocality || uuidHttp) {
      assert.equal(ledger.schema.defaults.find(c => c.table_name === 'line_items' && c.column_name === 'id').column_default, 'gen_random_uuid()');
      assert.equal((await admin.query('SELECT uuid_extract_version(uuidv7())::int version')).rows[0].version, 7);
    }
    ledger.owners = Array.from({ length: 3 }, () => randomUUID());
    await saveLedger(); prepared = true;
    if (serialCosts) {
      results.filesystems = [await serialFilesystem(admin)];
      assert.ok(results.filesystems[0].availableBytes >= 1024 ** 3, 'Need 1 GiB on database filesystem before serial profiling');
    }
    if (uuidHttp) {
      assert.equal((await admin.query("SELECT has_column_privilege('pricing_runtime','line_items','id','INSERT') allowed")).rows[0].allowed, false);
      ledger.uuidHttpDefault = 'gen_random_uuid()'; await saveLedger();
    }
    if (uuidLocality) {
      assert.equal((await admin.query("SELECT has_column_privilege('pricing_runtime','line_items','id','INSERT') allowed")).rows[0].allowed, false);
      // Record recovery intent first. Both controls and candidate share this narrow
      // disposable-only grant; normal app credentials cannot supply a line ID.
      ledger.diagnosticIdGrant = true; await saveLedger();
      await admin.query('GRANT INSERT(id) ON line_items TO pricing_runtime');
      results.diagnosticIdGrant = true;
    }
    const free = await statfs('.'); assert.ok(free.bavail * free.bsize >= 7 * 2 ** 30, 'Need 7 GiB free before starting');
    const password = randomBytes(6).toString('base64url');
    const passwordHash = await argon2.hash(password);
    for (const id of ledger.owners) await admin.query('INSERT INTO users(id,email_display,email_canonical,password_hash) VALUES($1,$2,$2,$3)', [id, `representative-${runId}-${id.slice(0, 8)}@example.test`, passwordHash]);
    const parents = await createRepresentativeParents({ admin, owners: ledger.owners });
    // Establish visible background parents once. Subsequent load updates clear visibility
    // naturally, approximating the populated seed; no per-sample maintenance or reindex.
    await admin.query('VACUUM (ANALYZE) documents');
    const compiled = await build({ stdin: { contents: "import './src/server/index.ts'; process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));", resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: `${output}/server.mjs`, metafile: true });
    results.build = { bundleSha256: hash(await readFile(`${output}/server.mjs`)), inputs: {} };
    for (const path of Object.keys(compiled.metafile.inputs)) if (path !== '<stdin>') results.build.inputs[path] = hash(await readFile(path));
    results.settings = (await admin.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','jit','jit_above_cost','random_page_cost','track_io_timing')")).rows;
    worker = await pool.connect();
    await worker.query('SET track_io_timing=on'); await worker.query("SET statement_timeout='30s'"); await worker.query('SET ROLE pricing_runtime');
    const role = (await worker.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.current_user, 'pricing_runtime'); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    results.runtimeRole = role;
    results.workerSettings = (await worker.query("SELECT name,setting FROM pg_settings WHERE name IN ('track_io_timing','jit','statement_timeout')")).rows;
    results.runtimeRls = (await worker.query("SELECT row_security_active('documents') documents, row_security_active('line_items') lines")).rows[0];
    assert.deepEqual(results.runtimeRls, { documents: true, lines: true });
    if (uuidHttp) {
      const runtimeProbe = new Pool({ connectionString: runtimeUrl, max: 1 });
      try {
        results.httpRuntime = (await runtimeProbe.query(`SELECT current_user,rolsuper,rolbypassrls,
          row_security_active('documents') documents,row_security_active('line_items') lines,
          has_column_privilege(current_user,'line_items','id','INSERT') can_insert_id
          FROM pg_roles WHERE rolname=current_user`)).rows[0];
        assert.deepEqual(results.httpRuntime, { current_user: 'pricing_runtime', rolsuper: false, rolbypassrls: false, documents: true, lines: true, can_insert_id: false });
      } finally { await runtimeProbe.end(); }
    }
    let loaded = 0;
    for (const level of levels) {
      await populateRepresentativeParents({ admin, parents, from: loaded, to: level, onProgress: progress => {
        assert.equal(interrupted, false, 'Interrupted');
        if (progress.completedParents % 1000 === 0 || progress.completedParents === level - loaded) console.log(JSON.stringify({ level, ...progress }));
      }, beforeBatch: serialCosts ? async () => {
        const filesystem = await serialFilesystem(admin); results.filesystems.push(filesystem);
        assert.ok(filesystem.availableBytes >= 600 * 1024 ** 2, 'Database filesystem reserve reached');
      } : undefined });
      loaded = level; ledger.phase = `loaded-${level}`; await saveLedger();
      await admin.query('ANALYZE documents'); await admin.query('ANALYZE line_items');
      const phase = { level, before: await inventory(), counts: await counts() }; results.phases.push(phase);
      const sources = parents.slice(0, 4);
      for (const source of sources) {
        source.before = (await admin.query('SELECT * FROM line_items WHERE document_id=$1 ORDER BY position', [source.id])).rows;
        source.expectedCopy = source.before.map(row => Object.fromEntries(['position', 'description', 'quantity', 'unit_price_cents', 'discount_cents', 'tax_rate_basis_points', 'finalized_subtotal_cents', 'finalized_taxable_cents', 'finalized_tax_cents', 'finalized_total_cents'].map(k => [k, k.startsWith('finalized_') ? null : row[k]])));
      }
      if (serialCosts) {
        await measureSerialCosts({ admin, sources: sources.slice(0, 2), insertSql, samples, level, results,
          checkInterrupted: () => assert.equal(interrupted, false, 'Interrupted') });
        phase.afterSerial = await inventory();
        assert.deepEqual(await counts(), phase.counts);
        assert.deepEqual(await schemaInventory(), ledger.schema);
        assert.deepEqual(await policies(), ledger.policies);
        for (const source of sources) assert.deepEqual((await admin.query('SELECT * FROM line_items WHERE document_id=$1 ORDER BY position', [source.id])).rows, source.before);
        results.checks.push({ level, serialCosts: true, sourcesUnchanged: true, countsUnchanged: true });
        await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
        continue;
      }
      if (uuidHttp) {
        await measureUuidHttp({ admin, parents, level, samples, request, startServer, stopServer, setVariant: setUuidDefault, inventory,
          checkInterrupted: () => assert.equal(interrupted, false, 'Interrupted'), results });
        phase.afterHttp = await inventory();
        assert.deepEqual(await counts(), phase.counts);
        assert.deepEqual(await schemaInventory(), ledger.schema);
        assert.deepEqual(await policies(), ledger.policies);
        for (const source of sources) assert.deepEqual((await admin.query('SELECT * FROM line_items WHERE document_id=$1 ORDER BY position', [source.id])).rows, source.before);
        await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
        continue;
      }
      const retained = [];
      for (let sample = -5; sample < samples; sample++) {
        // Spread paired plans through the experiment; preserve the baseline mode's schedule.
        const probe = uuidLocality ? sample >= 0 && sample % Math.max(1, Math.floor(samples / 5)) === 0 : sample >= 0 && sample < 5;
        const modes = probe ? ['plain', 'plan-off', 'plan-on'] : ['plain'];
        const ordered = sample % 2 ? [...modes].reverse() : modes;
        const cases = uuidLocality && sample % 2 ? [...sources].reverse() : sources;
        for (const mode of ordered) for (const source of cases) {
          const schedules = [
            ['v4', 'v4-explicit', 'v7'], ['v7', 'v4-explicit', 'v4'],
            ['v4-explicit', 'v7', 'v4'], ['v4', 'v7', 'v4-explicit'],
            ['v7', 'v4', 'v4-explicit'], ['v4-explicit', 'v4', 'v7'],
          ];
          const variants = uuidLocality ? schedules[((sample % 6) + 6) % 6] : ['v4'];
          for (const variant of variants) {
            const id = await measure(source, level, mode, sample, variant);
            if (uuidLocality) retained.push(id);
          }
        }
      }
      phase.afterSql = await inventory();
      // Retain measured copies until the end so UUIDv7 is tested on growing live keys,
      // not an immediately deleted/reused key range. Cleanup is outside every timer.
      if (uuidLocality) {
        phase.retainedCopies = retained.length;
        phase.countsWithCopies = await counts();
        await admin.query('DELETE FROM documents WHERE id=ANY($1::uuid[])', [retained]);
        const currentSchema = await schemaInventory();
        for (const key of ['defaults', 'indexes', 'constraints']) assert.deepEqual(currentSchema[key], ledger.schema[key]);
      } else await httpPhase(sources, level, `representative-${runId}-${ledger.owners[0].slice(0, 8)}@example.test`, password);
      phase.afterHttp = await inventory();
      for (const source of sources) assert.deepEqual((await admin.query('SELECT * FROM line_items WHERE document_id=$1 ORDER BY position', [source.id])).rows, source.before);
      assert.deepEqual(await counts(), phase.counts);
      assert.deepEqual(await policies(), ledger.policies);
      results.checks.push({ level, copiedRowsCorrect: true, sourceLinesUnchanged: true, countsUnchanged: true, policiesUnchanged: true });
      await admin.query('BEGIN READ ONLY');
      try {
        await admin.query('SET LOCAL track_io_timing=on');
        results.indexProbes.push({ level, records: await measurePrimaryKeyProbes(admin) });
      } finally { await admin.query('ROLLBACK'); }
      await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ completedLevel: level, sqlRecords: results.records.length, httpRecords: results.http.length }));
    }
  }
} catch (error) { results.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  try { await stopServer(); } catch (error) { results.serverCleanupError = error.message; process.exitCode = 1; }
  if (worker) { try { await worker.query('ROLLBACK'); } catch { /* Destroy connection; admin cleanup remains independent. */ } worker.release(true); }
  if (prepared && locked) try { await cleanup(); } catch (error) { results.cleanupError = error.message; process.exitCode = 1; }
  if (admin) admin.release(true);
  await pool.end();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ output, error: results.error, cleanupError: results.cleanupError, policyUnchanged: results.policyUnchanged, remaining: results.remaining }));
