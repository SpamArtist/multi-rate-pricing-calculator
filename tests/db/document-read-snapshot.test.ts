import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, withTenantTransaction } from '../../src/db/client.js';
import type { AuthenticatedOwnerId } from '../../src/shared/types/authenticated-owner.js';
import { documents } from '../../src/db/schema.js';
import { projectDocumentSummaries, serializeDocument } from '../../src/db/document-projection.js';
import { createTestOwner, deleteTestOwner, migrationPool, testOwnerId, testPool, withOwner } from '../support/db-fixture.js';

describe('document aggregate read snapshot', () => {
  const ownerId = testOwnerId();
  let documentId = '';

  beforeAll(async () => {
    await createTestOwner(ownerId, 'read-snapshot@example.test');
    const inserted = await withOwner(ownerId, async client => {
      const document = await client.query<{ id: string }>(
        'INSERT INTO documents (owner_id, title, issue_date) VALUES ($1, $2, $3) RETURNING id',
        [ownerId, 'Before save', '2026-10-14'],
      );
      await client.query(
        'INSERT INTO line_items (document_id, position, quantity, unit_price_cents) VALUES ($1, 1, 1, 100)',
        [document.rows[0].id],
      );
      await client.query(
        'UPDATE documents SET draft_subtotal_cents = 100, draft_taxable_cents = 100, draft_total_cents = 100 WHERE id = $1',
        [document.rows[0].id],
      );
      return document.rows[0].id;
    });
    documentId = inserted;
  });

  afterAll(async () => {
    await deleteTestOwner(ownerId);
    await Promise.all([testPool.end(), migrationPool.end(), closeDatabase()]);
  });

  async function commitSave(title: string, price: number): Promise<void> {
    await withOwner(ownerId, async client => {
      await client.query(
        'UPDATE documents SET title = $1, draft_subtotal_cents = $2, draft_taxable_cents = $2, draft_total_cents = $2 WHERE id = $3',
        [title, price, documentId],
      );
      await client.query('UPDATE line_items SET unit_price_cents = $1 WHERE document_id = $2', [price, documentId]);
    });
  }

  it('keeps detail metadata and lines in one committed state across a concurrent save', async () => {
    const read = await withTenantTransaction(ownerId as AuthenticatedOwnerId, async transaction => {
      const [row] = await transaction.select().from(documents).where(eq(documents.id, documentId));
      expect(row.title).toBe('Before save');
      await commitSave('After save', 200);
      return serializeDocument(transaction, row);
    }, { consistentRead: true });

    expect(read).toMatchObject({ title: 'Before save', amounts: { totalCents: 100 } });
    const next = await withTenantTransaction(ownerId as AuthenticatedOwnerId, async transaction => {
      const [row] = await transaction.select().from(documents).where(eq(documents.id, documentId));
      return serializeDocument(transaction, row);
    }, { consistentRead: true });
    expect(next).toMatchObject({ title: 'After save', amounts: { totalCents: 200 } });
  });

  it('keeps dashboard metadata and stored totals in one committed state across a concurrent save', async () => {
    const read = await withTenantTransaction(ownerId as AuthenticatedOwnerId, async transaction => {
      const rows = await transaction.select().from(documents).where(eq(documents.id, documentId));
      expect(rows[0].title).toBe('After save');
      await commitSave('Latest save', 300);
      return projectDocumentSummaries(rows);
    }, { consistentRead: true });

    expect(read).toMatchObject([{ title: 'After save', amounts: { totalCents: 200 } }]);
    const next = await withTenantTransaction(ownerId as AuthenticatedOwnerId, async transaction => {
      const rows = await transaction.select().from(documents).where(eq(documents.id, documentId));
      return projectDocumentSummaries(rows);
    }, { consistentRead: true });
    expect(next).toMatchObject([{ title: 'Latest save', amounts: { totalCents: 300 } }]);
  });
});
