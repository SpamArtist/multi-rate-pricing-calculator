import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, withTenantTransaction } from '../../src/db/client.js';
import type { AuthenticatedOwnerId } from '../../src/shared/types/authenticated-owner.js';
import { documents } from '../../src/db/schema.js';
import {
  createTestOwner,
  deleteTestOwner,
  migrationPool,
  testOwnerId,
  testPool,
  withOwner,
} from '../support/db-fixture.js';

const tenantOwner = (id: string): AuthenticatedOwnerId => id as AuthenticatedOwnerId;

describe('runtime role tenant isolation', () => {
  const ownerA = testOwnerId();
  const ownerB = testOwnerId();
  const owners = [ownerA, ownerB];
  let documentA = '';
  let documentB = '';
  let lineA = '';
  let lineB = '';

  afterAll(async () => {
    for (const ownerId of owners) await deleteTestOwner(ownerId);
    await Promise.all([testPool.end(), migrationPool.end(), closeDatabase()]);
  });

  it('runs as restricted runtime role; migration role owns forced-RLS tenant tables', async () => {
    await createTestOwner(ownerA, 'owner-a@example.test');
    await createTestOwner(ownerB, 'owner-b@example.test');

    const roles = await testPool.query(`
      SELECT runtime.rolname AS runtime_name, runtime.rolsuper, runtime.rolbypassrls,
             table_class.relname, table_owner.rolname AS table_owner,
             table_class.relrowsecurity, table_class.relforcerowsecurity,
             has_table_privilege(runtime.rolname, table_class.oid, 'TRUNCATE') AS can_truncate,
             has_schema_privilege(runtime.rolname, 'public', 'CREATE') AS can_create_in_public,
             CASE WHEN table_class.relname = 'documents'
               THEN has_column_privilege(runtime.rolname, table_class.oid, 'owner_id', 'UPDATE')
               ELSE false
             END AS can_reassign_owner
      FROM pg_roles AS runtime
      CROSS JOIN pg_class AS table_class
      JOIN pg_roles AS table_owner ON table_owner.oid = table_class.relowner
      WHERE runtime.rolname = current_user
        AND table_class.relname IN ('documents', 'line_items')
      ORDER BY table_class.relname
    `);
    expect(roles.rows).toHaveLength(2);
    for (const row of roles.rows) {
      expect(row).toMatchObject({
        runtime_name: 'pricing_runtime',
        rolsuper: false,
        rolbypassrls: false,
        table_owner: 'pricing_migrator',
        relrowsecurity: true,
        relforcerowsecurity: true,
        can_truncate: false,
        can_create_in_public: false,
        can_reassign_owner: false,
      });
    }

    const [insertedA, insertedB] = await Promise.all([
      withOwner(ownerA, client => client.query<{ id: string }>(
        `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id`,
        [ownerA, 'owner A document', '2026-09-30'],
      )),
      withOwner(ownerB, client => client.query<{ id: string }>(
        `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id`,
        [ownerB, 'owner B document', '2026-10-03'],
      )),
    ]);
    documentA = insertedA.rows[0].id;
    documentB = insertedB.rows[0].id;

    const [insertedLineA, insertedLineB] = await Promise.all([
      withOwner(ownerA, client => client.query<{ id: string }>(
        `INSERT INTO line_items (document_id, position, quantity, unit_price_cents)
         VALUES ($1, 1, 2, 125) RETURNING id`, [documentA],
      )),
      withOwner(ownerB, client => client.query<{ id: string }>(
        `INSERT INTO line_items (document_id, position, quantity, unit_price_cents)
         VALUES ($1, 1, 3, 250) RETURNING id`, [documentB],
      )),
    ]);
    lineA = insertedLineA.rows[0].id;
    lineB = insertedLineB.rows[0].id;
  });

  it('allows owner reads and writes; hides and rejects cross-owner document and line operations', async () => {
    const ownDocuments = await withOwner(ownerA, client => client.query<{ title: string }>(
      'SELECT title FROM documents ORDER BY title',
    ));
    expect(ownDocuments.rows.map(row => row.title)).toEqual(['owner A document']);
    const ownLines = await withOwner(ownerA, client => client.query<{ id: string }>(
      'SELECT id FROM line_items WHERE document_id = $1', [documentA],
    ));
    expect(ownLines.rows.map(row => row.id)).toEqual([lineA]);

    const hiddenDocument = await withOwner(ownerA, client => client.query(
      'SELECT id FROM documents WHERE id = $1', [documentB],
    ));
    const hiddenLine = await withOwner(ownerA, client => client.query(
      'SELECT id FROM line_items WHERE id = $1', [lineB],
    ));
    expect(hiddenDocument.rows).toEqual([]);
    expect(hiddenLine.rows).toEqual([]);

    await expect(withOwner(ownerA, client => client.query(
      `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3)`,
      [ownerB, 'foreign insert', '2026-10-03'],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(withOwner(ownerA, client => client.query(
      `INSERT INTO line_items (document_id, position, quantity, unit_price_cents)
       VALUES ($1, 2, 1, 1)`, [documentB],
    ))).rejects.toMatchObject({ code: '42501' });

    const crossDocumentUpdate = await withOwner(ownerA, client => client.query(
      'UPDATE documents SET title = $1 WHERE id = $2', ['changed', documentB],
    ));
    const crossDocumentDelete = await withOwner(ownerA, client => client.query(
      'DELETE FROM documents WHERE id = $1', [documentB],
    ));
    const crossLineUpdate = await withOwner(ownerA, client => client.query(
      'UPDATE line_items SET description = $1 WHERE id = $2', ['changed', lineB],
    ));
    const crossLineDelete = await withOwner(ownerA, client => client.query(
      'DELETE FROM line_items WHERE id = $1', [lineB],
    ));
    expect(crossDocumentUpdate.rowCount).toBe(0);
    expect(crossDocumentDelete.rowCount).toBe(0);
    expect(crossLineUpdate.rowCount).toBe(0);
    expect(crossLineDelete.rowCount).toBe(0);

    await expect(withOwner(ownerA, client => client.query(
      'UPDATE line_items SET document_id = $1 WHERE id = $2', [documentB, lineA],
    ))).rejects.toMatchObject({ code: '42501' });
    const unchangedParent = await withOwner(ownerA, client => client.query<{ document_id: string }>(
      'SELECT document_id FROM line_items WHERE id = $1', [lineA],
    ));
    expect(unchangedParent.rows[0].document_id).toBe(documentA);

    const ownUpdate = await withOwner(ownerA, client => client.query(
      'UPDATE documents SET title = $1 WHERE id = $2', ['owner A updated', documentA],
    ));
    expect(ownUpdate.rowCount).toBe(1);
  });

  it('fails closed without identity and clears transaction-local identity on pooled A→B→A reuse', async () => {
    const noIdentityRead = await testPool.query('SELECT id FROM documents WHERE id = $1', [documentA]);
    expect(noIdentityRead.rows).toEqual([]);
    await expect(testPool.query(
      `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3)`,
      [ownerA, 'missing identity', '2026-10-14'],
    )).rejects.toMatchObject({ code: '42501' });

    const firstA = await withOwner(ownerA, async client => ({
      pid: (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      titles: (await client.query<{ title: string }>('SELECT title FROM documents')).rows.map(row => row.title),
    }));
    const onlyB = await withOwner(ownerB, async client => ({
      pid: (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      titles: (await client.query<{ title: string }>('SELECT title FROM documents')).rows.map(row => row.title),
    }));
    const secondA = await withOwner(ownerA, async client => ({
      pid: (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      titles: (await client.query<{ title: string }>('SELECT title FROM documents')).rows.map(row => row.title),
    }));
    expect(onlyB.pid).toBe(firstA.pid);
    expect(secondA.pid).toBe(firstA.pid);
    expect(firstA.titles).toEqual(['owner A updated']);
    expect(onlyB.titles).toEqual(['owner B document']);
    expect(secondA.titles).toEqual(['owner A updated']);

    const restoredSetting = await testPool.query<{ identity: string | null }>(
      "SELECT current_setting('app.user_id', true) AS identity",
    );
    expect([null, '']).toContain(restoredSetting.rows[0].identity);
  });

  it('uses one authenticated Drizzle transaction and rolls failed work back', async () => {
    const title = 'Drizzle scoped transaction';
    const inserted = await withTenantTransaction(tenantOwner(ownerA), async transaction => {
      await transaction.execute(sql`
        INSERT INTO documents (owner_id, title, issue_date)
        VALUES (${ownerA}, ${title}, ${'2026-10-14'})
      `);
      const visible = await transaction.select({ title: documents.title })
        .from(documents)
        .where(eq(documents.title, title));
      return visible[0]?.title;
    });
    expect(inserted).toBe(title);

    const rollbackTitle = 'rolled back tenant row';
    await expect(withTenantTransaction(tenantOwner(ownerA), async transaction => {
      await transaction.execute(sql`
        INSERT INTO documents (owner_id, title, issue_date)
        VALUES (${ownerA}, ${rollbackTitle}, ${'2026-10-14'})
      `);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const absent = await withOwner(ownerA, client => client.query(
      'SELECT id FROM documents WHERE title = $1', [rollbackTitle],
    ));
    expect(absent.rows).toEqual([]);
    await withOwner(ownerA, client => client.query('DELETE FROM documents WHERE title = $1', [title]));
  });

  it('rejects invalid authenticated IDs before opening a tenant transaction', async () => {
    await expect(withTenantTransaction('not-a-uuid' as AuthenticatedOwnerId, async () => undefined))
      .rejects.toThrow('Authenticated owner ID must be a UUID.');
  });

  it('isolates draft save replay records and prevents runtime owners from changing replay keys', async () => {
    const mutationId = testOwnerId();
    await withOwner(ownerA, client => client.query(
      'INSERT INTO draft_save_mutations (owner_id, mutation_id, request_hash) VALUES ($1, $2, $3)',
      [ownerA, mutationId, 'request-a'],
    ));
    const hidden = await withOwner(ownerB, client => client.query(
      'SELECT mutation_id FROM draft_save_mutations WHERE mutation_id = $1', [mutationId],
    ));
    expect(hidden.rows).toEqual([]);
    const noIdentity = await testPool.query('SELECT mutation_id FROM draft_save_mutations WHERE mutation_id = $1', [mutationId]);
    expect(noIdentity.rows).toEqual([]);
    await expect(withOwner(ownerB, client => client.query(
      'INSERT INTO draft_save_mutations (owner_id, mutation_id, request_hash) VALUES ($1, $2, $3)',
      [ownerA, testOwnerId(), 'foreign'],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(withOwner(ownerA, client => client.query(
      'UPDATE draft_save_mutations SET request_hash = $1 WHERE mutation_id = $2', ['changed', mutationId],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces user/session constraints and document/line defaults in PostgreSQL', async () => {
    await expect(migrationPool.query(
      `INSERT INTO users (id, email_display, email_canonical, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [testOwnerId(), 'Owner A', 'owner-a@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash'],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(migrationPool.query(
      `INSERT INTO users (id, email_display, email_canonical, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [testOwnerId(), ' padded@example.test ', 'padded@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash'],
    )).rejects.toMatchObject({ code: '23514' });

    const tokenHash = `test-token-hash-${testOwnerId()}`;
    const session = await testPool.query<{ created_at: Date; last_activity_at: Date; expires_at: Date }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 day')
       RETURNING created_at, last_activity_at, expires_at`, [ownerA, tokenHash],
    );
    expect(session.rows[0].last_activity_at.getTime()).toBe(session.rows[0].created_at.getTime());
    expect(session.rows[0].expires_at.getTime()).toBeGreaterThan(session.rows[0].created_at.getTime());
    await expect(testPool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`, [ownerA, tokenHash],
    )).rejects.toMatchObject({ code: '23505' });

    const draft = await withOwner(ownerA, client => client.query<{
      id: string;
      customer_name: string;
      status: string;
      finalized_at: Date | null;
      finalized_total_cents: string | null;
    }>(
      `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3)
       RETURNING id, customer_name, status, finalized_at, finalized_total_cents`,
      [ownerA, 'defaults fixture', '2026-10-14'],
    ));
    expect(draft.rows[0]).toMatchObject({
      customer_name: '',
      status: 'draft',
      finalized_at: null,
      finalized_total_cents: null,
    });
    const defaultLine = await withOwner(ownerA, client => client.query<{
      description: string;
      discount_cents: string;
      tax_rate_basis_points: number;
    }>(
      `INSERT INTO line_items (document_id, position, quantity, unit_price_cents)
       VALUES ($1, 1, 1, 0) RETURNING description, discount_cents, tax_rate_basis_points`,
      [draft.rows[0].id],
    ));
    expect(defaultLine.rows[0]).toEqual({ description: '', discount_cents: '0', tax_rate_basis_points: 0 });

    await expect(withOwner(ownerA, client => client.query(
      `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3)`,
      [ownerA, '   ', '2026-10-14'],
    ))).rejects.toMatchObject({ code: '23514' });
    await expect(withOwner(ownerA, client => client.query(
      `INSERT INTO line_items (document_id, position, quantity, unit_price_cents, tax_rate_basis_points)
       VALUES ($1, 2, 1, 0, 10001)`, [draft.rows[0].id],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('cascades own draft deletion to lines and rejects invalid finalized snapshots', async () => {
    const draft = await withOwner(ownerA, client => client.query<{ id: string }>(
      `INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id`,
      [ownerA, 'cascade fixture', '2026-10-14'],
    ));
    const cascadeDocumentId = draft.rows[0].id;
    await withOwner(ownerA, client => client.query(
      `INSERT INTO line_items (document_id, position, quantity, unit_price_cents)
       VALUES ($1, 1, 1, 100)`, [cascadeDocumentId],
    ));
    const deleted = await withOwner(ownerA, client => client.query(
      'DELETE FROM documents WHERE id = $1', [cascadeDocumentId],
    ));
    expect(deleted.rowCount).toBe(1);
    const cascadedLine = await withOwner(ownerA, client => client.query(
      'SELECT id FROM line_items WHERE document_id = $1', [cascadeDocumentId],
    ));
    expect(cascadedLine.rows).toEqual([]);

    await expect(withOwner(ownerA, client => client.query(
      `UPDATE documents SET status = 'finalized', finalized_at = now(), customer_name = 'Customer',
       finalized_subtotal_cents = 100 WHERE id = $1`, [documentA],
    ))).rejects.toMatchObject({ code: '23514' });
    await expect(withOwner(ownerA, client => client.query(
      `UPDATE documents SET status = 'finalized', finalized_at = now(), customer_name = 'Customer',
       finalized_subtotal_cents = 9007199254740992, finalized_discount_cents = 0,
       finalized_taxable_cents = 9007199254740992, finalized_tax_cents = 0,
       finalized_total_cents = 9007199254740992 WHERE id = $1`, [documentA],
    ))).rejects.toMatchObject({ code: '23514' });

    const stillDraft = await withOwner(ownerA, client => client.query<{ status: string }>(
      'SELECT status FROM documents WHERE id = $1', [documentA],
    ));
    expect(stillDraft.rows[0].status).toBe('draft');

    await expect(withOwner(ownerA, client => client.query(
      'UPDATE line_items SET finalized_subtotal_cents = 250 WHERE id = $1', [lineA],
    ))).rejects.toMatchObject({ code: '23514' });
    await expect(withOwner(ownerA, client => client.query(
      `UPDATE line_items SET finalized_subtotal_cents = 9007199254740992,
       finalized_taxable_cents = 9007199254740992, finalized_tax_cents = 0,
       finalized_total_cents = 9007199254740992 WHERE id = $1`, [lineA],
    ))).rejects.toMatchObject({ code: '23514' });
  });
});
