import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
const input = process.argv[2];
assert.ok(input, 'Usage: node scripts/profile-representative-report.mjs results.json');
const results = JSON.parse(await readFile(input, 'utf8'));
assert.notEqual(results.experiment, 'uuid-locality', 'Use profile-uuid-locality-report.mjs for paired UUID runs');
assert.notEqual(results.experiment, 'uuid-http', 'Use profile-uuid-http-report.mjs for paired UUID HTTP runs');
assert.notEqual(results.experiment, 'serial-costs', 'Use profile-serial-costs-report.mjs for serial decomposition');
assert.ok(!results.error && results.policyUnchanged && !results.cleanupError, 'Run did not complete cleanly');
const med = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summaryOf = values => ({ n: values.length, median: +med(values).toFixed(3), min: Math.min(...values), max: Math.max(...values) });
const nodes = root => [root, ...(root.Plans ?? []).flatMap(nodes)];
const sourceParents = plan => nodes(plan.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')).filter(n => n['Relation Name'] === 'documents');
const sql = [];
for (const level of results.levels) for (const key of new Set(results.records.map(r => r.case))) {
  const records = results.records.filter(r => r.level === level && r.case === key);
  const plain = records.filter(r => r.mode === 'plain');
  const plans = records.filter(r => r.mode === 'plan-on');
  const item = { level, case: key, plainMs: summaryOf(plain.map(r => r.markers['lines.insert'])),
    plainFirstHalfMs: med(plain.slice(0, Math.floor(plain.length / 2)).map(r => r.markers['lines.insert'])),
    plainLastHalfMs: med(plain.slice(Math.floor(plain.length / 2)).map(r => r.markers['lines.insert'])),
    commitMs: summaryOf(plain.map(r => r.markers['transaction.commit'])), planOnMs: summaryOf(plans.map(r => r.markers['lines.insert'])),
    jitPlans: records.filter(r => r.plan?.JIT).length, diagnostics: {} };
  const fields = ['Actual Total Time', 'Shared Read Blocks', 'Shared Written Blocks', 'Shared Dirtied Blocks',
    'Shared I/O Read Time', 'Shared I/O Write Time', 'WAL Bytes', 'WAL FPI', 'Total Cost'];
  for (const field of fields) item.diagnostics[field] = summaryOf(plans.map(r => r.plan.Plan[field] ?? 0));
  for (const [name, read] of Object.entries({
    executionMs: p => p['Execution Time'],
    sourceSubtreeMs: p => p.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Actual Total Time'],
    writeNodeResidualMs: p => p.Plan['Actual Total Time'] - p.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Actual Total Time'],
    foreignKeyMs: p => (p.Triggers ?? []).reduce((sum, t) => sum + t.Time, 0),
    ownerPolicyNodeMs: p => sourceParents(p).reduce((sum, n) => sum + n['Actual Total Time'] * n['Actual Loops'], 0),
    ownerPolicyLoops: p => sourceParents(p).reduce((sum, n) => sum + n['Actual Loops'], 0),
    broadOwnershipRows: p => sourceParents(p).reduce((sum, n) => sum + (n['Actual Loops'] === 1 ? n['Actual Rows'] : 0), 0),
    ownerHeapFetches: p => sourceParents(p).reduce((sum, n) => sum + (n['Heap Fetches'] ?? 0), 0),
    sourceReadBlocks: p => p.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Shared Read Blocks'] ?? 0,
    sourceIoReadMs: p => p.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Shared I/O Read Time'] ?? 0,
  })) item.diagnostics[name] = summaryOf(plans.map(r => read(r.plan)));
  item.sourceScanTypes = [...new Set(plans.flatMap(r => nodes(r.plan.Plan).filter(n => n.Alias === 'line_items_1').map(n => n['Node Type'])))];
  item.ownerPolicyNodeTypes = [...new Set(plans.flatMap(r => sourceParents(r.plan).map(n => n['Node Type'])))];
  sql.push(item);
}
const http = [];
for (const level of results.levels) for (const mode of ['off', 'on']) for (const key of new Set(results.http.map(r => r.case))) {
  const rows = results.http.filter(r => r.level === level && r.mode === mode && r.case === key);
  const item = { level, mode, case: key, totalMs: summaryOf(rows.map(r => r.totalMs)) };
  if (mode === 'on') {
    item.spans = {};
    for (const name of ['copy.lines_insert', 'projection.lines_read', 'source.lock_read', 'auth.session', 'request.total']) {
      item.spans[name] = summaryOf(rows.map(r => r.trace.spans.find(s => s.name === name).durationMs));
    }
  }
  http.push(item);
}
const output = input.replace(/results\.json$/, 'summary.json');
assert.notEqual(output, input);
const indexProbes = (results.indexProbes ?? []).flatMap(stage => [337, 411].flatMap(count => ['fresh', 'repeat'].map(mode => {
  const records = stage.records.filter(r => r.count === count && r.mode === mode);
  return { level: stage.level, count, mode, executionMs: summaryOf(records.map(r => r.plan['Execution Time'])),
    readBlocks: summaryOf(records.map(r => r.plan.Plan['Shared Read Blocks'])),
    readMs: summaryOf(records.map(r => r.plan.Plan['Shared I/O Read Time'])) };
})));
await writeFile(output, JSON.stringify({ sql, http, indexProbes, notes: [
  'Plain inserts are primary SQL latency. Plan diagnostics cover only the first five measured rounds and include recorder overhead.',
  'Phases are sequential load levels, not paired configurations. Natural cache/storage/visibility changes are included.',
  'writeNodeResidualMs is root minus source-child elapsed time; it includes destination writes and checks, not a pure index timing.',
  'Nested node buffer/time counters overlap. Do not sum parents and children. Read time measures PostgreSQL storage reads, including OS-cache service.',
  'Owner policy node time multiplies per-loop rounded EXPLAIN time by loops; submillisecond point-check totals are approximate.',
  'Index probes are privileged read-only absent-key lookups, not endpoint/INSERT timings; fresh precedes same-key repeat by design.',
  'No policy or product code change was measured. No p95, confidence interval, or full-populated-database equivalence claimed.',
] }, null, 2), { mode: 0o600 });
console.log(output);
