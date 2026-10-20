const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => +value.toFixed(3);
const wall = record => record.markers.find(marker => marker.name === 'copy.lines_insert').durationMs;
const nodes = plan => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const totalTime = node => (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 0);

export function summarizeInsertProfile(results) {
  const summary = results.cases.map(testCase => {
    const records = results.records.filter(record => record.case === testCase.key);
    const plain = records.filter(record => record.mode === 'plain');
    const off = records.filter(record => record.mode === 'plan-off');
    const on = records.filter(record => record.mode === 'plan-on');
    const metric = get => round(median(on.map(get)));
    const pairedOverhead = probe => round(median(probe.map(record => wall(record) - wall(plain.find(p => p.round === record.round)))));
    return { case: testCase.key,
      plainMs: round(median(plain.map(wall))),
      firstHalfMs: round(median(plain.slice(0, Math.ceil(plain.length / 2)).map(wall))),
      lastHalfMs: round(median(plain.slice(Math.floor(plain.length / 2)).map(wall))),
      planOffMs: round(median(off.map(wall))), planOnMs: round(median(on.map(wall))),
      pairedOffOverheadMs: pairedOverhead(off), pairedOnOverheadMs: pairedOverhead(on),
      planningMs: metric(r => r.plan['Planning Time']), executionMs: metric(r => r.plan['Execution Time']),
      jitSamples: on.filter(r => r.plan.JIT).length,
      jitMs: metric(r => r.plan.JIT?.Timing?.Total ?? 0),
      sourceSubtreeMs: metric(r => totalTime(r.plan.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer'))),
      // Only ownership nodes themselves; their ancestors already include these times.
      ownershipScanMs: metric(r => nodes(r.plan.Plan).filter(n => n['Relation Name'] === 'documents' && n['Actual Rows'] > 1).reduce((sum, n) => sum + totalTime(n), 0)),
      ownershipRows: metric(r => nodes(r.plan.Plan).filter(n => n['Relation Name'] === 'documents' && n['Actual Rows'] > 1).reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0)),
      fkMs: metric(r => (r.plan.Triggers ?? []).reduce((sum, t) => sum + t.Time, 0)),
      triggerCalls: metric(r => (r.plan.Triggers ?? []).reduce((sum, t) => sum + t.Calls, 0)),
      sharedReads: metric(r => r.plan.Plan['Shared Read Blocks']),
      sharedHits: metric(r => r.plan.Plan['Shared Hit Blocks']),
      tempReads: metric(r => r.plan.Plan['Temp Read Blocks']),
      walBytes: metric(r => r.plan.Plan['WAL Bytes']),
    };
  });
  const rows = summary.map(r => `| ${r.case} | ${r.plainMs} | ${r.executionMs} | ${r.sourceSubtreeMs} | ${r.ownershipScanMs} | ${r.fkMs} | ${r.jitMs} | ${r.pairedOnOverheadMs} |`).join('\n');
  const markdown = `# Bulk line-copy profile\n\nRun: ${results.runId}\n\n` +
    `Each case: ${results.warmups} warmups, ${results.samples} measured rounds, rotated plain / EXPLAIN TIMING OFF / TIMING ON probes. Runtime role has RLS active on both tables. Exact INSERT is extracted from the application route. Fixtures are independent synthetic inputs. Each population has twice as many foreign-owner parents as owned parents and 1,580 total source lines.\n\n` +
    `| Tenant parents–state–lines | Plain insert ms | Plan execution ms | Source subtree ms | Ownership scan ms | FK trigger ms | JIT ms | Paired plan-on overhead ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
    `JIT time overlaps execution and some node timings; do not add it to them. Zero means no JIT block in the sampled plans. Check jitSamples and first/last-half drift: growing rollback debris can increase estimated costs enough to activate JIT mid-run.\n\n` +
    `All values are upper medians: sorted index floor(n/2). Overhead is the median of same-round probe minus plain differences, not the difference of medians. No p95 is claimed. See summary.json for TIMING OFF overhead, first/last-half drift, buffers, trigger calls, WAL and planning time. results.json contains every span and full query plan.\n\n` +
    `Ownership scan time is included in the source subtree; source time is included in execution. Do not add overlapping columns. Per-node time is multiplied by actual loops. FK time is the sum of EXPLAIN trigger entries; inspect the saved trigger inventory before assuming all entries are FK checks. Tiny per-loop timings are rounded by PostgreSQL. EXPLAIN timing and result serialization perturb execution. See [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/18/using-explain.html).\n\n` +
    `This is a serial database diagnostic, not an HTTP/browser or production-latency benchmark. Fixtures live in an outer transaction; each copy is rolled back to a savepoint. There is no durable COMMIT, independent transaction snapshot, concurrent traffic, or intentional lock contention. Parent scale is varied in listed order, not paired across populations. VACUUM ANALYZE runs on the empty database before each population; rollback debris can accumulate within a population. Planner estimates and cache state can therefore differ from a committed, populated database. Stored amounts are fixture setup values; the measured slice ends at line insertion.\n\n` +
    `Every copy verifies count, order, descriptions, inputs and cleared finalized totals. Source states/counts and total populations are checked after each workload. Final rollback left ${JSON.stringify(results.remaining)}. No application query, policy, index, or trigger was changed.\n`;
  return { summary, markdown };
}
