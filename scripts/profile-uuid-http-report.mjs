// Summarize paired endpoint batches; generated evidence stays beside the input.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

const input = process.argv[2];
const recoveryPath = process.argv[3];
assert.ok(input && [3, 4].includes(process.argv.length),
  'Usage: node scripts/profile-uuid-http-report.mjs results.json [recovery-results.json]');
const result = JSON.parse(await readFile(input, 'utf8'));
assert.equal(result.experiment, 'uuid-http');
assert.ok(!result.error && !result.serverCleanupError, 'Measurement or server cleanup failed');
let recovery;
let cleanup = result;
if (result.cleanupError) {
  assert.ok(recoveryPath, 'Failed cleanup requires matching verified recovery results');
  cleanup = JSON.parse(await readFile(recoveryPath, 'utf8'));
  assert.ok(typeof result.runId === 'string' && result.runId.length);
  assert.equal(cleanup.recoveredRunId, result.runId, 'Recovery belongs to a different run');
  recovery = { originalCleanupError: result.cleanupError, recoveryPath, recoveredRunId: cleanup.recoveredRunId };
} else assert.ok(!recoveryPath, 'Recovery results supplied for a run without a cleanup error');
assert.ok(!cleanup.error && !cleanup.cleanupError && !cleanup.serverCleanupError
  && cleanup.policyUnchanged === true && cleanup.schemaUnchanged === true,
  'Cleanup did not complete with verified schema and policy restoration');
