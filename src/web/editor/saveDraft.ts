import type { Amounts, DocumentData, DraftSaveBody, FieldErrors } from '../api/contracts.js';
import { responseError } from '../api/client.js';
import {
  type DocumentValues,
  type LineValues,
  lineValuesFromDocument,
  newLineValues,
  previewLine,
  splitFinalizationErrors,
} from './model.js';
import {
  clearEditorValues,
  clearPendingDraftSave,
  readPendingDraftSave,
  storeEditorErrors,
  storeEditorLines,
  storeEditorValues,
  storePendingDraftSave,
  type PendingDraftSave,
} from './storage.js';

export type FinalizationErrors = ReturnType<typeof splitFinalizationErrors>;
export type SaveErrors =
  | { kind: 'document'; fields: FieldErrors }
  | ({ kind: 'finalization' } & FinalizationErrors);

export type SaveDraftOutcome =
  | { kind: 'auth-expired'; errors: SaveErrors | null }
  | { kind: 'failed'; errors: SaveErrors | null; message: string; navigateTo: string | null }
  | { kind: 'saved'; document: DocumentData; message: string; navigateTo: string | null }
  | { kind: 'incomplete-draft'; document: DocumentData; lines: LineValues[]; message: string; navigateTo: string | null }
  | {
    kind: 'finalize-rejected';
    refreshed: { document: DocumentData; lines: LineValues[] } | null;
    errors: FinalizationErrors | null;
    message: string;
    navigateTo: string | null;
  };

export type SaveDraftInput = {
  ownerId: string;
  documentId?: string;
  document: DocumentData | null;
  values: DocumentValues;
  lines: LineValues[];
  hasLineErrors: boolean;
  previewAmounts?: Amounts;
  finalizeAfterSave: boolean;
};

function signature(values: DocumentValues, lines: LineValues[]): string {
  return JSON.stringify({
    values,
    lines: lines.map(({ key, id, description, quantity, unitPrice, discount, taxRate }) =>
      ({ key, id, description, quantity, unitPrice, discount, taxRate })),
  });
}

function draftBody(
  documentId: string | undefined,
  values: DocumentValues,
  lines: LineValues[],
  authoritative: DocumentData | null,
): { body: DraftSaveBody; lineKeys: string[] } {
  const savedById = new Map(authoritative?.lineItems.map(line => [line.id, line] as const) ?? []);
  const lineItems: DraftSaveBody['lineItems'] = [];
  const lineKeys: string[] = [];
  for (const line of lines) {
    const valid = previewLine(line).input;
    const saved = line.id ? savedById.get(line.id) : undefined;
    if (!valid && !saved) continue;
    lineKeys.push(line.key);
    lineItems.push(valid ? {
      ...(line.id ? { id: line.id } : {}),
      description: line.description,
      quantity: Number(valid.quantity),
      unitPriceCents: Number(valid.unitPriceCents),
      discountCents: Number(valid.discountCents),
      taxRateBasisPoints: valid.taxRateBasisPoints,
    } : {
      id: saved!.id,
      description: saved!.description,
      quantity: saved!.quantity,
      unitPriceCents: saved!.unitPriceCents,
      discountCents: saved!.discountCents,
      taxRateBasisPoints: saved!.taxRateBasisPoints,
    });
  }
  return {
    body: { mutationId: globalThis.crypto.randomUUID(), ...(documentId ? { documentId } : {}), ...values, lineItems },
    lineKeys,
  };
}

function attachServerIds(lines: LineValues[], pending: PendingDraftSave, document: DocumentData): LineValues[] {
  const idsByKey = new Map(pending.lineKeys.map((key, index) => [key, document.lineItems[index]?.id] as const));
  return lines.map(line => {
    const id = idsByKey.get(line.key);
    return id ? { ...line, id } : line;
  });
}

