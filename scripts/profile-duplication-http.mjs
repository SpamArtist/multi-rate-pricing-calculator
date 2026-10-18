// Controlled HTTP experiment; never applies migrations. Requires an empty disposable DB.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Pool } from 'pg';
import { verifyHttpCopy, verifyHttpIsolation } from './profile-duplication-http-checks.mjs';
import { summarizeHttpProfile } from './profile-duplication-http-report.mjs';

const exec = promisify(execFile);
function localUrl(value) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5433', 'Only disposable PostgreSQL on port 5433 is supported');
  assert.equal(url.pathname, '/pricing');
  return url.toString();
}
const adminUrl = localUrl(process.env.HTTP_PROFILE_DATABASE_URL ?? 'postgres://pricing_bootstrap:pricing_bootstrap@127.0.0.1:5433/pricing');
const runtimeUrl = localUrl(process.env.HTTP_PROFILE_RUNTIME_URL ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5433/pricing');
const migratorUrl = localUrl(process.env.HTTP_PROFILE_MIGRATOR_URL ?? 'postgres://pricing_migrator:pricing_migrator@127.0.0.1:5433/pricing');
const samples = Number(process.env.HTTP_PROFILE_SAMPLES ?? 40);
const tracedSamples = Number(process.env.HTTP_PROFILE_TRACED_SAMPLES ?? 10);
assert.ok([samples, tracedSamples].every(n => Number.isInteger(n) && n >= 1 && n <= 100));
const parentCounts = (process.env.HTTP_PROFILE_PARENTS ?? '100,33086').split(',').map(Number);
assert.ok(parentCounts.length <= 4 && parentCounts.every(n => Number.isInteger(n) && n >= 8 && n <= 100000));
assert.equal(new Set(parentCounts).size, parentCounts.length, 'Parent counts must be unique');
const warmups = 5;
const base = 'http://127.0.0.1:4194';
const runId = randomUUID();
const recovery = process.argv[2] === '--cleanup' ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || process.argv.length === 4 && recovery);
const output = resolve(`.artifacts/http-policy-${runId}`);
await mkdir(output, { recursive: true });
const ledgerPath = recovery ?? `${output}/cleanup-ledger.json`;
const ledger = recovery ? JSON.parse(await readFile(recovery, 'utf8')) : { kind: 'http-policy', runId, emails: [], phase: 'starting' };
const scalarUsing = `(SELECT parent.owner_id FROM public.documents AS parent
 WHERE parent.id = line_items.document_id) = nullif(current_setting('app.user_id', true), '')::uuid`;
