import { eq, sql } from 'drizzle-orm';
import type { TenantTransaction } from './client.types.js';
import type { DocumentRow } from './document-projection.types.js';
import { documents } from './schema.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';

export async function lockDuplicationSource(transaction: TenantTransaction, documentId: string) {
  const [source] = await transaction.select().from(documents)
    .where(eq(documents.id, documentId)).for('update').limit(1);
  return source;
}

export async function insertDuplicateDocument(
  transaction: TenantTransaction, ownerId: AuthenticatedOwnerId, source: DocumentRow, issueDate: string,
): Promise<string> {
  const inserted = await transaction.execute<{ id: string }>(sql`
    INSERT INTO documents (owner_id, title, customer_name, issue_date)
    VALUES (${ownerId}, ${source.title.trim()}, ${source.customerName.trim()}, ${issueDate})
    RETURNING id
  `);
  return inserted.rows[0].id;
}

export async function insertDuplicateLines(
  transaction: TenantTransaction, sourceId: string, copyId: string,
): Promise<number | null> {
  const inserted = await transaction.execute(sql`
    INSERT INTO line_items (
      document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
    )
    SELECT ${copyId}, row_number() OVER (ORDER BY position, id), description, quantity,
      unit_price_cents, discount_cents, tax_rate_basis_points
    FROM line_items WHERE document_id = ${sourceId}
  `);
  return inserted.rowCount;
}

export async function readDuplicateDocument(transaction: TenantTransaction, documentId: string) {
  const [copy] = await transaction.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!copy) throw new Error('Inserted duplicate document is missing.');
  return copy;
}
