// Summarize paired diagnostic INSERT variants; generated evidence stays ignored.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
const input = process.argv[2];
assert.ok(input, 'Usage: node scripts/profile-uuid-locality-report.mjs results.json');
const result = JSON.parse(await readFile(input, 'utf8'));
assert.equal(result.experiment, 'uuid-locality');
assert.ok(!result.error && !result.cleanupError && result.policyUnchanged && result.schemaUnchanged);
assert.deepEqual(result.remaining, { users: 0, documents: 0, lines: 0 });
const median = values => {
  assert.ok(values.length);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = value => +value.toFixed(3);
const summary = values => ({ n: values.length, median: round(median(values)), min: Math.min(...values), max: Math.max(...values) });
const walk = node => [node, ...(node.Plans ?? []).flatMap(walk)];
const rows = [];
for (const level of result.levels) for (const name of new Set(result.records.map(r => r.case))) {
  const records = result.records.filter(r => r.level === level && r.case === name);
  const variants = {};
  for (const variant of ['v4', 'v4-explicit', 'v7']) {
    const plain = records.filter(r => r.variant === variant && r.mode === 'plain').sort((a, b) => a.round - b.round);
    assert.equal(plain.length, result.samples);
    const plans = records.filter(r => r.variant === variant && r.mode === 'plan-off');
    const timed = records.filter(r => r.variant === variant && r.mode === 'plan-on');
    assert.ok(plans.length && timed.length);
    for (const record of [...plans, ...timed]) {
      assert.equal(record.plan.Triggers.find(t => t['Constraint Name'] === 'line_items_document_id_fkey').Calls, Number(name.split('-')[1]));
    }
    const half = Math.floor(plain.length / 2);
    variants[variant] = {
      insertMs: summary(plain.map(r => r.markers['lines.insert'])),
      firstHalfMs: round(median(plain.slice(0, half).map(r => r.markers['lines.insert']))),
      lastHalfMs: round(median(plain.slice(half).map(r => r.markers['lines.insert']))),
      commitMs: summary(plain.map(r => r.markers['transaction.commit'])),
      executionMs: summary(plans.map(r => r.plan['Execution Time'])),
      jitPlans: [...plans, ...timed].filter(r => r.plan.JIT).length,
      diagnostics: {},
      planShapes: [...new Set(plans.map(r => walk(r.plan.Plan).map(n => `${n['Node Type']}:${n['Relation Name'] ?? ''}:${n['Index Name'] ?? ''}:${n['Actual Loops']}`).join('|')))],
    };
    for (const field of ['Shared Read Blocks', 'Shared Dirtied Blocks', 'Shared Written Blocks', 'Shared I/O Read Time', 'Shared I/O Write Time', 'WAL Bytes', 'WAL FPI']) {
      variants[variant].diagnostics[field] = summary(plans.map(r => r.plan.Plan[field] ?? 0));
    }
    variants[variant].diagnostics.sourceReadBlocks = summary(plans.map(r => r.plan.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Shared Read Blocks'] ?? 0));
    variants[variant].diagnostics.foreignKeyMs = summary(timed.map(r => (r.plan.Triggers ?? []).filter(t => t['Constraint Name'] === 'line_items_document_id_fkey').reduce((sum, t) => sum + t.Time, 0)));
    variants[variant].diagnostics.sourceMs = summary(timed.map(r => r.plan.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer')['Actual Total Time']));
  }
  const pairs = records.filter(r => r.variant === 'v4' && r.mode === 'plain').map(before => {
    const after = records.find(r => r.variant === 'v7' && r.mode === 'plain' && r.round === before.round);
    const control = records.find(r => r.variant === 'v4-explicit' && r.mode === 'plain' && r.round === before.round);
    assert.ok(after);
    assert.ok(control);
    return { round: before.round, savedMs: before.markers['lines.insert'] - after.markers['lines.insert'], controlSavedMs: control.markers['lines.insert'] - after.markers['lines.insert'] };
  });
  rows.push({ level, case: name, variants, pairedSavingsMs: summary(pairs.map(p => p.savedMs)),
    pairedExplicitControlSavingsMs: summary(pairs.map(p => p.controlSavedMs)),
    v7FasterThanExplicitPairs: pairs.filter(p => p.controlSavedMs > 0).length,
    v7FasterPairs: pairs.filter(p => p.savedMs > 0).length,
    medianReductionPercent: round(100 * (1 - variants.v7.insertMs.median / variants.v4.insertMs.median)),
    v4FirstSavingsMs: summary(pairs.filter(p => [0, 3, 5].includes(p.round % 6)).map(p => p.savedMs)),
    v7FirstSavingsMs: summary(pairs.filter(p => [1, 2, 4].includes(p.round % 6)).map(p => p.savedMs)),
  });
}
const output = input.replace(/results\.json$/, 'uuid-locality-summary.json');
assert.notEqual(output, input);
await writeFile(output, JSON.stringify({ rows, notes: [
  'Plain SQL insert spans are primary; paired variants alternate order and retain live copies until stage end.',
  'Plan-off buffer/WAL metrics cover spaced rounds; plan-on source/FK time has per-node clock overhead.',
  'Root counters cover the ModifyTable node and child plans, not exclusively the primary-key index; source reads and AFTER-FK trigger time reported separately.',
  'PostgreSQL reads can be served by the OS cache; physical disk misses are not directly measured.',
  'Original UUIDv4 background, RLS policies, defaults, indexes and constraints remain in place. Disposable INSERT(id) grant is shared by all arms, then revoked and ACLs verified.',
  'SQL diagnostic candidate only: no candidate HTTP execution, concurrency test, full-size reproduction or deployment claim.',
] }, null, 2), { mode: 0o600 });
console.log(output);
