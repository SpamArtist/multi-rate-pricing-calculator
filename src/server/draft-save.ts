import type { DraftSaveInput } from './draft-save.types.js';
import { createHash } from 'node:crypto';
import { withTenantTransaction } from '../db/client.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';
import { serializeDocument } from '../db/document-projection.js';
import {
  claimDraftSaveMutation, createDraft, draftLineIds, findDraftSaveMutation, lockDraft,
  recordDraftSaveResponse, updateDraft,
} from '../db/draft-save-persistence.js';
import { replaceDraftLines } from '../db/line-set-persistence.js';
import type { Clock } from '../shared/types/clock.js';

class MissingDraft extends Error {}
class FinalizedDraft extends Error {}

function requestHash(values: DraftSaveInput): string {
  return createHash('sha256').update(JSON.stringify({
    documentId: values.documentId ?? null,
    title: values.title,
    customerName: values.customerName,
    issueDate: values.issueDate,
    lineItems: values.lineItems.map(line => ({
      id: line.id ?? null,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPriceCents: line.unitPriceCents.toString(),
      discountCents: line.discountCents.toString(),
      taxRateBasisPoints: line.taxRateBasisPoints,
    })),
  })).digest('hex');
}

/** Save one complete draft; retries return the response from the committed mutation. */
export async function saveDraft(ownerId: AuthenticatedOwnerId, values: DraftSaveInput, clock: Clock) {
  const hash = requestHash(values);
  try {
    return await withTenantTransaction(ownerId, async transaction => {
      const claimed = await claimDraftSaveMutation(transaction, ownerId, values.mutationId, hash);
      if (!claimed) {
        const previous = await findDraftSaveMutation(transaction, ownerId, values.mutationId);
        if (!previous || !previous.response) throw new Error('Committed draft save is missing its response.');
        return previous.requestHash === hash
          ? { kind: 'replayed' as const, document: previous.response }
          : { kind: 'conflict' as const };
      }

      const row = values.documentId
        ? await lockDraft(transaction, values.documentId)
        : await createDraft(transaction, ownerId, values);
      if (!row) throw new MissingDraft();
      if (values.documentId && row.status !== 'draft') throw new FinalizedDraft();

      const existingIds = new Set(await draftLineIds(transaction, row.id));
      if (values.lineItems.some(line => line.id && !existingIds.has(line.id))) throw new MissingDraft();

      await replaceDraftLines(transaction, row.id, values.lineItems);
      const updated = await updateDraft(transaction, row.id, values, clock.now());
      const document = await serializeDocument(transaction, updated);
      await recordDraftSaveResponse(transaction, ownerId, values.mutationId, document);
      return { kind: values.documentId ? 'updated' as const : 'created' as const, document };
    });
  } catch (error) {
    if (error instanceof MissingDraft) return { kind: 'not_found' as const };
    if (error instanceof FinalizedDraft) return { kind: 'invalid_state' as const };
    throw error;
  }
}
