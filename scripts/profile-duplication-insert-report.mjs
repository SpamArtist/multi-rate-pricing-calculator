const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => +value.toFixed(3);
const wall = record => record.markers.find(marker => marker.name === 'copy.lines_insert').durationMs;
const nodes = plan => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const totalTime = node => (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 0);
const source = record => record.plan.Plan.Plans.find(n => n['Parent Relationship'] === 'Outer');
const sourceLines = record => nodes(source(record)).find(n => n['Relation Name'] === 'line_items');
const sourceParents = record => nodes(source(record)).filter(n => n['Relation Name'] === 'documents');

export function summarizeInsertProfile(results) {
  const summary = results.cases.flatMap(testCase => results.variants.map(variant => {
    const records = results.records.filter(record => record.case === testCase.key && record.variant === variant);
    const plain = records.filter(record => record.mode === 'plain');
    const off = records.filter(record => record.mode === 'plan-off');
    const on = records.filter(record => record.mode === 'plan-on');
    const metric = get => round(median(on.map(get)));
    const pairedOverhead = probe => round(median(probe.map(record => wall(record) - wall(plain.find(p => p.round === record.round)))));
    return { case: testCase.key, variant,
      plainMs: round(median(plain.map(wall))),
      firstHalfMs: round(median(plain.slice(0, Math.ceil(plain.length / 2)).map(wall))),
      lastHalfMs: round(median(plain.slice(Math.floor(plain.length / 2)).map(wall))),
      planOffMs: round(median(off.map(wall))), planOnMs: round(median(on.map(wall))),
      pairedOffOverheadMs: pairedOverhead(off), pairedOnOverheadMs: pairedOverhead(on),
      planningMs: metric(r => r.plan['Planning Time']), executionMs: metric(r => r.plan['Execution Time']),
      jitSamples: on.filter(r => r.plan.JIT).length, jitMs: metric(r => r.plan.JIT?.Timing?.Total ?? 0),
      sourceSubtreeMs: metric(r => totalTime(source(r))),
      sourceEstimatedRows: metric(r => sourceLines(r)['Plan Rows']),
      sourceActualRows: metric(r => sourceLines(r)['Actual Rows']),
      ownershipScanMs: metric(r => sourceParents(r).filter(n => n['Actual Rows'] > 1).reduce((sum, n) => sum + totalTime(n), 0)),
      ownershipScanRows: metric(r => sourceParents(r).filter(n => n['Actual Rows'] > 1).reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0)),
      sourceParentLookupLoops: metric(r => sourceParents(r).filter(n => n['Actual Rows'] <= 1).reduce((sum, n) => sum + n['Actual Loops'], 0)),
      sourceParentIndexLoops: metric(r => sourceParents(r).filter(n => n['Actual Rows'] <= 1 && n['Node Type'].includes('Index')).reduce((sum, n) => sum + n['Actual Loops'], 0)),
      sourceParentSeqScanLoops: metric(r => sourceParents(r).filter(n => n['Node Type'] === 'Seq Scan').reduce((sum, n) => sum + n['Actual Loops'], 0)),
      fkMs: metric(r => (r.plan.Triggers ?? []).reduce((sum, t) => sum + t.Time, 0)),
      triggerCalls: metric(r => (r.plan.Triggers ?? []).reduce((sum, t) => sum + t.Calls, 0)),
      sharedReads: metric(r => r.plan.Plan['Shared Read Blocks']), sharedHits: metric(r => r.plan.Plan['Shared Hit Blocks']),
      tempReads: metric(r => r.plan.Plan['Temp Read Blocks']), walBytes: metric(r => r.plan.Plan['WAL Bytes']),
    };
  }));
  const comparisons = results.variants.length !== 2 ? [] : results.cases.map(testCase => {
    const plain = results.records.filter(r => r.case === testCase.key && r.mode === 'plain');
    const baseline = plain.filter(r => r.variant === 'baseline');
    const savings = baseline.map(r => wall(r) - wall(plain.find(p => p.variant === 'scalar' && p.round === r.round)));
    return { case: testCase.key, baselineMs: summary.find(r => r.case === testCase.key && r.variant === 'baseline').plainMs,
      scalarMs: summary.find(r => r.case === testCase.key && r.variant === 'scalar').plainMs,
      pairedSavedMs: round(median(savings)), positivePairs: savings.filter(n => n > 0).length, pairs: savings.length };
  });
  const rows = summary.map(r => `| ${r.case} | ${r.variant} | ${r.plainMs} | ${r.firstHalfMs} / ${r.lastHalfMs} | ${r.sourceEstimatedRows} / ${r.sourceActualRows} | ${r.ownershipScanRows} | ${r.sourceParentLookupLoops} | ${r.jitSamples} |`).join('\n');
  const comparisonRows = comparisons.map(r => `| ${r.case} | ${r.baselineMs} | ${r.scalarMs} | ${r.pairedSavedMs} | ${r.positivePairs}/${r.pairs} |`).join('\n');
  const markdown = `# Committed-fixture bulk-copy experiment\n\nRun: ${results.runId}\n\n` +
    `Each case has ${results.warmups} warmups and ${results.samples} measured rounds per variant/probe. Fixtures are committed; each copy uses a fresh transaction, commits, is independently verified and deleted. Empty heaps are truncated and checked before fixture setup. VACUUM ANALYZE with forced index cleanup/truncation runs before every sample outside timing. Policy DDL commits before runtime transactions. Variant order alternates; cases and plain/TIMING OFF/TIMING ON probes rotate. Effective runtime role and both tables' RLS are verified.\n\n` +
    `The scalar candidate changes only line_items USING to a scalar parent-owner lookup. WITH CHECK is preserved. Indexes are rebuilt once after fixture commit to remove storage inherited from previous experiments; definitions remain unchanged. This is a disposable-DB experiment, not an application migration.\n\n` +
    (comparisons.length ? `| Case | Baseline ms | Scalar ms | Paired median saved ms | Positive pairs |\n| --- | ---: | ---: | ---: | ---: |\n${comparisonRows}\n\n` : '') +
    `| Case | Variant | Plain insert ms | First / last half ms | Source estimated / actual rows | Broad ownership rows | Per-line parent checks | JIT samples |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
    `Upper median = sorted index floor(n/2). Savings/recorder overhead are medians of same-round differences; no p95 or confidence interval is claimed. First/last-half medians overlap one sample for odd counts. Parent-scale comparisons are not paired. See summary.json for phase, buffer, WAL, FK and overhead measurements; results.json retains every plan, sample's starting relation sizes/statistics, and isolation checks.\n\n` +
    `Plan times include child work; multiply per-loop time by loops, but never add ancestors to descendants. JIT overlaps execution. Small per-loop times are rounded. A per-line parent check may use an index or a sequential scan; inspect sourceParentIndexLoops/sourceParentSeqScanLoops and full plans. Source row estimates shown include policy selectivity, so estimated rows need not equal actual rows even after accurate ANALYZE. See [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/18/using-explain.html).\n\n` +
    `This is a serial insert-slice benchmark with independently authored fixtures (${results.sourceLineCount} source lines), warm-cache maintenance before samples and synthetic uniform parents. Commit is recorded separately from INSERT. It excludes HTTP/auth/projection/React overhead and does not reproduce the populated seed's millions of lines. Concurrency checks are correctness probes, not throughput measurements. Do not subtract these timings from earlier rollback or endpoint results.\n\n` +
    `Final state: ${JSON.stringify(results.remaining)}. Original policy restored: ${results.policyRestored}. Recovery ledger: cleanup-ledger.json.\n`;
  return { summary, comparisons, markdown };
}
