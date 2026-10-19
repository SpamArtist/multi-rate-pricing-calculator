// Controlled rollback ablations are marginal comparisons, not an additive cost budget.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const input = process.argv[2];
assert.ok(input && process.argv.length === 3,
  'Usage: node scripts/profile-serial-costs-report.mjs results.json');
const result = JSON.parse(await readFile(input, 'utf8'));
assert.equal(result.experiment, 'serial-costs');
assert.ok(!result.error && !result.cleanupError && !result.serverCleanupError,
  'Measurements and cleanup must complete without errors');
assert.equal(result.policyUnchanged, true);
assert.equal(result.schemaUnchanged, true);
assert.deepEqual(result.remaining, { users: 0, documents: 0, lines: 0 });
assert.ok(Number.isInteger(result.samples) && result.samples >= 5);
assert.ok(Array.isArray(result.levels) && result.levels.length);
assert.equal(new Set(result.levels).size, result.levels.length);
assert.ok(result.levels.every(level => Number.isInteger(level) && level > 0));
for (const name of ['serialRecords', 'serialAnchors', 'serialSourcePlans']) {
  assert.ok(Array.isArray(result[name]) && result[name].length, `Missing ${name}`);
}
const variants = ['v4', 'v7'];
const arms = ['exact', 'preloaded', 'staged', 'no-fk', 'no-checks', 'no-pk', 'no-position-index', 'bypass', 'floor'];
const modes = ['plain', 'plan-off', 'plan-on'];
const round = n => +n.toFixed(3);
function finite(n, label, signed = false) {
  assert.ok(Number.isFinite(n) && (signed || n >= 0), `Invalid ${label}`);
  return n;
}
function summary(values) {
  if (!values.length) return null;
  values.forEach(n => finite(n, 'summary value', true));
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { n: values.length,
    median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    min: round(sorted[0]), max: round(sorted.at(-1)),
  };
}
function halves(records, read) {
  const split = Math.ceil(records.length / 2);
  return { all: summary(records.map(read)), firstHalf: summary(records.slice(0, split).map(read)),
    lastHalf: summary(records.slice(split).map(read)) };
}
const key = (...parts) => JSON.stringify(parts);
const cases = [...new Set(result.serialRecords.map(r => r.case))].sort();
assert.equal(cases.length, 2, 'Runner must measure draft and finalized sources');
assert.ok(cases.some(name => name.startsWith('draft-')) && cases.some(name => name.startsWith('finalized-')));
const counts = Object.fromEntries(cases.map(name => {
  assert.match(name, /^(draft|finalized)-[1-9][0-9]*$/);
  return [name, Number(name.split('-')[1])];
}));
function identity(record) {
  assert.ok(result.levels.includes(record.level) && cases.includes(record.case), 'Unexpected level/case');
  assert.ok(Number.isInteger(record.round) && record.round >= 0, 'Warmups or invalid rounds in measured results');
}
function expectedRounds(records, length, label) {
  records.sort((a, b) => a.round - b.round);
  assert.deepEqual(records.map(r => r.round), Array.from({ length }, (_, index) => index),
    `Missing or duplicate rounds: ${label}`);
  return records;
}
const numericPlanFields = ['Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops',
  'Shared Hit Blocks', 'Shared Read Blocks', 'Shared Dirtied Blocks', 'Shared Written Blocks',
  'Local Hit Blocks', 'Local Read Blocks', 'Local Dirtied Blocks', 'Local Written Blocks',
  'Temp Read Blocks', 'Temp Written Blocks', 'Shared I/O Read Time', 'Shared I/O Write Time',
  'Local I/O Read Time', 'Local I/O Write Time', 'Temp I/O Read Time', 'Temp I/O Write Time',
  'I/O Read Time', 'I/O Write Time', 'WAL Records', 'WAL FPI', 'WAL Bytes'];
