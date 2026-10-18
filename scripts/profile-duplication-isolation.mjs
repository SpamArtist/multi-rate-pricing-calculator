import assert from 'node:assert/strict';

// Run outside measured samples, against committed fixtures and the selected policy.
// Every mutation below is rolled back; only the caller owns policy installation.
export async function verifyDuplicationIsolation({ runtimePool, admin, owner, foreignOwner, source, foreignDocument }) {
  assert.ok(runtimePool.options.max >= 2, 'Isolation concurrency checks require a runtime pool with at least two clients');
  const results = [];
  const fixture = await admin.query(`SELECT document_id, id, position FROM line_items
    WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, position`, [[source, foreignDocument]]);
  const owned = fixture.rows.filter(row => row.document_id === source);
  const foreign = fixture.rows.filter(row => row.document_id === foreignDocument);
  assert.ok(owned.length >= 2, 'Isolation fixture needs at least two owned lines');
  assert.ok(foreign.length >= 1, 'Isolation fixture needs a foreign line');
  assert.notEqual(owner, foreignOwner);
  const client = await runtimePool.connect();
  let transactionOpen = false;

  async function begin(connection) {
    await connection.query('BEGIN');
    await connection.query("SET LOCAL statement_timeout = '5s'");
    await connection.query("SET LOCAL lock_timeout = '500ms'");
    const role = (await connection.query(`SELECT current_user, rolsuper, rolbypassrls,
      row_security_active('documents') AS documents_rls,
      row_security_active('line_items') AS lines_rls
      FROM pg_roles WHERE rolname = current_user`)).rows[0];
    assert.deepEqual(role, {
      current_user: 'pricing_runtime', rolsuper: false, rolbypassrls: false,
      documents_rls: true, lines_rls: true,
    });
  }

  async function bind(connection, identity) {
    await connection.query("SELECT set_config('app.user_id', $1, true)", [identity]);
  }

  async function expectRejected(connection, sql, parameters, code = '42501') {
    await connection.query('SAVEPOINT isolation_rejection');
    try {
      await assert.rejects(connection.query(sql, parameters), error => error.code === code);
    } finally {
      await connection.query('ROLLBACK TO SAVEPOINT isolation_rejection');
      await connection.query('RELEASE SAVEPOINT isolation_rejection');
    }
  }

  async function visibleLines(connection, documentId) {
    return (await connection.query('SELECT id FROM line_items WHERE document_id = $1 ORDER BY position', [documentId])).rows;
  }

  try {
    // No identity is bound in this transaction, including on a reused connection.
    transactionOpen = true;
    await begin(client);
    const identity = (await client.query("SELECT current_setting('app.user_id', true) AS identity")).rows[0].identity;
    assert.ok(identity === null || identity === '', 'Runtime connection retained a tenant identity');
    assert.deepEqual(await visibleLines(client, source), []);
    await expectRejected(client, `INSERT INTO line_items
      (document_id, position, quantity, unit_price_cents) VALUES ($1, $2, 1, 1)`, [source, owned.at(-1).position + 1]);
    results.push({ check: 'unbound-identity-denied', passed: true });

    await bind(client, '');
    assert.deepEqual(await visibleLines(client, source), []);
    await expectRejected(client, `INSERT INTO line_items
      (document_id, position, quantity, unit_price_cents) VALUES ($1, $2, 1, 1)`, [source, owned.at(-1).position + 1]);
    results.push({ check: 'empty-identity-denied', passed: true });

    await bind(client, owner);
    assert.deepEqual(await visibleLines(client, source), owned.map(({ id }) => ({ id })));
    assert.deepEqual(await visibleLines(client, foreignDocument), []);
    assert.equal((await client.query('SELECT id FROM line_items WHERE id = $1', [foreign[0].id])).rowCount, 0);
    assert.equal((await client.query('UPDATE line_items SET description = $1 WHERE id = $2', ['forbidden', foreign[0].id])).rowCount, 0);
    assert.equal((await client.query('DELETE FROM line_items WHERE id = $1', [foreign[0].id])).rowCount, 0);
    results.push({ check: 'foreign-read-update-delete-hidden', passed: true });

    await expectRejected(client, `INSERT INTO line_items
      (document_id, position, quantity, unit_price_cents) VALUES ($1, $2, 1, 1)`, [foreignDocument, foreign.at(-1).position + 1]);
    await expectRejected(client, 'UPDATE line_items SET document_id = $1 WHERE id = $2', [foreignDocument, owned[0].id]);
    results.push({ check: 'foreign-insert-reparent-rejected', passed: true });

    await client.query('SAVEPOINT isolation_owned_writes');
    try {
      assert.equal((await client.query('UPDATE line_items SET description = $1 WHERE id = $2', ['isolation owned update', owned[0].id])).rowCount, 1);
      assert.equal((await client.query('DELETE FROM line_items WHERE id = $1', [owned[1].id])).rowCount, 1);
      assert.equal((await client.query(`INSERT INTO line_items
        (document_id, position, quantity, unit_price_cents) VALUES ($1, $2, 1, 1)`, [source, owned.at(-1).position + 1])).rowCount, 1);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT isolation_owned_writes');
      await client.query('RELEASE SAVEPOINT isolation_owned_writes');
    }
    results.push({ check: 'owned-read-insert-update-delete-allowed', passed: true });

    await bind(client, foreignOwner);
    assert.deepEqual(await visibleLines(client, source), []);
    assert.deepEqual(await visibleLines(client, foreignDocument), foreign.map(({ id }) => ({ id })));
    await bind(client, owner);
    assert.deepEqual(await visibleLines(client, source), owned.map(({ id }) => ({ id })));
    assert.deepEqual(await visibleLines(client, foreignDocument), []);
    results.push({ check: 'identity-rebinding-a-b-a', passed: true });
    await client.query('ROLLBACK');
    transactionOpen = false;

    // A second transaction must wait on the same source lock used by duplication.
    // The bounded lock timeout proves serialization without relying on wall-clock thresholds.
    const contender = await runtimePool.connect();
    let contenderOpen = false;
    try {
      transactionOpen = true;
      await begin(client);
      const restoredIdentity = (await client.query("SELECT current_setting('app.user_id', true) AS identity")).rows[0].identity;
      assert.ok(restoredIdentity === null || restoredIdentity === '', 'Transaction-local identity leaked after rollback');
      await bind(client, owner);
      assert.equal((await client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [source])).rowCount, 1);
      contenderOpen = true;
      await begin(contender);
      await bind(contender, owner);
      await expectRejected(contender, 'SELECT id FROM documents WHERE id = $1 FOR UPDATE', [source], '55P03');
      results.push({ check: 'source-lock-serializes-concurrent-owner', passed: true });
      await bind(contender, foreignOwner);
      assert.deepEqual(await visibleLines(contender, source), []);
      assert.equal((await contender.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [source])).rowCount, 0);
      results.push({ check: 'foreign-owner-denied-while-source-locked', passed: true });
      await client.query('ROLLBACK');
      transactionOpen = false;
      await bind(contender, owner);
      assert.equal((await contender.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [source])).rowCount, 1);
      results.push({ check: 'source-lock-released-after-rollback', passed: true });
    } finally {
      try { if (contenderOpen) await contender.query('ROLLBACK'); }
      finally { contender.release(); }
    }
  } finally {
    try { if (transactionOpen) await client.query('ROLLBACK'); }
    finally { client.release(); }
  }
  return results;
}
