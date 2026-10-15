import type { Amounts, DocumentData, DraftSaveBody } from '../api/contracts.js';
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

export type SaveErrors = ReturnType<typeof splitFinalizationErrors>;
export type SaveDraftOutcome = {
  kind: 'saved' | 'failed' | 'uncertain' | 'auth-expired';
  errors: SaveErrors | null;
  message: string;
  documentId: string | null;
};

export type SaveCheckpoint = {
  document: DocumentData;
  values: DocumentValues;
  lines: LineValues[];
};

export type SaveDraftInput = {
  document: DocumentData | null;
  values: DocumentValues;
  lines: LineValues[];
  hasLineErrors: boolean;
  previewAmounts?: Amounts;
  finalizeAfterSave: boolean;
};

type SavePhase =
  | { kind: 'ready' }
  | { kind: 'saving'; request: PendingDraftSave }
  | { kind: 'finalizing'; document: DocumentData };

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

function requestDefinitelyRejected(status: number): boolean {
  // Timeout, retry, and server errors cannot prove that the write did not commit.
  return status < 500 && status !== 408 && status !== 425 && status !== 429;
}

/** Own live mutation identity; browser storage only adds recovery across reloads. */
export function createDraftSaver(ownerId: string, documentId?: string) {
  const recovered = readPendingDraftSave(ownerId, documentId);
  let phase: SavePhase = recovered ? { kind: 'saving', request: recovered } : { kind: 'ready' };
  let recoveryDocumentId = documentId;

  return async function saveEditorDraft(
    input: SaveDraftInput,
    onCheckpoint: (checkpoint: SaveCheckpoint) => void,
  ): Promise<SaveDraftOutcome> {
    const { values, hasLineErrors, previewAmounts, finalizeAfterSave } = input;
    const currentSignature = signature(values, input.lines);
    let localLines = input.lines;
    let authoritative = input.document;

    function outcome(kind: SaveDraftOutcome['kind'], message = '', errors: SaveErrors | null = null): SaveDraftOutcome {
      return {
        kind, message, errors,
        documentId: recoveryDocumentId ?? null,
      };
    }

    // Every acknowledgement updates the live editor and recovery before any later request.
    function checkpoint(document: DocumentData, nextValues: DocumentValues, nextLines: LineValues[]): void {
      storeEditorValues(ownerId, document.id, nextValues);
      storeEditorLines(ownerId, document.id, nextLines);
      clearPendingDraftSave(ownerId, recoveryDocumentId);
      if (recoveryDocumentId !== document.id) clearEditorValues(ownerId, recoveryDocumentId);
      recoveryDocumentId = document.id;
      authoritative = document;
      localLines = nextLines;
      onCheckpoint({ document, values: nextValues, lines: nextLines });
    }

    function complete(document: DocumentData): SaveDraftOutcome {
      checkpoint(document, {
        title: document.title, customerName: document.customerName, issueDate: document.issueDate,
      }, lineValuesFromDocument(document));
      phase = { kind: 'ready' };
      clearEditorValues(ownerId, document.id);
      return outcome('saved', document.status === 'finalized'
        ? 'Document finalized. This snapshot cannot be changed.' : 'Draft saved.');
    }

    // A failed finalization response does not prove the document is still editable.
    async function reconcile(document: DocumentData): Promise<SaveDraftOutcome | null> {
      try {
        const response = await fetch(`/documents/${encodeURIComponent(document.id)}`);
        if (response.status === 401) return outcome('auth-expired');
        if (response.ok) {
          const current = await response.json() as DocumentData;
          if (current.status === 'finalized') return complete(current);
          checkpoint(current, values, localLines);
          phase = { kind: 'ready' };
          return null;
        }
      } catch {
        // Keep the finalizing phase so the next attempt reads before it writes.
      }
      return outcome('uncertain', 'Could not confirm finalization. Check your connection and try again to check document status.');
    }

    if (phase.kind === 'finalizing') {
      const result = await reconcile(phase.document);
      if (result) return result;
    }

    try {
      let savedLineKeys: string[] = [];
      // Replay an outstanding request first, then save later edits with its acknowledged IDs.
      while (true) {
        const request: PendingDraftSave = phase.kind === 'saving' ? phase.request : {
          ...draftBody(authoritative?.id ?? recoveryDocumentId, values, localLines, authoritative),
          signature: currentSignature,
        };
        phase = { kind: 'saving', request };
        storePendingDraftSave(ownerId, recoveryDocumentId, request);
        const response = await fetch('/documents/draft-save', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body),
        });
        if (response.status === 401) return outcome('auth-expired');
        if (!response.ok) {
          const error = await responseError(response);
          if (requestDefinitelyRejected(response.status)) {
            phase = { kind: 'ready' };
            clearPendingDraftSave(ownerId, recoveryDocumentId);
          }
          if (response.status === 409 && error.code === 'invalid_state' && authoritative) {
            phase = { kind: 'finalizing', document: authoritative };
            return await reconcile(authoritative) ?? outcome('failed', error.message ?? 'Could not save this draft.');
          }
          const submittedLines = request.lineKeys.map(key => localLines.find(line => line.key === key) ?? { ...newLineValues(), key });
          return outcome('failed', error.message ?? 'Could not save this draft.', response.status === 422
            ? splitFinalizationErrors(error.fields ?? {}, submittedLines) : null);
        }
        const saved = await response.json() as DocumentData;
        savedLineKeys = request.lineKeys;
        checkpoint(saved, values, attachServerIds(localLines, request, saved));
        phase = { kind: 'ready' };
        if (request.signature === currentSignature) break;
      }

      const saved = authoritative!;
      if (!finalizeAfterSave) return complete(saved);
      if (hasLineErrors || !previewAmounts) {
        storeEditorErrors(ownerId, saved.id, { document: {}, lines: {}, submitted: true });
        return outcome('failed', hasLineErrors
          ? 'Fix line item fields before finalizing. Draft saved.' : 'Draft saved. Correct amounts before finalizing.');
      }

      phase = { kind: 'finalizing', document: saved };
      const response = await fetch(`/documents/${encodeURIComponent(saved.id)}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      if (response.ok) return complete(await response.json() as DocumentData);
      if (response.status === 401) {
        phase = { kind: 'ready' };
        return outcome('auth-expired');
      }
      const error = await responseError(response);
      if (response.status === 422) {
        phase = { kind: 'ready' };
        const savedLines = savedLineKeys.map(key => localLines.find(line => line.key === key) ?? { ...newLineValues(), key });
        const errors = splitFinalizationErrors(error.fields ?? {}, savedLines);
        storeEditorErrors(ownerId, saved.id, { ...errors, submitted: true });
        return outcome('failed', error.message ?? 'Could not finalize this document.', errors);
      }
      return await reconcile(saved)
        ?? outcome('failed', error.message ?? 'Could not finalize this document. Your draft stays editable.');
    } catch {
      if (phase.kind === 'finalizing') {
        return await reconcile(phase.document)
          ?? outcome('failed', 'Finalization was not confirmed. Your draft stays editable. Try again.');
      }
      return outcome('failed', 'Connection failed. Your input is still here. Try again.');
    }
  };
}
