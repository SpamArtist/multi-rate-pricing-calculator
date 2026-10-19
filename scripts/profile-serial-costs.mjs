// Disposable-only diagnostic: catalog changes and ablated writes always roll back.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const round = n => +n.toFixed(3);
const ident = name => { assert.match(name, /^[a-zA-Z_][a-zA-Z_0-9]*$/); return `"${name}"`; };
const columns = 'document_id,position,description,quantity,unit_price_cents,discount_cents,tax_rate_basis_points';
const copiedColumns = 'position,description,quantity,unit_price_cents,discount_cents,tax_rate_basis_points,finalized_subtotal_cents,finalized_taxable_cents,finalized_tax_cents,finalized_total_cents';
const arms = ['exact', 'preloaded', 'staged', 'no-fk', 'no-checks', 'no-pk', 'no-position-index', 'bypass', 'floor'];

export async function serialFilesystem(client) {
  // Fixed read-only program; the temp table disappears with the connection.
  assert.ok((await client.query('SHOW data_directory')).rows[0].data_directory.startsWith('/var/lib/postgresql/'));
  await client.query('CREATE TEMP TABLE IF NOT EXISTS serial_filesystem (line text)');
  await client.query('TRUNCATE pg_temp.serial_filesystem');
  await client.query("COPY pg_temp.serial_filesystem FROM PROGRAM 'df -Pk /var/lib/postgresql'");
  const lines = (await client.query('SELECT line FROM pg_temp.serial_filesystem')).rows.map(r => r.line);
  assert.equal(lines.length, 2);
  const fields = lines[1].trim().split(/\s+/);
  const availableBytes = Number(fields[3]) * 1024;
  assert.ok(Number.isFinite(availableBytes) && availableBytes > 0);
  return { at: new Date().toISOString(), availableBytes, lines };
}

