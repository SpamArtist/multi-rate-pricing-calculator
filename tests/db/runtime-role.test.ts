import { afterAll, describe, expect, it } from 'vitest';
import { testOwnerId, testPool, withOwner } from '../support/db-fixture.js';

describe('runtime role tenant isolation', () => {
  afterAll(async () => testPool.end());

  it('uses a restricted non-owner role and isolates durable rows by transaction identity', async () => {
    const role = await testPool.query(`
      SELECT current_user AS name, role.rolsuper, role.rolbypassrls,
             table_owner.rolname AS table_owner, table_class.relrowsecurity, table_class.relforcerowsecurity
      FROM pg_roles AS role
      CROSS JOIN pg_class AS table_class
      JOIN pg_roles AS table_owner ON table_owner.oid = table_class.relowner
      WHERE role.rolname = current_user AND table_class.relname = 'documents'
    `);
    expect(role.rows).toHaveLength(1);
    expect(role.rows[0]).toMatchObject({
      name: 'pricing_runtime',
      rolsuper: false,
      rolbypassrls: false,
      table_owner: 'pricing_migrator',
      relrowsecurity: true,
      relforcerowsecurity: true,
    });

    const ownerA = testOwnerId();
    const ownerB = testOwnerId();
    let documentA = '';
    let documentB = '';
    try {
      const insertedA = await withOwner(ownerA, async client => client.query<{ id: string }>(
        `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id`,
        [ownerA, 'fixture A', '2026-09-30'],
      ));
      documentA = insertedA.rows[0].id;
      const insertedB = await withOwner(ownerB, async client => client.query<{ id: string }>(
        `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id`,
        [ownerB, 'fixture B', '2026-10-03'],
      ));
      documentB = insertedB.rows[0].id;

      const [visibleA, visibleB] = await Promise.all([
        withOwner(ownerA, client => client.query<{ title: string }>('SELECT title FROM documents ORDER BY title')),
        withOwner(ownerB, client => client.query<{ title: string }>('SELECT title FROM documents ORDER BY title')),
      ]);
      expect(visibleA.rows.map(row => row.title)).toEqual(['fixture A']);
      expect(visibleB.rows.map(row => row.title)).toEqual(['fixture B']);

      await expect(withOwner(ownerA, client => client.query(
        `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3)`,
        [ownerB, 'cross-owner insert', '2026-10-03'],
      ))).rejects.toMatchObject({ code: '42501' });

      const noIdentity = await testPool.query('SELECT id FROM documents WHERE id = $1', [documentA]);
      expect(noIdentity.rows).toEqual([]);
      const unauthorizedUpdate = await withOwner(ownerA, client => client.query(
        'UPDATE documents SET title = $1 WHERE id = $2', ['changed', documentB],
      ));
      expect(unauthorizedUpdate.rowCount).toBe(0);
    } finally {
      if (documentA) await withOwner(ownerA, client => client.query('DELETE FROM documents WHERE id = $1', [documentA]));
      if (documentB) await withOwner(ownerB, client => client.query('DELETE FROM documents WHERE id = $1', [documentB]));
    }
  });
});