/** One committed aggregate save; pending request survives network loss and browser reload. */
export async function saveEditorDraft(input: SaveDraftInput): Promise<SaveDraftOutcome> {
  const { ownerId, documentId, values, hasLineErrors, previewAmounts, finalizeAfterSave } = input;
  const destination = (id: string): string | null => documentId ? null : `/documents/${encodeURIComponent(id)}`;
  const currentSignature = signature(values, input.lines);
  let localLines = input.lines;
  let authoritative = input.document;
  let pending = readPendingDraftSave(ownerId, documentId);
  let errors: SaveErrors | null = null;
  let createdDocumentId: string | undefined;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!pending) {
        const desired = draftBody(authoritative?.id ?? documentId, values, localLines, authoritative);
        pending = { ...desired, signature: currentSignature };
        storePendingDraftSave(ownerId, documentId, pending);
      }
      const response = await fetch('/documents/draft-save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pending.body),
      });
      if (response.status === 401) return { kind: 'auth-expired', errors };
      if (!response.ok) {
        const error = await responseError(response);
        const submittedLines = pending.lineKeys.map(key => localLines.find(line => line.key === key) ?? { ...newLineValues(), key });
        clearPendingDraftSave(ownerId, documentId);
        errors = response.status === 422
          ? { kind: 'finalization', ...splitFinalizationErrors(error.fields ?? {}, submittedLines) }
          : null;
        return { kind: 'failed', errors, message: error.message ?? 'Could not save this draft.', navigateTo: null };
      }

      const saved = await response.json() as DocumentData;
      localLines = attachServerIds(localLines, pending, saved);
      authoritative = saved;
      clearPendingDraftSave(ownerId, documentId);
      if (pending.signature === currentSignature) break;
      pending = null;
    }

    const saved = authoritative!;
    if (!documentId) {
      createdDocumentId = saved.id;
      storeEditorValues(ownerId, saved.id, values);
      storeEditorLines(ownerId, saved.id, localLines);
      clearEditorValues(ownerId);
    }
    const savedLineKeys = pending?.lineKeys ?? [];
    const documentUrl = `/documents/${encodeURIComponent(saved.id)}`;
    if (finalizeAfterSave && (hasLineErrors || !previewAmounts)) {
      clearEditorValues(ownerId, documentId);
      storeEditorValues(ownerId, saved.id, {
        title: saved.title, customerName: saved.customerName, issueDate: saved.issueDate,
      });
      storeEditorLines(ownerId, saved.id, localLines);
      storeEditorErrors(ownerId, saved.id, { document: {}, lines: {}, submitted: true });
      return {
        kind: 'incomplete-draft', document: saved, lines: localLines,
        message: hasLineErrors ? 'Fix line item fields before finalizing. Draft saved.' : 'Draft saved. Correct amounts before finalizing.',
        navigateTo: destination(saved.id),
      };
    }

    if (finalizeAfterSave) {
      const finalizeResponse = await fetch(`${documentUrl}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      if (finalizeResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!finalizeResponse.ok) {
        const error = await responseError(finalizeResponse);
        let finalizationErrors: FinalizationErrors | null = null;
        if (finalizeResponse.status === 422 && error.fields) {
          const savedLines = savedLineKeys.map(key => localLines.find(line => line.key === key) ?? { ...newLineValues(), key });
          finalizationErrors = splitFinalizationErrors(error.fields, savedLines);
          errors = { kind: 'finalization', ...finalizationErrors };
          storeEditorErrors(ownerId, saved.id, { ...finalizationErrors, submitted: true });
        }
        const detailResponse = await fetch(documentUrl);
        if (detailResponse.status === 401) return { kind: 'auth-expired', errors };
        let refreshed: { document: DocumentData; lines: LineValues[] } | null = null;
        if (detailResponse.ok) {
          const current = await detailResponse.json() as DocumentData;
          const currentLines = current.status === 'draft' ? localLines : lineValuesFromDocument(current);
          refreshed = { document: current, lines: currentLines };
          if (!documentId) clearEditorValues(ownerId);
          storeEditorValues(ownerId, saved.id, { title: current.title, customerName: current.customerName, issueDate: current.issueDate });
          storeEditorLines(ownerId, saved.id, currentLines);
        }
        return {
          kind: 'finalize-rejected', refreshed, errors: finalizationErrors,
          message: error.message ?? 'Could not finalize this document. Your draft stays editable.', navigateTo: destination(saved.id),
        };
      }
      authoritative = await finalizeResponse.json() as DocumentData;
    }

    clearEditorValues(ownerId, documentId);
    clearEditorValues(ownerId, saved.id);
    return {
      kind: 'saved', document: authoritative!,
      message: finalizeAfterSave ? 'Document finalized. This snapshot cannot be changed.' : 'Draft saved.',
      navigateTo: destination(saved.id),
    };
  } catch {
    return {
      kind: 'failed', errors, message: 'Connection failed. Your input is still here. Try again.',
      navigateTo: createdDocumentId ? destination(createdDocumentId) : null,
    };
  }
}
