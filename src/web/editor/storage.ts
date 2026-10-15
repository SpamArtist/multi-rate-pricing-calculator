import type { DocumentData, DraftSaveBody } from '../api/contracts.js';
import { lineValuesFromDocument, type DocumentValues, type LineValues, type PersistedEditorErrors } from './model.js';

const EDITOR_STORAGE_PREFIX = 'pricing-calculator:editor:';

export type PendingDraftSave = {
  body: DraftSaveBody;
  lineKeys: string[];
  signature: string;
};

function pendingSaveKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:pending-save`;
}

export function readPendingDraftSave(ownerId: string, documentId?: string): PendingDraftSave | null {
  try {
    const raw = window.sessionStorage.getItem(pendingSaveKey(ownerId, documentId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingDraftSave>;
    if (!value.body || typeof value.body.mutationId !== 'string' || !Array.isArray(value.body.lineItems)
      || !Array.isArray(value.lineKeys) || typeof value.signature !== 'string') return null;
    return value as PendingDraftSave;
  } catch {
    return null;
  }
}

export function storePendingDraftSave(ownerId: string, documentId: string | undefined, pending: PendingDraftSave): void {
  try {
    window.sessionStorage.setItem(pendingSaveKey(ownerId, documentId), JSON.stringify(pending));
  } catch {
    // Live form state remains available when browser storage is unavailable.
  }
}

export function clearPendingDraftSave(ownerId: string, documentId?: string): void {
  try {
    window.sessionStorage.removeItem(pendingSaveKey(ownerId, documentId));
  } catch {
    // Nothing to clear when browser storage is unavailable.
  }
}

function lineStorageKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:lines`;
}

function editorErrorsKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:errors`;
}

export function readEditorLines(ownerId: string, documentId?: string): LineValues[] | null {
  try {
    const stored = window.sessionStorage.getItem(lineStorageKey(ownerId, documentId));
    if (!stored) return null;
    const lines = JSON.parse(stored) as unknown;
    if (!Array.isArray(lines)) return null;
    return lines.filter((line): line is LineValues => isLineValues(line));
  } catch {
    return null;
  }
}

function isLineValues(value: unknown): value is LineValues {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<LineValues>;
  return typeof line.key === 'string'
    && (line.id === undefined || typeof line.id === 'string')
    && typeof line.description === 'string'
    && typeof line.quantity === 'string'
    && typeof line.unitPrice === 'string'
    && typeof line.discount === 'string'
    && typeof line.taxRate === 'string'
    && (line.amounts === undefined || typeof line.amounts === 'object');
}

export function storeEditorLines(ownerId: string, documentId: string | undefined, lines: LineValues[]): void {
  try {
    window.sessionStorage.setItem(lineStorageKey(ownerId, documentId), JSON.stringify(lines));
  } catch {
    // Live form state remains available when browser storage is unavailable.
  }
}

function readEditorErrors(ownerId: string, documentId?: string): PersistedEditorErrors | null {
  try {
    const stored = window.sessionStorage.getItem(editorErrorsKey(ownerId, documentId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PersistedEditorErrors>;
    if (!value.document || !value.lines || typeof value.submitted !== 'boolean') return null;
    return value as PersistedEditorErrors;
  } catch {
    return null;
  }
}

export function storeEditorErrors(ownerId: string, documentId: string | undefined, errors: PersistedEditorErrors): void {
  try {
    window.sessionStorage.setItem(editorErrorsKey(ownerId, documentId), JSON.stringify(errors));
  } catch {
    // Live form state remains available when browser storage is unavailable.
  }
}

export function clearEditorErrors(ownerId: string, documentId?: string): void {
  try {
    window.sessionStorage.removeItem(editorErrorsKey(ownerId, documentId));
  } catch {
    // Nothing to clear when browser storage is unavailable.
  }
}

function editorStorageKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}`;
}

export function readEditorValues(ownerId: string, documentId?: string): DocumentValues | null {
  try {
    const stored = window.sessionStorage.getItem(editorStorageKey(ownerId, documentId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<DocumentValues>;
    if (typeof value.title !== 'string' || typeof value.customerName !== 'string' || typeof value.issueDate !== 'string') return null;
    return { title: value.title, customerName: value.customerName, issueDate: value.issueDate };
  } catch {
    return null;
  }
}

export function storeEditorValues(ownerId: string, documentId: string | undefined, values: DocumentValues): void {
  try {
    window.sessionStorage.setItem(editorStorageKey(ownerId, documentId), JSON.stringify(values));
  } catch {
    // Browser storage can be unavailable; the live form still keeps its input.
  }
}

export function clearEditorValues(ownerId: string, documentId?: string): void {
  try {
    window.sessionStorage.removeItem(editorStorageKey(ownerId, documentId));
    window.sessionStorage.removeItem(lineStorageKey(ownerId, documentId));
    clearPendingDraftSave(ownerId, documentId);
    clearEditorErrors(ownerId, documentId);
  } catch {
    // The server copy remains authoritative after a successful save.
  }
}

export function clearUserEditorValues(ownerId: string): void {
  try {
    const prefix = `${EDITOR_STORAGE_PREFIX}${ownerId}:`;
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing to clear when browser storage is unavailable.
  }
}

/** Restore draft edits; finalized snapshots always use authoritative content. */
export function restoreEditor(ownerId: string, documentId: string, document: DocumentData) {
  if (document.status === 'finalized') {
    clearEditorValues(ownerId, documentId);
    return {
      values: { title: document.title, customerName: document.customerName, issueDate: document.issueDate },
      lines: lineValuesFromDocument(document),
      errors: null,
    };
  }
  const values = readEditorValues(ownerId, documentId) ?? {
    title: document.title,
    customerName: document.customerName,
    issueDate: document.issueDate,
  };
  const savedLines = lineValuesFromDocument(document);
  const recoveredLines = readEditorLines(ownerId, documentId);
  const savedById = new Map(savedLines.flatMap(line => line.id ? [[line.id, line] as const] : []));
  const restoredLines = recoveredLines?.map(line => {
    const saved = line.id ? savedById.get(line.id) : undefined;
    return saved ? { ...saved, ...line, amounts: saved.amounts } : line;
  }) ?? savedLines;
  return {
    values,
    lines: restoredLines,
    errors: readEditorErrors(ownerId, documentId),
  };
}