async function catalog(client) {
  return {
    constraints: (await client.query("SELECT oid::text,conname,contype,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='line_items'::regclass ORDER BY conname")).rows,
    indexes: (await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='line_items' ORDER BY indexname")).rows,
    triggers: (await client.query("SELECT oid::text,tgname,tgtype,tgenabled,tgconstraint::text FROM pg_trigger WHERE tgrelid='line_items'::regclass ORDER BY tgname")).rows,
    tables: (await client.query("SELECT relname,relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE oid IN ('documents'::regclass,'line_items'::regclass) ORDER BY relname")).rows,
    columns: (await client.query("SELECT a.attname,a.attnotnull,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) def FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='line_items'::regclass AND a.attnum>0 ORDER BY a.attnum")).rows,
    policies: (await client.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
  };
}

// Read-only surrogate for generator CPU/executor cost; no table/cache/WAL writes.
export async function measureSerialGenerators(client) {
  const records = [];
  const expressions = { control: 'NULL::uuid', v4: 'gen_random_uuid()', v7: 'uuidv7()' };
  const orders = [['control', 'v4', 'v7'], ['v7', 'v4', 'control'], ['v4', 'v7', 'control'],
    ['control', 'v7', 'v4'], ['v7', 'control', 'v4'], ['v4', 'control', 'v7']];
  await client.query('BEGIN READ ONLY');
  try {
    for (let sample = -6; sample < 36; sample++) for (const count of sample % 2 ? [411, 337] : [337, 411]) {
      for (const variant of orders[((sample % 6) + 6) % 6]) {
        const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) SELECT ${expressions[variant]} FROM generate_series(1,$1)`, [count])).rows[0]['QUERY PLAN'][0];
        assert.equal(plan.Plan['Actual Rows'], count);
        if (sample >= 0) records.push({ count, variant, round: sample, plan });
      }
    }
  } finally { await client.query('ROLLBACK'); }
  return records;
}

export async function measureSerialCosts({ admin, sources, insertSql, samples, level, results, checkInterrupted }) {
  assert.equal((await admin.query('SELECT current_database() name')).rows[0].name, 'pricing');
  const privilege = (await admin.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(privilege.rolsuper || privilege.rolbypassrls);
  const original = await catalog(admin);
  const checks = original.constraints.filter(c => c.contype === 'c');
  const fk = original.constraints.filter(c => c.contype === 'f');
  assert.equal(fk.length, 1); assert.equal(checks.length, 9);
  const fkTriggers = original.triggers.filter(t => t.tgconstraint === fk[0].oid && (t.tgtype & 4));
  assert.equal(fkTriggers.length, 1); assert.equal(fkTriggers[0].tgenabled, 'O');
  assert.equal(original.indexes.length, 2);
  assert.ok(original.constraints.some(c => c.conname === 'line_items_pkey' && c.contype === 'p'));
  assert.ok(original.constraints.some(c => c.conname === 'line_items_document_position_unique' && c.definition.includes('DEFERRABLE')));
  assert.equal(original.columns.find(c => c.attname === 'id').def, 'gen_random_uuid()');
  await admin.query('SET track_io_timing=on');
  await admin.query("SET statement_timeout='30s'");
  await admin.query("SET lock_timeout='3s'");
  results.serialRecords ??= []; results.serialAnchors ??= []; results.serialSourcePlans ??= [];
  results.serialCatalog = original; results.serialPrivilegedRole = privilege;

  // Materialization preserves the exact endpoint's row-numbering and projected inputs.
  const selectSql = insertSql.slice(insertSql.indexOf('SELECT'));
  assert.ok(selectSql.includes('row_number()') && selectSql.includes('FROM line_items'));
  const stagedSql = `INSERT INTO public.line_items (${columns}) SELECT $1,position,description,quantity,unit_price_cents,discount_cents,tax_rate_basis_points FROM pg_temp.serial_source WHERE source_id=$2 ORDER BY position`;
  const returningSql = stagedSql + ` RETURNING id,uuid_extract_version(id)::int version,${copiedColumns}`;
  results.serialStagedSql = stagedSql;
  await admin.query('CREATE TEMP TABLE serial_source AS SELECT document_id AS source_id,position,description,quantity,unit_price_cents,discount_cents,tax_rate_basis_points FROM line_items WITH NO DATA');
  await admin.query('GRANT SELECT,INSERT ON pg_temp.serial_source TO pricing_runtime');
  for (const source of sources) {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE pricing_runtime');
      await admin.query("SELECT set_config('app.user_id',$1,true)", [source.owner]);
      assert.deepEqual((await admin.query("SELECT row_security_active('documents') documents,row_security_active('line_items') lines")).rows[0], { documents: true, lines: true });
      const staged = await admin.query('INSERT INTO pg_temp.serial_source ' + selectSql, [source.id, source.id]);
      assert.equal(staged.rowCount, source.count);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
  }
  await admin.query('ANALYZE pg_temp.serial_source');

  function verifyReturned(rows, source, variant) {
    const sorted = [...rows].sort((a, b) => a.position - b.position);
    assert.deepEqual(sorted.map(row => Object.fromEntries(copiedColumns.split(',').map(key => [key, row[key]]))), source.expectedCopy);
    assert.equal(new Set(rows.map(r => r.id)).size, source.count);
    const originals = new Set(source.before.map(r => r.id));
    assert.ok(rows.every(r => r.version === (variant === 'v7' ? 7 : 4) && !originals.has(r.id)));
  }
  async function verify(id, source, variant) {
    const copied = (await admin.query(`SELECT ${copiedColumns} FROM line_items WHERE document_id=$1 ORDER BY position`, [id])).rows;
    assert.deepEqual(copied, source.expectedCopy);
    const ids = (await admin.query('SELECT id,uuid_extract_version(id)::int version FROM line_items WHERE document_id=$1', [id])).rows;
    assert.equal(ids.length, source.count);
    assert.equal(new Set(ids.map(r => r.id)).size, source.count);
    const originals = new Set(source.before.map(r => r.id));
    assert.ok(ids.every(r => r.version === (variant === 'v7' ? 7 : 4) && !originals.has(r.id)));
  }
  async function trial(source, variant, arm, mode, sample, commit = false) {
    checkInterrupted();
    const record = { level, case: `${source.state}-${source.count}`, variant, arm, mode, round: sample };
    let id;
    await admin.query('BEGIN');
    try {
      if (!commit) {
        // Equal lock mode in every rollback arm. No other fixture traffic is permitted.
        await admin.query('LOCK TABLE line_items IN ACCESS EXCLUSIVE MODE');
        await admin.query(`ALTER TABLE line_items ALTER COLUMN id SET DEFAULT ${variant === 'v7' ? 'uuidv7()' : 'gen_random_uuid()'}`);
        if (['no-fk', 'floor'].includes(arm)) await admin.query(`ALTER TABLE line_items DISABLE TRIGGER ${ident(fkTriggers[0].tgname)}`);
        if (['no-checks', 'floor'].includes(arm)) for (const check of checks) await admin.query(`ALTER TABLE line_items DROP CONSTRAINT ${ident(check.conname)}`);
        if (['no-pk', 'floor'].includes(arm)) await admin.query('ALTER TABLE line_items DROP CONSTRAINT line_items_pkey');
        if (['no-position-index', 'floor'].includes(arm)) await admin.query('ALTER TABLE line_items DROP CONSTRAINT line_items_document_position_unique');
      } else assert.ok(variant === 'v4' && arm === 'exact' && mode === 'plain');
      if (!['bypass', 'floor'].includes(arm)) await admin.query('SET LOCAL ROLE pricing_runtime');
      await admin.query("SELECT set_config('app.user_id',$1,true)", [source.owner]);
      const active = (await admin.query("SELECT row_security_active('line_items') active")).rows[0].active;
      assert.equal(active, !['bypass', 'floor'].includes(arm));
      assert.equal((await admin.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [source.id])).rowCount, 1);
      id = (await admin.query("INSERT INTO documents(owner_id,title,customer_name,issue_date) VALUES($1,'Serial probe','Synthetic customer','2026-10-19') RETURNING id", [source.owner])).rows[0].id;
      // A separate preloaded/no-RETURNING arm controls source removal. All index/
      // constraint ablations share RETURNING so verification never scans the
      // background heap when its document lookup index is absent.
      const returnsRows = !['exact', 'preloaded'].includes(arm);
      const sql = arm === 'exact' ? insertSql : returnsRows ? returningSql : stagedSql;
      const prefix = mode === 'plain' ? '' : `EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,VERBOSE,FORMAT JSON,TIMING ${mode === 'plan-on' ? 'ON' : 'OFF'}) `;
      const start = performance.now();
      const inserted = await admin.query(prefix + sql, [id, source.id]);
      record.insertMs = round(performance.now() - start);
      if (mode === 'plain') {
        assert.equal(inserted.rowCount, source.count);
        if (returnsRows) verifyReturned(inserted.rows, source, variant);
      } else {
        record.plan = inserted.rows[0]['QUERY PLAN'][0];
        if (returnsRows) assert.equal(record.plan.Plan['Actual Rows'], source.count);
      }
      if (commit) {
        const start = performance.now(); await admin.query('COMMIT');
        record.commitMs = round(performance.now() - start);
        await verify(id, source, variant);
        await admin.query('DELETE FROM documents WHERE id=$1', [id]);
      } else {
        await admin.query('RESET ROLE');
        if (!returnsRows) await verify(id, source, variant);
        await admin.query('ROLLBACK');
      }
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    assert.deepEqual(await catalog(admin), original, 'Rollback failed to restore schema, ACLs, RLS or triggers');
    assert.equal((await admin.query('SELECT count(*)::int n FROM documents WHERE id=$1', [id])).rows[0].n, 0);
    if (sample >= 0) (commit ? results.serialAnchors : results.serialRecords).push(record);
  }

  // Unmodified committed UUIDv4 anchors bracket rollback diagnostics.
  for (let sample = -3; sample < Math.ceil(samples / 2); sample++) for (const source of sources) await trial(source, 'v4', 'exact', 'plain', sample, true);
  const cells = ['v4', 'v7'].flatMap(variant => arms.map(arm => ({ variant, arm })));
  // Rotating and reversing the full schedule balances position and preceding arms.
  for (const mode of ['plain', 'plan-off', 'plan-on']) {
    const n = mode === 'plain' ? samples : 4;
    for (let sample = -2; sample < n; sample++) {
      const offset = ((sample % cells.length) + cells.length) % cells.length;
      const schedule = [...cells.slice(offset), ...cells.slice(0, offset)];
      if (Math.floor(sample / cells.length) % 2) schedule.reverse();
      for (const source of sample % 2 ? [...sources].reverse() : sources) {
        for (const { variant, arm } of schedule) await trial(source, variant, arm, mode, sample);
      }
      if (sample >= 0) {
        const filesystem = await serialFilesystem(admin); results.filesystems.push(filesystem);
        assert.ok(filesystem.availableBytes >= 600 * 1024 ** 2, 'Database filesystem reserve reached during measurement');
        if (sample % 4 === 0) console.log(JSON.stringify({ level, phase: 'serial-costs', mode, round: sample }));
      }
    }
  }
  for (let sample = Math.ceil(samples / 2); sample < samples; sample++) for (const source of sources) await trial(source, 'v4', 'exact', 'plain', sample, true);
  // Read-only source plans isolate source authorization/sort from destination work.
  for (let sample = 0; sample < 6; sample++) for (const source of sources) for (const bypass of sample % 2 ? [true, false] : [false, true]) {
    await admin.query('BEGIN READ ONLY');
    try {
      if (!bypass) await admin.query('SET LOCAL ROLE pricing_runtime');
      await admin.query("SELECT set_config('app.user_id',$1,true)", [source.owner]);
      const plan = (await admin.query('EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) ' + selectSql, [source.id, source.id])).rows[0]['QUERY PLAN'][0];
      assert.equal(plan.Plan['Actual Rows'], source.count);
      results.serialSourcePlans.push({ level, case: `${source.state}-${source.count}`, bypass, round: sample, plan });
    } finally { await admin.query('ROLLBACK'); }
  }
  assert.deepEqual(await catalog(admin), original);
  await admin.query('DROP TABLE pg_temp.serial_source');
  results.serialGenerators = await measureSerialGenerators(admin);
  results.checks.push({ level, serialRollbackCatalogVerified: true, stagedRowsCorrect: true, copiesCorrect: true });
}
