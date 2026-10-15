import type { DocumentData } from '../api/contracts.js';
import { lineValuesFromDocument, type DocumentValues, type LineValues, type PersistedEditorErrors } from './model.js';

const EDITOR_STORAGE_PREFIX = 'pricing-calculator:editor:';

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

/** Restore the editable browser copy while retaining authoritative line amounts. */
export function restoreEditor(ownerId: string, documentId: string, document: DocumentData) {
  const values = readEditorValues(ownerId, documentId) ?? {
    title: document.title,
    customerName: document.customerName,
    issueDate: document.issueDate,
  };
  const savedLines = lineValuesFromDocument(document);
  const recoveredLines = readEditorLines(ownerId, documentId);
  const savedIds = new Set(savedLines.map(line => line.id));
  const recoveredLineIds = new Set(recoveredLines?.flatMap(line => line.id ? [line.id] : []) ?? []);
  const recoveredSavedLines = recoveredLines?.filter(line => line.id && savedIds.has(line.id)) ?? [];
  const savedById = new Map(savedLines.flatMap(line => line.id ? [[line.id, line] as const] : []));
  const restoredSavedLines = recoveredSavedLines.flatMap(line => {
    const saved = savedById.get(line.id!);
    return saved ? [{ ...saved, ...line, amounts: saved.amounts }] : [];
  });
  const restoredSavedIds = new Set(restoredSavedLines.map(line => line.id));
  const remainingSavedLines = savedLines.filter(line => !restoredSavedIds.has(line.id)
    && (!recoveredLines || Boolean(line.id && recoveredLineIds.has(line.id))));
  const unsavedLines = recoveredLines?.filter(line => !line.id || !savedIds.has(line.id)) ?? [];
  return {
    values,
    lines: [...restoredSavedLines, ...remainingSavedLines, ...unsavedLines],
    errors: readEditorErrors(ownerId, documentId),
    removedLineIds: recoveredLines
      ? savedLines.flatMap(line => line.id && !recoveredLineIds.has(line.id) ? [line.id] : [])
      : [],
  };
}