function jitTiming(plan) {
  const values = {};
  function visit(object, prefix = '') {
    for (const [field, value] of Object.entries(object)) {
      const name = prefix + field;
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, `${name}.`);
      else values[name] = finite(value, `JIT ${name}`);
    }
  }
  visit(plan.JIT?.Timing ?? {});
  return values;
}
function validatePlan(plan) {
  assert.ok(plan?.Plan && typeof plan.Plan['Node Type'] === 'string', 'Missing JSON EXPLAIN plan');
  finite(plan['Execution Time'], 'Execution Time'); finite(plan['Planning Time'], 'Planning Time');
  function visit(node) {
    for (const field of numericPlanFields) if (node[field] !== undefined) finite(node[field], field);
    finite(node['Actual Rows'], 'Actual Rows'); finite(node['Actual Loops'], 'Actual Loops');
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(plan.Plan);
  for (const trigger of plan.Triggers ?? []) {
    finite(trigger.Calls, 'Trigger Calls');
    if (trigger.Time !== undefined) finite(trigger.Time, 'Trigger Time');
  }
  jitTiming(plan);
}
function sourceChild(plan) {
  const children = (plan.Plan.Plans ?? []).filter(node => node['Parent Relationship'] === 'Outer');
  assert.equal(children.length, 1, 'Expected one outer source subtree');
  return children[0];
}
const groups = new Map();
for (const record of result.serialRecords) {
  identity(record);
  assert.ok(variants.includes(record.variant) && arms.includes(record.arm) && modes.includes(record.mode));
  finite(record.insertMs, 'insertMs');
  assert.equal(record.commitMs, undefined, 'Rollback trial unexpectedly contains commit timing');
  if (record.mode !== 'plain') {
    validatePlan(record.plan);
    assert.equal(record.plan.Plan['Actual Rows'], ['exact', 'preloaded'].includes(record.arm) ? 0 : counts[record.case],
      'INSERT output rows differ from its RETURNING contract');
    assert.equal(sourceChild(record.plan)['Actual Rows'], counts[record.case], 'Source row count differs');
  }
  const id = key(record.level, record.case, record.variant, record.arm, record.mode);
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(record);
}
for (const level of result.levels) {
  assert.ok(result.checks?.some(check => check.level === level && check.serialRollbackCatalogVerified
    && check.stagedRowsCorrect && check.copiesCorrect), 'Missing rollback/catalog verification');
  assert.ok(result.checks.some(check => check.level === level && check.serialCosts && check.sourcesUnchanged
    && check.countsUnchanged), 'Missing source/count verification');
  for (const name of cases) for (const variant of variants) for (const arm of arms) for (const mode of modes) {
    const id = key(level, name, variant, arm, mode);
    assert.ok(groups.has(id), `Missing trial cell ${id}`);
    expectedRounds(groups.get(id), mode === 'plain' ? result.samples : 4, id);
  }
}
function optionalSummary(records, read, label) {
  const values = records.map(read);
  if (values.every(value => value === undefined)) return null;
  assert.ok(values.every(value => value !== undefined), `Inconsistent availability: ${label}`);
  values.forEach(value => finite(value, label));
  return summary(values);
}
const fkNames = result.serialCatalog?.constraints.filter(constraint => constraint.contype === 'f').map(c => c.conname);
assert.ok(fkNames?.length === 1, 'Expected original foreign key catalog');
function planSummary(records, includeSource) {
  const fieldSummary = read => Object.fromEntries(numericPlanFields.map(field => [field,
    optionalSummary(records, record => read(record.plan)[field], field)]).filter(([, value]) => value !== null));
  const triggerNames = [...new Set(records.flatMap(record => (record.plan.Triggers ?? []).map(trigger => trigger['Trigger Name'])))];
  const jitRecords = records.filter(record => record.plan.JIT !== undefined);
  const jitTimingFields = [...new Set(jitRecords.flatMap(record => Object.keys(jitTiming(record.plan))))];
  return {
    executionMs: summary(records.map(record => record.plan['Execution Time'])),
    planningMs: summary(records.map(record => record.plan['Planning Time'])),
    root: fieldSummary(plan => plan.Plan),
    ...(includeSource ? { sourceChild: fieldSummary(sourceChild) } : {}),
    triggers: triggerNames.map(name => {
      const matches = records.map(record => (record.plan.Triggers ?? []).filter(trigger => trigger['Trigger Name'] === name));
      assert.ok(matches.every(match => match.length === 1), 'Inconsistent trigger presence');
      const triggers = matches.map(match => match[0]);
      return { name, constraints: [...new Set(triggers.map(trigger => trigger['Constraint Name'] ?? null))],
        foreignKey: triggers.every(trigger => fkNames.includes(trigger['Constraint Name'])),
        calls: summary(triggers.map(trigger => trigger.Calls)),
        timeMs: optionalSummary(triggers, trigger => trigger.Time, 'trigger Time') };
    }),
    jitPlans: jitRecords.length,
    jitTimingMs: Object.fromEntries(jitTimingFields.map(field => [field,
      optionalSummary(jitRecords, record => jitTiming(record.plan)[field], `JIT ${field}`)])),
  };
}
const rows = [...groups.values()].map(records => {
  const { level, case: name, variant, arm, mode } = records[0];
  return { level, case: name, variant, arm, mode, insertMs: halves(records, record => record.insertMs),
    ...(mode === 'plain' ? {} : { diagnostics: planSummary(records, true) }) };
});
function paired(before, after, read) {
  assert.deepEqual(before.map(r => r.round), after.map(r => r.round), 'Unmatched paired rounds');
  const pairs = before.map((record, index) => ({ round: record.round, delta: read(record) - read(after[index]) }));
  return { savedMs: halves(pairs, pair => pair.delta), positivePairs: pairs.filter(pair => pair.delta > 0).length };
}
const comparisons = [];
for (const level of result.levels) for (const name of cases) for (const variant of variants) {
  for (const arm of arms.filter(arm => arm !== 'exact')) {
    const baseline = arm === 'preloaded' ? 'exact' : arm === 'staged' ? 'preloaded' : 'staged';
    const before = groups.get(key(level, name, variant, baseline, 'plain'));
    const after = groups.get(key(level, name, variant, arm, 'plain'));
    comparisons.push({ level, case: name, variant, baseline, arm, ...paired(before, after, r => r.insertMs) });
  }
}
const anchors = [];
for (const record of result.serialAnchors) {
  identity(record);
  assert.equal(record.variant, 'v4'); assert.equal(record.arm, 'exact'); assert.equal(record.mode, 'plain');
  finite(record.insertMs, 'anchor insertMs'); finite(record.commitMs, 'anchor commitMs');
}
const sourceReads = [];
for (const record of result.serialSourcePlans) {
  identity(record); assert.equal(typeof record.bypass, 'boolean'); validatePlan(record.plan);
  assert.equal(record.plan.Plan['Actual Rows'], counts[record.case]);
}
for (const level of result.levels) for (const name of cases) {
  const records = expectedRounds(result.serialAnchors.filter(r => r.level === level && r.case === name), result.samples, 'anchors');
  anchors.push({ level, case: name, variant: 'v4', insertMs: halves(records, r => r.insertMs),
    commitMs: halves(records, r => r.commitMs) });
  const sourceArms = Object.fromEntries([false, true].map(bypass => [bypass ? 'bypass' : 'runtime',
    expectedRounds(result.serialSourcePlans.filter(r => r.level === level && r.case === name && r.bypass === bypass), 6, 'source plans')]));
  sourceReads.push({ level, case: name,
    variants: Object.fromEntries(Object.entries(sourceArms).map(([role, plans]) => [role, planSummary(plans, false)])),
    paired: paired(sourceArms.runtime, sourceArms.bypass, r => r.plan['Execution Time']) });
}
const output = join(dirname(input), 'serial-costs-summary.json');
assert.notEqual(resolve(output), resolve(input));
const generators = [];
if (result.serialGenerators) {
  assert.equal(result.serialGenerators.length, 216);
  for (const record of result.serialGenerators) {
    assert.ok([337, 411].includes(record.count) && ['control', 'v4', 'v7'].includes(record.variant));
    validatePlan(record.plan); assert.equal(record.plan.Plan['Actual Rows'], record.count);
  }
  for (const count of [337, 411]) for (const variant of ['control', 'v4', 'v7']) {
    const records = expectedRounds(result.serialGenerators.filter(r => r.count === count && r.variant === variant), 36, 'generator');
    generators.push({ count, variant, executionMs: summary(records.map(r => r.plan['Execution Time'])) });
  }
}
await writeFile(output, JSON.stringify({ rows, comparisons, anchors, sourceReads, generators, notes: [
  'Plain insert timings are client-observed SQL duration. EXPLAIN modes are separate instrumented passes, not additional independent plain samples.',
  'Medians use the midpoint of the two central observations. First half contains the extra observation for odd sample counts.',
  'Paired savedMs is baseline minus candidate in the same round; negative means candidate slower. Staged versus preloaded measures RETURNING overhead with this sign convention.',
  'Removing one feature measures its marginal effect under the remaining configuration. Ablation deltas interact and must not be summed into a cost budget.',
  'Rollback arms include equal table locks and temporary catalog changes outside the timed INSERT. They do not reproduce normal committed endpoint traffic.',
  'Committed UUIDv4 anchors bracket diagnostics; first/last halves show drift. Commit time is separate from insertion and includes any synchronous durability wait.',
  'EXPLAIN parent/child buffers, WAL and timing counters overlap. Never add nested counters. Source child timing is not a pure source RLS measurement.',
  'EXPLAIN times are instrumented and rounded, often per loop. TIMING OFF omits node/trigger time where PostgreSQL does not provide it; omitted values are not zero.',
  'JIT timing summaries cover only plans reporting JIT, with their own sample counts; JIT/source/execution times can overlap and must not be added.',
  'Source read runtime versus bypass also changes role and policy context; it is a controlled marginal comparison, not exact ownership-only timing.',
  'Root Actual Rows is zero for INSERT without RETURNING; source child rows validate the rows supplied to the insert.',
  'Buffer reads may be served by the operating-system cache; they are not proof of physical disk misses. WAL bytes are volume, not WAL-writing duration.',
  'Floor retains heap/WAL, UUID generation, input processing, NOT NULL checks, RETURNING and client transport; it does not isolate each residual component.',
  'Generator probes are separate read-only executor measurements against a NULL projection control; they do not isolate the generator contribution inside INSERT.',
  'No p95, confidence interval, additive breakdown, production equivalence or concurrency conclusion is claimed.',
] }, null, 2), { mode: 0o600 });
console.log(output);
