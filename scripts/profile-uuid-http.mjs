// HTTP-only diagnostic. The caller owns the disposable fixture and default recovery.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyHttpCopy, verifyHttpIsolation } from './profile-duplication-http-checks.mjs';

const round = n => +n.toFixed(3);
const body = { issueDate: '2026-10-19' };

export async function measureUuidHttp({ admin, parents, level, samples, request, startServer, stopServer, setVariant, inventory, checkInterrupted, results }) {
  const owner = parents[0].owner;
  const cookies = [];
  // Valid fixture sessions avoid the sign-in rate limit while exercising the real
  // cookie authentication/refresh path. Tokens never enter result artifacts.
  async function session(user) {
    const token = randomBytes(32).toString('base64url');
    await admin.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [user, createHash('sha256').update(token).digest('hex')]);
    return `__Host-session=${token}`;
  }
  for (let lane = 0; lane < 8; lane++) cookies.push(await session(owner));
  const foreignParent = parents.find(p => p.owner !== owner);
  const foreignCookie = await session(foreignParent.owner);
  async function expect(path, method, payload, cookie, status) {
    const response = await request(path, method, payload, cookie);
    assert.equal(response.status, status, `${method} ${path}`);
    return response.data;
  }
  await setVariant('v4');
  await startServer('off', level);
  for (const cookie of cookies) assert.equal((await expect('/auth/session', 'GET', undefined, cookie, 200)).user.id, owner);
  const original = [];
  for (const parent of parents.slice(0, 2)) original.push(await expect(`/documents/${parent.id}`, 'GET', undefined, cookies[0], 200));
  const foreignSource = await expect(`/documents/${foreignParent.id}`, 'GET', undefined, foreignCookie, 200);
  const sourceCopies = [];
  const retained = [];
  const allLineIds = new Set();
  const allDocumentIds = new Set();
  function checkCopy(copy, source, variant) {
    verifyHttpCopy(copy, source);
    assert.equal(copy.id[14], '4', 'Only line IDs should change version');
    assert.ok(!allDocumentIds.has(copy.id)); allDocumentIds.add(copy.id);
    for (const line of copy.lineItems) {
      assert.equal(line.id[14], variant === 'v7' ? '7' : '4');
      assert.ok(!allLineIds.has(line.id), 'ID reused across concurrent or prior copies');
      allLineIds.add(line.id);
    }
  }
  // Eight identical-size sources avoid source-row serialization in the main
  // concurrency cells. Existing originals still cover draft/finalized copying.
  for (let lane = 0; lane < 8; lane++) {
    const copy = await expect(`/documents/${original[0].id}/duplicate`, 'POST', body, cookies[lane], 201);
    checkCopy(copy, original[0], 'v4'); sourceCopies.push(copy);
  }
  assert.equal(new Set(sourceCopies.map(s => s.id)).size, 8);
  const sources = [...original, ...sourceCopies];
  const sourceIds = sources.map(s => s.id);
  const snapshot = async () => ({
    documents: (await admin.query('SELECT * FROM documents WHERE id=ANY($1::uuid[]) ORDER BY id', [sourceIds])).rows,
    lines: (await admin.query('SELECT * FROM line_items WHERE document_id=ANY($1::uuid[]) ORDER BY document_id,position', [sourceIds])).rows,
  });
  const before = await snapshot();
  for (const variant of ['v4', 'v7']) {
    await setVariant(variant);
    results.checks.push({ level, variant, checks: await verifyHttpIsolation({ request, ownerCookie: cookies[0], foreignCookie, source: original[0], foreignSource, admin }) });
  }
  const workloads = [
    { name: 'serial-draft-337', sources: [original[0]] },
    { name: 'serial-finalized-411', sources: [original[1]] },
    ...[2, 4, 8].map(concurrency => ({ name: `distinct-source-${concurrency}`, sources: sourceCopies.slice(0, concurrency) })),
    { name: 'same-source-8', sources: Array(8).fill(original[0]) },
  ];
  results.uuidHttpWorkloads ??= [];
  results.uuidHttpWorkloads.push({ level, sessions: 'independent per lane', sources: workloads.map(w => ({ workload: w.name, concurrency: w.sources.length, distinctSources: new Set(w.sources.map(s => s.id)).size, lineCounts: w.sources.map(s => s.lineItems.length) })) });
  async function burst(workload, variant, mode, sample, monitor = false) {
    checkInterrupted();
    const observations = [];
    let active = true;
    // Separate diagnostic bursts only: never sample activity during primary timings.
    const sampling = monitor ? (async () => {
      while (active) {
        observations.push((await admin.query(`SELECT pid,state,wait_event_type,wait_event,
          query ~* 'INSERT[[:space:]]+INTO[[:space:]]+line_items' AS inserting
          FROM pg_stat_activity WHERE datname=current_database() AND usename='pricing_runtime' AND state='active'`)).rows);
        await delay(3);
      }
    })() : Promise.resolve();
    const start = performance.now();
    let settled;
    try {
      settled = await Promise.allSettled(workload.sources.map((source, lane) => request(`/documents/${source.id}/duplicate`, 'POST', body, cookies[lane])));
    } finally { active = false; }
    const batchMs = round(performance.now() - start);
    await sampling;
    const responses = settled.map(outcome => {
      assert.equal(outcome.status, 'fulfilled', 'HTTP burst request rejected');
      assert.equal(outcome.value.status, 201, 'HTTP duplication failed');
      return outcome.value;
    });
    for (const [lane, response] of responses.entries()) {
      checkCopy(response.data, workload.sources[lane], variant);
      retained.push(response.data.id);
      assert.deepEqual(await expect(`/documents/${response.data.id}`, 'GET', undefined, cookies[lane], 200), response.data);
    }
    const copies = (await admin.query(`SELECT d.id,d.owner_id,d.status,d.finalized_at,
      d.finalized_subtotal_cents,d.finalized_discount_cents,d.finalized_taxable_cents,d.finalized_tax_cents,d.finalized_total_cents,
      count(l.id)::int lines,bool_and(uuid_extract_version(l.id)=$2::int) correct_version,
      bool_and(l.finalized_subtotal_cents IS NULL AND l.finalized_taxable_cents IS NULL AND l.finalized_tax_cents IS NULL AND l.finalized_total_cents IS NULL) no_snapshots
      FROM documents d JOIN line_items l ON l.document_id=d.id WHERE d.id=ANY($1::uuid[]) GROUP BY d.id`, [responses.map(r => r.data.id), variant === 'v7' ? 7 : 4])).rows;
    assert.equal(copies.length, responses.length);
    for (const copy of copies) {
      assert.equal(copy.owner_id, owner); assert.equal(copy.status, 'draft');
      assert.ok(copy.correct_version && copy.no_snapshots);
      assert.equal(copy.lines, responses.find(r => r.data.id === copy.id).data.lineItems.length);
      for (const [key, value] of Object.entries(copy)) if (key.startsWith('finalized_')) assert.equal(value, null);
    }
    // Verify foreign privacy on a newly returned copy for each burst.
    await expect(`/documents/${responses[0].data.id}`, 'GET', undefined, foreignCookie, 404);
    const record = { level, mode, workload: workload.name, concurrency: responses.length, variant, round: sample, batchMs,
      requests: responses.map((response, lane) => ({ case: `${workload.sources[lane].status}-${workload.sources[lane].lineItems.length}`, totalMs: response.totalMs, requestId: response.requestId })) };
    if (sample >= 0 && !monitor) results.uuidHttp.push(record);
    if (monitor) {
      results.uuidHttpOverlap ??= [];
      results.uuidHttpOverlap.push({ level, variant, observations, maxActiveInserts: Math.max(0, ...observations.map(rows => rows.filter(r => r.inserting).length)) });
    }
  }
  for (const mode of ['off', 'on']) {
    results.uuidHttpPhases ??= [];
    const phase = { level, mode, before: await inventory() }; results.uuidHttpPhases.push(phase);
    const tracePath = mode === 'off' ? undefined : await startServer(mode, level);
    for (let sample = -3; sample < (mode === 'off' ? samples : 6); sample++) {
      const order = sample % 2 ? ['v7', 'v4'] : ['v4', 'v7'];
      const offset = ((sample + 3) % workloads.length + workloads.length) % workloads.length;
      const rotated = [...workloads.slice(offset), ...workloads.slice(0, offset)];
      for (const variant of order) {
        await setVariant(variant); // DDL completes before any request timer starts.
        for (const workload of rotated) await burst(workload, variant, mode, sample);
      }
      if (sample >= 0 && sample % 6 === 0) console.log(JSON.stringify({ level, phase: 'uuid-http', mode, round: sample }));
    }
    if (mode === 'on') {
      const requests = results.uuidHttp.filter(r => r.level === level && r.mode === 'on').flatMap(r => r.requests);
      let matched = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const text = await readFile(tracePath, 'utf8');
        const map = new Map(text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => { const trace = JSON.parse(line); return [trace.requestId, trace]; }));
        if (requests.every(r => map.has(r.requestId))) {
          for (const r of requests) {
            r.trace = map.get(r.requestId);
            assert.equal(r.trace.status, 201); assert.equal(r.trace.outcome, 'finish');
            assert.equal(r.trace.copiedRows, Number(r.case.split('-')[1]));
            assert.equal(r.trace.queryCount, 8);
          }
          matched = true; break;
        }
        await delay(100);
      }
      assert.ok(matched, 'Missing HTTP trace records');
      for (const variant of ['v4', 'v7']) { await setVariant(variant); await burst(workloads.find(w => w.name === 'distinct-source-8'), variant, mode, -1, true); }
    }
    phase.after = await inventory();
    phase.retainedCopies = retained.length;
    phase.counts = (await admin.query('SELECT (SELECT count(*) FROM documents)::int documents,(SELECT count(*) FROM line_items)::int lines')).rows[0];
  }
  assert.deepEqual(await snapshot(), before, 'Source documents or lines changed');
  for (const source of sources) assert.deepEqual(await expect(`/documents/${source.id}`, 'GET', undefined, cookies[0], 200), source);
  // Exercise UUIDv7 IDs in editing, reordering and finalizing, outside performance measurements.
  await setVariant('v7');
  const lifecycle = await expect(`/documents/${original[0].id}/duplicate`, 'POST', body, cookies[0], 201);
  checkCopy(lifecycle, original[0], 'v7'); retained.push(lifecycle.id);
  const line = lifecycle.lineItems[0];
  const editedLine = await expect(`/documents/${lifecycle.id}/line-items/${line.id}`, 'PATCH', { description: 'UUIDv7 lifecycle check', position: lifecycle.lineItems.length }, cookies[0], 200);
  assert.equal(editedLine.id, line.id);
  const edited = await expect(`/documents/${lifecycle.id}`, 'GET', undefined, cookies[0], 200);
  assert.equal(edited.lineItems.at(-1).id, line.id);
  assert.equal(edited.lineItems.at(-1).description, 'UUIDv7 lifecycle check');
  const finalized = await expect(`/documents/${lifecycle.id}/finalize`, 'POST', {}, cookies[0], 200);
  assert.equal(finalized.status, 'finalized');
  assert.deepEqual(finalized.amounts, edited.amounts);
  assert.deepEqual(finalized.lineItems.map(l => l.id), edited.lineItems.map(l => l.id));
  // Deletion behavior is checked through HTTP; bulk fixture cleanup is outside timings.
  await expect(`/documents/${lifecycle.id}`, 'DELETE', undefined, cookies[0], 409);
  await expect(`/documents/${retained[0]}`, 'DELETE', undefined, cookies[0], 204);
  await expect(`/documents/${retained[0]}`, 'GET', undefined, cookies[0], 404);
  await stopServer();
  await setVariant('v4');
  await admin.query('DELETE FROM documents WHERE id=ANY($1::uuid[])', [[...retained, ...sourceCopies.map(s => s.id)]]);
  results.checks.push({ level, uuidHttp: true, copiesCorrect: true, globalIdsUnique: true, sourcesUnchanged: true, uuid7EditReorderFinalize: true, retainedCopies: retained.length });
}