assert.deepEqual(cleanup.remaining, { users: 0, documents: 0, lines: 0 });
assert.ok(Array.isArray(result.uuidHttp) && result.uuidHttp.length, 'No measured HTTP batches');
const round = value => +value.toFixed(3);
const sum = values => values.reduce((total, value) => total + value, 0);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = values => values.length ? {
  n: values.length, median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)),
} : null;
function time(value, label, positive = false) {
  assert.ok(Number.isFinite(value) && (positive ? value > 0 : value >= 0), `Invalid ${label}`);
}
const essentialSpans = ['copy.lines_insert', 'source.lock_read', 'request.total', 'projection.lines_read'];
const optionalSpans = ['auth.session', 'transaction.entry'];
const groups = new Map();
const traceIds = new Set();
for (const batch of result.uuidHttp) {
  assert.ok(Number.isInteger(batch.level) && batch.level > 0);
  assert.ok(['off', 'on'].includes(batch.mode) && ['v4', 'v7'].includes(batch.variant));
  assert.ok(typeof batch.workload === 'string' && batch.workload.length);
  assert.ok(Number.isInteger(batch.round) && batch.round >= 0, 'Warmups must be excluded');
  assert.ok(Number.isInteger(batch.concurrency) && batch.concurrency > 0);
  assert.ok(Array.isArray(batch.requests) && batch.requests.length === batch.concurrency);
  time(batch.batchMs, 'batchMs', true);
  for (const request of batch.requests) {
    assert.ok(typeof request.case === 'string' && request.case.length);
    time(request.totalMs, 'request totalMs');
    if (batch.mode === 'on') {
      assert.ok(typeof request.requestId === 'string' && request.requestId.length);
      assert.ok(!traceIds.has(request.requestId), 'Duplicate trace correlation ID');
      traceIds.add(request.requestId);
      assert.equal(request.trace?.requestId, request.requestId, 'Missing or mismatched trace');
      assert.ok(Array.isArray(request.trace.spans));
      for (const name of [...essentialSpans, ...optionalSpans]) {
        const matches = request.trace.spans.filter(span => span.name === name);
        assert.ok(matches.length === 1 || optionalSpans.includes(name) && matches.length === 0,
          `Missing or duplicate span: ${name}`);
        if (matches.length) {
          time(matches[0].durationMs, `${name} durationMs`);
          assert.equal(matches[0].outcome, 'ok', `Failed span: ${name}`);
        }
      }
    }
  }
  const key = JSON.stringify([batch.level, batch.mode, batch.workload]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(batch);
}

function armSummary(batches, mode) {
  const requests = batches.flatMap(batch => batch.requests);
  const half = Math.floor(batches.length / 2);
  const halfSummary = subset => subset.length ? {
    batchMs: summary(subset.map(batch => batch.batchMs)),
    requestMs: summary(subset.flatMap(batch => batch.requests.map(request => request.totalMs))),
  } : null;
  const arm = {
    batches: batches.length, requests: requests.length,
    requestMs: summary(requests.map(request => request.totalMs)),
    batchMs: summary(batches.map(batch => batch.batchMs)),
    aggregateRequestsPerSecond: round(requests.length * 1000 / sum(batches.map(batch => batch.batchMs))),
    firstHalf: halfSummary(batches.slice(0, half)), lastHalf: halfSummary(batches.slice(half)),
    cases: [...new Set(requests.map(request => request.case))].sort().map(name => ({
      case: name, requestMs: summary(requests.filter(request => request.case === name).map(request => request.totalMs)),
    })),
  };
  if (mode === 'on') arm.spans = Object.fromEntries([...essentialSpans, ...optionalSpans].map(name => [name,
    summary(requests.flatMap(request => request.trace.spans.filter(span => span.name === name).map(span => span.durationMs))),
  ]));
  return arm;
}
const pairedSummary = pairs => pairs.length ? {
  n: pairs.length, savedMs: summary(pairs.map(pair => pair.savedMs)),
  savedPercent: summary(pairs.map(pair => pair.savedPercent)),
  positivePairs: pairs.filter(pair => pair.savedMs > 0).length,
} : null;
const rows = [];
for (const batches of groups.values()) {
  const { level, mode, workload, concurrency } = batches[0];
  assert.ok(batches.every(batch => batch.concurrency === concurrency), 'Concurrency changed within workload');
  const arms = Object.fromEntries(['v4', 'v7'].map(variant => [variant,
    batches.filter(batch => batch.variant === variant).sort((a, b) => a.round - b.round),
  ]));
  assert.ok(arms.v4.length && arms.v7.length, 'Missing paired arm');
  for (const arm of Object.values(arms)) assert.equal(new Set(arm.map(batch => batch.round)).size, arm.length, 'Duplicate round');
  assert.deepEqual(arms.v4.map(batch => batch.round), arms.v7.map(batch => batch.round), 'Unmatched rounds');
  const pairs = arms.v4.map((before, index) => {
    const after = arms.v7[index];
    assert.deepEqual(before.requests.map(request => request.case).sort(), after.requests.map(request => request.case).sort(),
      'Paired request counts or case schedule differ');
    const savedMs = before.batchMs - after.batchMs;
    return { round: before.round, savedMs, savedPercent: savedMs * 100 / before.batchMs };
  });
  const half = Math.floor(pairs.length / 2);
  rows.push({ level, mode, workload, concurrency,
    variants: Object.fromEntries(Object.entries(arms).map(([variant, arm]) => [variant, armSummary(arm, mode)])),
    paired: pairedSummary(pairs), firstHalfPaired: pairedSummary(pairs.slice(0, half)),
    lastHalfPaired: pairedSummary(pairs.slice(half)),
    v4FirstPaired: pairedSummary(pairs.filter(pair => pair.round % 2 === 0)),
    v7FirstPaired: pairedSummary(pairs.filter(pair => pair.round % 2 === 1)),
  });
}
const output = join(dirname(input), 'uuid-http-summary.json');
assert.notEqual(output, input);
await writeFile(output, JSON.stringify({ rows, ...(recovery ? { recovery } : {}), notes: [
  ...(recovery ? ['Original cleanup failed; separately verified matching recovery restored schema, policies and zero fixture rows. Raw results remain unchanged.',
    'Any disk-pressure effects associated with the cleanup failure limit performance conclusions; recovery does not establish uncontaminated timings.'] : []),
  'Medians use the midpoint of the two central observations for even sample counts. Empty half/order subsets are null.',
  'Request timings are pooled within each workload; requests in the same batch are correlated, not independent trials.',
  'Paired savings are UUIDv4 minus UUIDv7 batch time; percentages use each paired UUIDv4 batch as denominator.',
  'Arm order follows the runner contract: even measured rounds run UUIDv4 first, odd rounds UUIDv7 first.',
  'Aggregate throughput is total requests divided by summed batch durations. Bounded burst throughput is not sustained server capacity.',
  'Tracing on and off are separate passes. Their difference does not isolate causal instrumentation overhead; trace spans can overlap.',
  'Same-source concurrent copies serialize on source document locks; lock waits can dominate and confound index-locality comparisons.',
  'No p95, confidence interval, full-scale equivalence, or deployment claim is made.',
] }, null, 2), { mode: 0o600 });
console.log(output);
