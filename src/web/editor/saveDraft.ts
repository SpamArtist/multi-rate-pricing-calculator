import type { Amounts, DocumentData, FieldErrors } from '../api/contracts.js';
import { responseError } from '../api/client.js';
import {
  type DocumentValues,
  type LineValues,
  type LinePreview,
  lineFieldErrors,
  lineValuesFromDocument,
  splitFinalizationErrors,
} from './model.js';
import { clearEditorValues, storeEditorValues, storeEditorLines, storeEditorErrors } from './storage.js';

export type FinalizationErrors = ReturnType<typeof splitFinalizationErrors>;
export type SaveErrors =
  | { kind: 'document'; fields: FieldErrors }
  | { kind: 'line'; key: string; fields: ReturnType<typeof lineFieldErrors> }
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
  values: DocumentValues;
  lines: LineValues[];
  removedLineIds: string[];
  linePreviews: LinePreview[];
  hasLineErrors: boolean;
  previewAmounts?: Amounts;
  finalizeAfterSave: boolean;
};

/** Persist a draft and its recovery data; callers own React state and navigation. */
export async function saveEditorDraft(input: SaveDraftInput): Promise<SaveDraftOutcome> {
  const { ownerId, documentId, values, lines, removedLineIds, linePreviews, hasLineErrors, previewAmounts, finalizeAfterSave } = input;
  let createdDocumentId: string | undefined;
  let linesBeingSaved = [...lines];
  let errors: SaveErrors | null = null;
  const destination = (id: string): string | null => documentId ? null : `/documents/${encodeURIComponent(id)}`;

  try {
    const response = await fetch(documentId ? `/documents/${encodeURIComponent(documentId)}` : '/documents', {
      method: documentId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (response.status === 401) return { kind: 'auth-expired', errors };
    const result = await response.json() as DocumentData | { error?: { message?: string; fields?: FieldErrors } };
    if (!response.ok) {
      const error = (result as { error?: { message?: string; fields?: FieldErrors } }).error;
      return {
        kind: 'failed', errors: { kind: 'document', fields: error?.fields ?? {} },
        message: error?.message ?? 'Could not save this draft.', navigateTo: null,
      };
    }
    const saved = result as DocumentData;
    createdDocumentId = saved.id;
    const documentUrl = `/documents/${encodeURIComponent(saved.id)}`;
    if (!documentId) {
      clearEditorValues(ownerId);
      storeEditorValues(ownerId, saved.id, values);
      storeEditorLines(ownerId, saved.id, linesBeingSaved);
    }
    for (const [index, line] of linesBeingSaved.entries()) {
      if (line.id) continue;
      const preview = linePreviews[index];
      if (!preview.input) continue;
      const lineResponse = await fetch(`${documentUrl}/line-items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: line.description,
          quantity: Number(preview.input.quantity),
          unitPriceCents: Number(preview.input.unitPriceCents),
          discountCents: Number(preview.input.discountCents),
          taxRateBasisPoints: preview.input.taxRateBasisPoints,
        }),
      });
      if (lineResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!lineResponse.ok) {
        const error = await responseError(lineResponse);
        storeEditorLines(ownerId, saved.id, linesBeingSaved);
        return {
          kind: 'failed', errors: { kind: 'document', fields: error.fields ?? {} },
          message: error.message ?? 'Could not save a line item. Your input is still here.', navigateTo: destination(saved.id),
        };
      }
      const savedLine = await lineResponse.json() as { id: string };
      linesBeingSaved = linesBeingSaved.map((value, lineIndex) => lineIndex === index ? { ...value, id: savedLine.id } : value);
      storeEditorLines(ownerId, saved.id, linesBeingSaved);
    }

    for (const [index, line] of linesBeingSaved.entries()) {
      if (!line.id) continue;
      const preview = linePreviews[index];
      if (!preview.input) continue;
      const lineResponse = await fetch(`${documentUrl}/line-items/${encodeURIComponent(line.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: line.description,
          quantity: Number(preview.input.quantity),
          unitPriceCents: Number(preview.input.unitPriceCents),
          discountCents: Number(preview.input.discountCents),
          taxRateBasisPoints: preview.input.taxRateBasisPoints,
          position: index + 1,
        }),
      });
      if (lineResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!lineResponse.ok) {
        const error = await responseError(lineResponse);
        storeEditorLines(ownerId, saved.id, linesBeingSaved);
        return {
          kind: 'failed', errors: { kind: 'line', key: line.key, fields: lineFieldErrors(error.fields) },
          message: error.message ?? 'Could not save a line item. Your input is still here.', navigateTo: destination(saved.id),
        };
      }
      storeEditorLines(ownerId, saved.id, linesBeingSaved);
    }

    for (const removedId of removedLineIds) {
      const lineResponse = await fetch(`${documentUrl}/line-items/${encodeURIComponent(removedId)}`, { method: 'DELETE' });
      if (lineResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!lineResponse.ok && lineResponse.status !== 404) {
        const error = await responseError(lineResponse);
        storeEditorLines(ownerId, saved.id, linesBeingSaved);
        return {
          kind: 'failed', errors,
          message: error.message ?? 'Could not remove a line item. Your other input is still here.', navigateTo: destination(saved.id),
        };
      }
    }

    if (finalizeAfterSave && (hasLineErrors || !previewAmounts)) {
      const detailResponse = await fetch(documentUrl);
      if (detailResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!detailResponse.ok) {
        return { kind: 'failed', errors, message: 'Draft saved, but could not refresh its server values. Reload to get current values.', navigateTo: null };
      }
      const authoritative = await detailResponse.json() as DocumentData;
      if (!documentId) clearEditorValues(ownerId);
      storeEditorValues(ownerId, saved.id, {
        title: authoritative.title, customerName: authoritative.customerName, issueDate: authoritative.issueDate,
      });
      storeEditorLines(ownerId, saved.id, linesBeingSaved);
      storeEditorErrors(ownerId, saved.id, { document: {}, lines: {}, submitted: true });
      return {
        kind: 'incomplete-draft', document: authoritative, lines: linesBeingSaved,
        message: hasLineErrors ? 'Fix line item fields before finalizing. Draft saved.' : 'Draft saved. Correct amounts before finalizing.',
        navigateTo: destination(authoritative.id),
      };
    }

    let finalizedDocument: DocumentData | undefined;
    if (finalizeAfterSave) {
      const finalizeResponse = await fetch(`${documentUrl}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      if (finalizeResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!finalizeResponse.ok) {
        const error = await responseError(finalizeResponse);
        let finalizationErrors: FinalizationErrors | null = null;
        if (finalizeResponse.status === 422 && error.fields) {
          finalizationErrors = splitFinalizationErrors(error.fields, linesBeingSaved);
          errors = { kind: 'finalization', ...finalizationErrors };
          storeEditorErrors(ownerId, saved.id, { ...finalizationErrors, submitted: true });
        }
        const detailResponse = await fetch(documentUrl);
        if (detailResponse.status === 401) return { kind: 'auth-expired', errors };
        let refreshed: { document: DocumentData; lines: LineValues[] } | null = null;
        if (detailResponse.ok) {
          const current = await detailResponse.json() as DocumentData;
          if (!documentId) clearEditorValues(ownerId);
          const currentLines = current.status === 'draft' ? linesBeingSaved : lineValuesFromDocument(current);
          refreshed = { document: current, lines: currentLines };
          storeEditorValues(ownerId, saved.id, { title: current.title, customerName: current.customerName, issueDate: current.issueDate });
          storeEditorLines(ownerId, saved.id, currentLines);
        }
        return {
          kind: 'finalize-rejected', refreshed, errors: finalizationErrors,
          message: error.message ?? 'Could not finalize this document. Your draft stays editable.', navigateTo: destination(saved.id),
        };
      }
      finalizedDocument = await finalizeResponse.json() as DocumentData;
    }

    let authoritative = finalizedDocument;
    if (!authoritative) {
      const detailResponse = await fetch(documentUrl);
      if (detailResponse.status === 401) return { kind: 'auth-expired', errors };
      if (!detailResponse.ok) {
        return { kind: 'failed', errors, message: 'Draft saved, but could not refresh its server totals. Reload to get current values.', navigateTo: null };
      }
      authoritative = await detailResponse.json() as DocumentData;
    }
    clearEditorValues(ownerId, documentId);
    clearEditorValues(ownerId, saved.id);
    return {
      kind: 'saved', document: authoritative,
      message: finalizeAfterSave ? 'Document finalized. This snapshot cannot be changed.' : 'Draft saved.',
      navigateTo: destination(authoritative.id),
    };
  } catch {
    if (!documentId && createdDocumentId) {
      storeEditorValues(ownerId, createdDocumentId, values);
      storeEditorLines(ownerId, createdDocumentId, linesBeingSaved);
    }
    return {
      kind: 'failed', errors, message: 'Connection failed. Your input is still here. Try again.',
      navigateTo: !documentId && createdDocumentId ? destination(createdDocumentId) : null,
    };
  }
}
