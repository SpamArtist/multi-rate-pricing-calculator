import assert from 'node:assert/strict';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = value => +value.toFixed(3);
export function summarizeHttpProfile(results) {
  const comparisons = [];
  for (const mode of ['off', 'on']) for (const key of new Set(results.records.map(record => record.case))) {
    const baseline = results.records.filter(record => record.mode === mode && record.case === key && record.variant === 'baseline');
    const scalar = results.records.filter(record => record.mode === mode && record.case === key && record.variant === 'scalar');
    assert.equal(baseline.length, scalar.length);
    assert.ok(baseline.length);
    const scalarByRound = new Map(scalar.map(record => [record.round, record]));
    const metrics = ['totalMs', 'headersMs', 'bodyMs', 'parseMs'];
    if (mode === 'on') metrics.push(...new Set(baseline.flatMap(record => record.trace.spans.map(span => span.name))));
    const values = {};
    for (const metric of metrics) {
      const read = record => metric.endsWith('Ms') ? record[metric] : record.trace.spans.find(span => span.name === metric)?.durationMs;
      assert.ok([...baseline, ...scalar].every(record => Number.isFinite(read(record))), `Missing ${metric}`);
      const savings = baseline.map(record => read(record) - read(scalarByRound.get(record.round)));
      const midpoint = Math.floor(baseline.length / 2);
      values[metric] = { baselineMedianMs: rounded(median(baseline.map(read))), scalarMedianMs: rounded(median(scalar.map(read))),
        pairedSavingMedianMs: rounded(median(savings)), positivePairs: savings.filter(n => n > 0).length,
        firstHalfSavingMedianMs: rounded(median(savings.slice(0, midpoint || 1))),
        lastHalfSavingMedianMs: rounded(median(savings.slice(midpoint))) };
    }
    comparisons.push({ case: key, mode, pairs: baseline.length, metrics: values });
  }
  return { comparisons, notes: [
    'Primary latency is mode off, from fetch start through JSON.parse. All requests use the same compiled working-tree endpoint.',
    'Paired differences match case, mode and round; variant order alternates, case order rotates. Median uses sorted index floor(n/2).',
    'Mode on is a separate diagnostic pass. Nested spans overlap: do not add them. Server finish excludes client response receipt/parse.',
    'Warm cache, compact synthetic fixtures, maintenance before every copy. No production throughput or tail-latency claim.',
    'No p95: samples per cell are below 200. Trace on/off passes are not interleaved; their difference is not a causal tracing-overhead estimate.',
  ] };
}