const suiteEmails = ['document-duplication@example.com', 'document-duplication-owner@example.com', 'document-duplication-other@example.com'];
const pool = new Pool({ connectionString: adminUrl, max: 1 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
const env = { ...process.env, DATABASE_URL: runtimeUrl, MIGRATOR_DATABASE_URL: migratorUrl,
  BOOTSTRAP_DATABASE_URL: adminUrl, API_PORT: '4194', PRICING_DUPLICATION_TRACE: '0' };
const results = { runId, samples, tracedSamples, warmups, parentCounts, scalarUsing,
  methodology: 'paired HTTP through parsed JSON; committed fixtures; vacuum before each copy; trace-off primary',
  records: [], checks: [], workloads: [], suites: [] };
let admin;
let child;
let childExit;
let prepared = false;
let ownsLock = false;
let interrupted = false;
process.on('SIGTERM', () => { interrupted = true; });
process.on('SIGINT', () => { interrupted = true; });
const round = n => +n.toFixed(3);
const hash = value => createHash('sha256').update(value).digest('hex');
async function saveLedger() {
  await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
  await rename(`${ledgerPath}.tmp`, ledgerPath);
}
async function policy() {
  return (await admin.query(`SELECT policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename='line_items' AND policyname='line_items_owner_isolation'`)).rows[0];
}
async function setPolicy(variant) {
  await admin.query(`ALTER POLICY line_items_owner_isolation ON public.line_items USING (${variant === 'scalar' ? scalarUsing : ledger.originalPolicy.qual})`);
  const actual = await policy();
  assert.deepEqual({ ...actual, qual: ledger.originalPolicy.qual }, ledger.originalPolicy);
  return actual;
}
async function counts() {
  return (await admin.query(`SELECT (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM documents)::int AS documents,(SELECT count(*) FROM line_items)::int AS lines`)).rows[0];
}
async function sizes() {
  return (await admin.query(`SELECT relname,reltuples,relpages,pg_relation_size(oid)::text AS heap_bytes,
    pg_indexes_size(oid)::text AS index_bytes FROM pg_class
    WHERE oid IN ('documents'::regclass,'line_items'::regclass) ORDER BY relname`)).rows;
}
async function vacuum() {
  await admin.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) public.line_items');
  await admin.query('VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON) public.documents');
}
async function cleanOwners() {
  assert.equal(ledger.kind, 'http-policy');
  assert.match(ledger.runId, /^[0-9a-f-]{36}$/);
  assert.ok(ledger.emails.every(email => email.startsWith(`http-policy-${ledger.runId}-`) && email.endsWith('@example.test')));
  assert.ok((ledger.suiteEmails ?? []).every(email => suiteEmails.includes(email)));
  await admin.query('DELETE FROM users WHERE email_canonical=ANY($1::text[])', [[...ledger.emails, ...(ledger.suiteEmails ?? [])]]);
  ledger.emails = [];
  ledger.suiteEmails = [];
  await saveLedger();
}
async function request(path, method = 'GET', body, cookie) {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30000),
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const headersAt = performance.now();
  const text = await response.text();
  const bodyAt = performance.now();
  const data = text ? JSON.parse(text) : null;
  const parsedAt = performance.now();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0],
    requestId: response.headers.get('x-duplication-request-id'), bytes: Buffer.byteLength(text),
    markers: { headersMs: round(headersAt - start), bodyMs: round(bodyAt - headersAt),
      parseMs: round(parsedAt - bodyAt), totalMs: round(parsedAt - start) } };
}
async function expect(path, method, body, cookie, status) {
  const result = await request(path, method, body, cookie);
  assert.equal(result.status, status, `${method} ${path} status`);
  return result;
}
async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  const timeout = delay(5000, 'timeout', { ref: false });
  if (await Promise.race([childExit, timeout]) === 'timeout') {
    child.kill('SIGKILL');
    await childExit;
  }
  child = undefined;
}
async function runSuite(variant) {
  // IPC disconnect stops the runner if this profiler dies. Vitest workers also
  // receive their parent's disconnect. The ledger covers any committed owners.
  const entry = `${output}/suite.mjs`;
  await writeFile(entry, `process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
await import(${JSON.stringify(new URL('../node_modules/vitest/vitest.mjs', import.meta.url).href)});\n`);
  let log = '';
  child = spawn(process.execPath, [entry, 'run', 'tests/api/document-duplication.test.ts'],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  try {
    const outcome = await Promise.race([childExit, delay(120000, 'timeout', { ref: false })]);
    assert.notEqual(outcome, 'timeout', 'Duplication API suite timed out');
    assert.equal(outcome.code, 0, 'Duplication API suite failed; inspect suite log');
  } finally {
    await stopServer();
    await writeFile(`${output}/suite-${variant}.log`, log, { mode: 0o600 });
  }
}
async function startServer(mode, population) {
  await stopServer();
  // Refuse to accidentally use another process already listening on the fixed benchmark port.
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(4194, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  const tracePath = `${output}/traces-${population}-${mode}.ndjson`;
  let log = '';
  child = spawn(process.execPath, [`${output}/server.mjs`], { env: { ...env,
    PRICING_DUPLICATION_TRACE: mode === 'on' ? '1' : '0', PRICING_DUPLICATION_TRACE_FILE: tracePath,
    PRICING_DUPLICATION_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-64000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-64000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (log.includes('API listening')) {
      assert.equal((await request('/health')).status, 200);
      return tracePath;
    }
    assert.equal(child.exitCode, null, 'Server exited before startup');
    await delay(100);
  }
  throw new Error('Server startup timed out');
}
const lineInput = index => ({ description: `Synthetic item ${index + 1}`, quantity: index % 3 + 1,
  unitPriceCents: 1999 + index, discountCents: index % 2 ? 100 : 0, taxRateBasisPoints: [0, 725, 1900][index % 3] });
async function fixture(parentCount) {
  assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 });
  await vacuum();
  assert.ok((await sizes()).every(table => table.heap_bytes === '0'));
  const people = [];
  for (const label of ['owner', 'foreign']) {
    const email = `http-policy-${runId}-${parentCount}-${label}@example.test`;
    ledger.emails.push(email); // Save before signup can COMMIT, including a lost HTTP response.
    ledger.phase = 'fixture-pending';
    await saveLedger();
    const signup = await expect('/auth/sign-up', 'POST', { email, password: randomBytes(6).toString('base64url') }, undefined, 201);
    assert.ok(signup.cookie);
    people.push({ id: signup.data.user.id, cookie: signup.cookie });
  }
  const [owner, foreign] = people;
  const cases = [];
  for (const state of ['draft', 'finalized']) for (const count of [2, 40, 337, 411]) {
    let source = (await expect('/documents/draft-save', 'POST', {
      mutationId: randomUUID(), title: `Synthetic ${state} ${count}`, customerName: 'Synthetic customer',
      issueDate: '2026-10-18', lineItems: Array.from({ length: count }, (_, i) => lineInput(i)),
    }, owner.cookie, 201)).data;
    if (state === 'finalized') source = (await expect(`/documents/${source.id}/finalize`, 'POST', {}, owner.cookie, 200)).data;
    cases.push({ key: `${parentCount}-${state}-${count}`, state, count, source });
  }
  const foreignSource = (await expect('/documents/draft-save', 'POST', {
    mutationId: randomUUID(), title: 'Foreign source', customerName: 'Synthetic customer',
    issueDate: '2026-10-18', lineItems: [lineInput(0)],
  }, foreign.cookie, 201)).data;
  for (const [person, additional] of [[owner, parentCount - cases.length], [foreign, parentCount * 2 - 1]]) {
    await admin.query(`INSERT INTO documents (owner_id,title,customer_name,issue_date)
      SELECT $1,'Synthetic parent','Synthetic customer','2026-10-18' FROM generate_series(1,$2)`, [person.id, additional]);
  }
  await admin.query('REINDEX TABLE public.line_items');
  await admin.query('REINDEX TABLE public.documents');
  await vacuum();
  ledger.phase = 'fixture-committed';
  await saveLedger();
  return { cases, owner, foreign, foreignSource };
}
async function snapshot(id) {
  return { document: (await admin.query('SELECT * FROM documents WHERE id=$1', [id])).rows,
    lines: (await admin.query('SELECT * FROM line_items WHERE document_id=$1 ORDER BY position,id', [id])).rows };
}
async function measure(testCase, person, variant, mode, sampleRound) {
  assert.equal(interrupted, false, 'Interrupted');
  await vacuum();
  const before = await sizes();
  const result = await expect(`/documents/${testCase.source.id}/duplicate`, 'POST', { issueDate: '2026-10-19' }, person.cookie, 201);
  verifyHttpCopy(result.data, testCase.source);
  assert.equal(Boolean(result.requestId), mode === 'on');
  const stored = await snapshot(result.data.id);
  assert.equal(stored.document.length, 1);
  assert.equal(stored.lines.length, testCase.count);
  for (const row of [...stored.document, ...stored.lines]) {
    for (const [key, value] of Object.entries(row)) if (key.startsWith('finalized_')) assert.equal(value, null);
  }
  for (const [key, value] of Object.entries(result.data.amounts)) {
    const column = 'draft_' + key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
    assert.equal(String(stored.document[0][column]), String(value));
  }
  await expect(`/documents/${result.data.id}`, 'DELETE', undefined, person.cookie, 204);
  await expect(`/documents/${result.data.id}`, 'GET', undefined, person.cookie, 404);
  if (sampleRound >= 0) results.records.push({ case: testCase.key, variant, mode, round: sampleRound,
    requestId: result.requestId, bytes: result.bytes, ...result.markers, before });
}
async function collectTraces(path, records) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let lines = '';
    try { lines = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A concurrent append may expose a partial final line; parse only complete records.
    const parsed = lines.slice(0, lines.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const map = new Map(parsed.map(trace => [trace.requestId, trace]));
    if (records.every(record => map.has(record.requestId))) {
      for (const record of records) {
        record.trace = map.get(record.requestId);
        assert.equal(record.trace.status, 201);
        assert.equal(record.trace.outcome, 'finish');
        assert.equal(record.trace.responseBytes, record.bytes);
        assert.equal(record.trace.copiedRows, Number(record.case.split('-').at(-1)));
      }
      return;
    }
    await delay(100);
  }
  throw new Error('Incomplete trace coverage (check recorder caps)');
}

try {
  admin = await pool.connect();
  await admin.query("SET statement_timeout='30s'");
  await admin.query("SET lock_timeout='2s'");
  ownsLock = (await admin.query("SELECT pg_try_advisory_lock(hashtext('duplication-insert-profiler')) AS locked")).rows[0].locked;
  assert.ok(ownsLock, 'Another profiler is active');
  if (recovery) {
    assert.equal(ledger.kind, 'http-policy');
    assert.ok(ledger.originalPolicy?.qual.includes('EXISTS'));
    prepared = true;
  } else {
    assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 }, 'Requires empty disposable DB; recover any interrupted run first');
    ledger.originalPolicy = await policy();
    assert.ok(ledger.originalPolicy?.qual.includes('EXISTS'));
    await saveLedger();
    prepared = true;
    const role = (await runtime.query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.equal(role.current_user, 'pricing_runtime');
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    const rls = (await runtime.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('documents'::regclass,'line_items'::regclass)`)).rows;
    assert.equal(rls.length, 2);
    assert.ok(rls.every(row => row.relrowsecurity && row.relforcerowsecurity));
    results.database = { role, rls, version: (await admin.query('SELECT version()')).rows[0].version,
      policies: (await admin.query("SELECT * FROM pg_policies WHERE schemaname='public'")).rows,
      indexes: (await admin.query("SELECT * FROM pg_indexes WHERE schemaname='public' AND tablename IN ('documents','line_items')")).rows };
    const compiled = await build({ stdin: { contents: "import './src/server/index.ts'; process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));", resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: `${output}/server.mjs`, metafile: true });
    results.build = { node: process.version, head: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      bundleSha256: hash(await readFile(`${output}/server.mjs`)), inputs: {} };
    for (const path of Object.keys(compiled.metafile.inputs)) if (path !== '<stdin>') results.build.inputs[path] = hash(await readFile(path));
    for (const variant of ['baseline', 'scalar']) {
      await setPolicy(variant);
      ledger.suiteEmails = suiteEmails;
      await saveLedger();
      await runSuite(variant);
      results.suites.push({ variant, passed: true });
      assert.deepEqual(await counts(), { users: 0, documents: 0, lines: 0 });
      ledger.suiteEmails = [];
      await saveLedger();
    }
    await setPolicy('baseline');
    for (const parentCount of parentCounts) {
      await startServer('off', parentCount);
      const { cases, owner, foreign, foreignSource } = await fixture(parentCount);
      const snapshots = new Map();
      for (const testCase of cases) snapshots.set(testCase.source.id, await snapshot(testCase.source.id));
      results.workloads.push({ parentCount, sizes: await sizes(), counts: await counts(), cases: cases.map(({ key, state, count }) => ({ key, state, count })) });
      for (const variant of ['baseline', 'scalar']) {
        await setPolicy(variant);
        const checks = await verifyHttpIsolation({ request, ownerCookie: owner.cookie, foreignCookie: foreign.cookie,
          source: cases[0].source, foreignSource, admin });
        results.checks.push({ parentCount, variant, checks });
      }
      for (const mode of ['off', 'on']) {
        const tracePath = mode === 'on' ? await startServer(mode, parentCount) : undefined;
        for (let sampleRound = -warmups; sampleRound < (mode === 'on' ? tracedSamples : samples); sampleRound++) {
          const order = Math.abs(sampleRound) % 2 ? ['scalar', 'baseline'] : ['baseline', 'scalar'];
          for (const variant of order) {
            await setPolicy(variant); // Committed DDL outside all HTTP timings.
            const offset = (sampleRound + warmups) % cases.length;
            for (const testCase of [...cases.slice(offset), ...cases.slice(0, offset)]) await measure(testCase, owner, variant, mode, sampleRound);
          }
          if (sampleRound >= 0 && sampleRound % 10 === 0) console.log(JSON.stringify({ parentCount, mode, round: sampleRound }));
        }
        if (mode === 'on') await collectTraces(tracePath, results.records.filter(record => record.mode === mode && record.case.startsWith(`${parentCount}-`)));
      }
      for (const testCase of cases) {
        assert.deepEqual(await snapshot(testCase.source.id), snapshots.get(testCase.source.id), 'Source DB contents changed');
        assert.deepEqual((await expect(`/documents/${testCase.source.id}`, 'GET', undefined, owner.cookie, 200)).data, testCase.source);
      }
      await stopServer();
      await setPolicy('baseline');
      await cleanOwners();
    }
  }
} catch (error) {
  results.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  try { await stopServer(); } catch (error) { results.serverCleanupError = error.message; process.exitCode = 1; }
  if (prepared && ownsLock) {
    try {
      await setPolicy('baseline');
      assert.deepEqual(await policy(), ledger.originalPolicy);
      results.policyRestored = true;
    } catch (error) { results.policyCleanupError = error.message; process.exitCode = 1; }
    try {
      await cleanOwners();
      results.remaining = await counts();
      assert.deepEqual(results.remaining, { users: 0, documents: 0, lines: 0 });
      if (results.policyRestored) { ledger.phase = 'clean'; await saveLedger(); }
    } catch (error) { results.fixtureCleanupError = error.message; process.exitCode = 1; }
  }
  if (admin) admin.release(true);
  await Promise.all([pool.end(), runtime.end()]);
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
}
if (!recovery && !results.error && !process.exitCode) {
  const report = summarizeHttpProfile(results);
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ output, measured: results.records.length, policyRestored: results.policyRestored,
  remaining: results.remaining, error: results.error, cleanupErrors: [results.serverCleanupError, results.policyCleanupError, results.fixtureCleanupError].filter(Boolean) }));
