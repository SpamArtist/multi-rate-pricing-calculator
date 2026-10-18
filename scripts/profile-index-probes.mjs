// Read-side index locality surrogate. This does not execute an INSERT or tenant authorization.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export async function measurePrimaryKeyProbes(client, { samples = 20 } = {}) {
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  const records = [];
  for (let round = 0; round < samples; round++) for (const count of [337, 411]) {
    const keys = Array.from({ length: count }, () => randomUUID());
    for (const mode of ['fresh', 'repeat']) {
      const start = performance.now();
      const result = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF)
        SELECT count(hit.id) FROM unnest($1::uuid[]) AS probe(id)
        LEFT JOIN LATERAL (SELECT id FROM line_items WHERE id=probe.id OFFSET 0) AS hit ON true
        HAVING count(hit.id)=0`, [keys]);
      const plan = result.rows[0]['QUERY PLAN'][0];
      assert.equal(plan.Plan['Actual Rows'], 1, 'A probe key unexpectedly matched');
      assert.equal(plan.Plan['Actual Loops'], 1);
      const walk = node => [node, ...(node.Plans ?? []).flatMap(walk)];
      const indexes = walk(plan.Plan).filter(node => node['Index Name']);
      assert.equal(indexes.length, 1);
      assert.equal(indexes[0]['Index Name'], 'line_items_pkey');
      assert.equal(indexes[0]['Actual Loops'], count);
      assert.equal(indexes[0]['Actual Rows'], 0, 'Random absent-key probe unexpectedly matched');
      records.push({ round, count, mode, wallMs: performance.now() - start, plan });
    }
  }
  return records;
}
