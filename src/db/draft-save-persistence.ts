import type { DraftMetadata } from './draft-save-persistence.types.js';
import { and, eq, sql } from 'drizzle-orm';
import type { TenantTransaction } from './client.types.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';
import { documents, draftSaveMutations, lineItems } from './schema.js';

/** The unique key arbitrates concurrent retries before any draft write. */
export async function claimDraftSaveMutation(
  transaction: TenantTransaction, ownerId: AuthenticatedOwnerId, mutationId: string, hash: string,
): Promise<boolean> {
  const inserted = await transaction.execute<{ mutation_id: string }>(sql`
    INSERT INTO draft_save_mutations (owner_id, mutation_id, request_hash)
    VALUES (${ownerId}, ${mutationId}, ${hash})
    ON CONFLICT (owner_id, mutation_id) DO NOTHING
    RETURNING mutation_id
  `);
  return inserted.rows.length !== 0;
}

export async function findDraftSaveMutation(
  transaction: TenantTransaction, ownerId: AuthenticatedOwnerId, mutationId: string,
) {
  const [previous] = await transaction.select().from(draftSaveMutations)
    .where(and(eq(draftSaveMutations.ownerId, ownerId), eq(draftSaveMutations.mutationId, mutationId)))
    .limit(1);
  return previous;
}

export async function lockDraft(transaction: TenantTransaction, documentId: string) {
  const [draft] = await transaction.select().from(documents)
    .where(eq(documents.id, documentId)).for('update').limit(1);
  return draft;
}

export async function createDraft(
  transaction: TenantTransaction, ownerId: AuthenticatedOwnerId, metadata: DraftMetadata,
) {
  const createdId = await transaction.execute<{ id: string }>(sql`
    INSERT INTO documents (owner_id, title, customer_name, issue_date)
    VALUES (${ownerId}, ${metadata.title}, ${metadata.customerName}, ${metadata.issueDate})
    RETURNING id
  `);
  const [created] = await transaction.select().from(documents)
    .where(eq(documents.id, createdId.rows[0].id)).limit(1);
  if (!created) throw new Error('Inserted draft is missing.');
  return created;
}

export async function draftLineIds(transaction: TenantTransaction, documentId: string): Promise<string[]> {
  const lines = await transaction.select({ id: lineItems.id }).from(lineItems)
    .where(eq(lineItems.documentId, documentId));
  return lines.map(line => line.id);
}

export async function updateDraft(
  transaction: TenantTransaction, documentId: string, metadata: DraftMetadata, updatedAt: Date,
) {
  await transaction.update(documents).set({
    title: metadata.title, customerName: metadata.customerName, issueDate: metadata.issueDate, updatedAt,
  }).where(eq(documents.id, documentId));
  const [updated] = await transaction.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!updated) throw new Error('Updated draft is missing.');
  return updated;
}

export async function recordDraftSaveResponse(
  transaction: TenantTransaction, ownerId: AuthenticatedOwnerId, mutationId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await transaction.update(draftSaveMutations).set({ response })
    .where(and(eq(draftSaveMutations.ownerId, ownerId), eq(draftSaveMutations.mutationId, mutationId)));
}
