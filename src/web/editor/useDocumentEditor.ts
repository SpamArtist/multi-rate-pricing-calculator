import React from 'react';
import type { DocumentData, FieldErrors, User } from '../api/contracts.js';
import { responseError } from '../api/client.js';
import { localToday } from '../formatting.js';
import { navigate } from '../routing.js';
import { documentFieldErrors, lineValuesFromDocument, newLineValues, previewLine, previewDocumentAmounts, type DocumentValues, type EditableLineField, type LineValues } from './model.js';
import { clearEditorErrors, clearEditorValues, readEditorLines, readEditorValues, restoreEditor, storeEditorLines, storeEditorValues } from './storage.js';
import { saveEditorDraft, type SaveErrors } from './saveDraft.js';

export type DocumentEditorProps = {
  owner: User;
  documentId?: string;
  onAuthExpired: () => void;
};

export function useDocumentEditor({ owner, documentId, onAuthExpired }: DocumentEditorProps) {
  const [document, setDocument] = React.useState<DocumentData | null>(null);
  const [values, setValues] = React.useState<DocumentValues | null>(() => documentId
    ? null
    : readEditorValues(owner.id) ?? { title: '', customerName: '', issueDate: localToday() });
  const [lines, setLines] = React.useState<LineValues[]>(() => documentId ? [] : readEditorLines(owner.id) ?? []);
  const [loading, setLoading] = React.useState(Boolean(documentId));
  const [loadError, setLoadError] = React.useState('');
  const [serverErrors, setServerErrors] = React.useState<FieldErrors>({});
  const [serverLineErrors, setServerLineErrors] = React.useState<Record<string, Partial<Record<EditableLineField, string>>>>({});
  const [message, setMessage] = React.useState('');
  const [duplicateCopyId, setDuplicateCopyId] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!documentId) return;
    let active = true;
    void fetch(`/documents/${encodeURIComponent(documentId)}`)
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (response.status === 404) throw new Error('Document not found.');
        if (!response.ok) throw new Error((await responseError(response)).message ?? 'Could not load this document.');
        return response.json() as Promise<DocumentData>;
      })
      .then(result => {
        if (!active || !result) return;
        setDocument(result);
        const restored = restoreEditor(owner.id, documentId, result);
        setValues(restored.values);
        setLines(restored.lines);
        if (restored.errors) {
          setServerErrors(restored.errors.document);
          setServerLineErrors(restored.errors.lines);
          setSubmitted(restored.errors.submitted);
        }
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : 'Could not load this document.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [documentId, onAuthExpired, owner.id]);

  const localErrors = values ? documentFieldErrors(values) : {};
  const linePreviews = lines.map(line => previewLine(line, document?.status === 'finalized'));
  const hasLineErrors = linePreviews.some(preview => Object.keys(preview.errors).length > 0);
  const previewAmounts = previewDocumentAmounts(linePreviews);
  const titleError = serverErrors.title ?? (submitted ? localErrors.title : undefined);
  const dateError = serverErrors.issueDate ?? (submitted ? localErrors.issueDate : undefined);
  const customerError = serverErrors.customerName;
  const lineItemsError = serverErrors.lineItems;
  const canEdit = !document || document.status === 'draft';
  const canMutate = canEdit && !pending;
  const statusLabel = !document ? 'Unsaved document' : document.status === 'draft' ? 'Editable draft' : 'Fixed snapshot';

  function changeField(field: keyof DocumentValues, value: string): void {
    if (!canMutate || !values) return;
    const next = { ...values, [field]: value };
    setValues(next);
    storeEditorValues(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerErrors(current => {
      const updated = { ...current };
      delete updated[field];
      return updated;
    });
    setMessage('');
  }

  function changeLine(key: string, field: EditableLineField, value: string): void {
    if (!canMutate) return;
    const next = lines.map(line => line.key === key ? { ...line, [field]: value } : line);
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerLineErrors(current => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    setMessage('');
  }

  function moveLine(key: string, direction: -1 | 1): void {
    if (!canMutate) return;
    const index = lines.findIndex(line => line.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= lines.length) return;
    const next = [...lines];
    [next[index], next[target]] = [next[target], next[index]];
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    setMessage('');
  }

  function removeLine(key: string): void {
    if (!canMutate) return;
    const removed = lines.find(line => line.key === key);
    if (!removed) return;
    const next = lines.filter(line => line.key !== key);
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerLineErrors(current => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    setMessage('');
  }

  function addLine(): void {
    if (!canMutate) return;
    const next = [...lines, newLineValues()];
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerErrors(current => {
      const updated = { ...current };
      delete updated.lineItems;
      return updated;
    });
    setSubmitted(false);
    setMessage('');
  }

  function applySaveErrors(errors: SaveErrors | null): void {
    if (!errors) return;
    switch (errors.kind) {
      case 'document':
        setServerErrors(errors.fields);
        break;
      case 'finalization':
        setServerErrors(errors.document);
        setServerLineErrors(errors.lines);
        break;
    }
  }

  async function saveDraft(finalizeAfterSave = false): Promise<void> {
    if (!canMutate || !values) return;
    setSubmitted(true);
    setMessage('');
    clearEditorErrors(owner.id, documentId);
    setServerErrors({});
    setServerLineErrors({});
    if (Object.keys(documentFieldErrors(values)).length > 0) return;
    if ((hasLineErrors || !previewAmounts) && !finalizeAfterSave) {
      setMessage(hasLineErrors ? 'Check line item fields before saving.' : 'Document amounts exceed the supported safe integer range.');
      return;
    }
    setPending(true);
    try {
      const outcome = await saveEditorDraft({
        ownerId: owner.id, documentId, document, values, lines,
        hasLineErrors, previewAmounts, finalizeAfterSave,
      });
      switch (outcome.kind) {
        case 'auth-expired':
          applySaveErrors(outcome.errors);
          if (outcome.navigateTo) navigate(outcome.navigateTo);
          onAuthExpired();
          return;
        case 'failed':
          applySaveErrors(outcome.errors);
          break;
        case 'saved':
          setDocument(outcome.document);
          setValues({ title: outcome.document.title, customerName: outcome.document.customerName, issueDate: outcome.document.issueDate });
          setLines(lineValuesFromDocument(outcome.document));
          setServerLineErrors({});
          setSubmitted(false);
          setServerErrors({});
          break;
        case 'incomplete-draft':
          setDocument(outcome.document);
          setValues({ title: outcome.document.title, customerName: outcome.document.customerName, issueDate: outcome.document.issueDate });
          setLines(outcome.lines);
          setServerLineErrors({});
          setSubmitted(true);
          break;
        case 'finalize-rejected':
          if (outcome.errors) {
            setServerErrors(outcome.errors.document);
            setServerLineErrors(outcome.errors.lines);
          }
          if (outcome.refreshed) {
            const { document, lines } = outcome.refreshed;
            setDocument(document);
            setValues({ title: document.title, customerName: document.customerName, issueDate: document.issueDate });
            setLines(lines);
          }
          setSubmitted(true);
          break;
      }
      setMessage(outcome.message);
      if (outcome.navigateTo) navigate(outcome.navigateTo);
    } finally {
      setPending(false);
    }
  }

  async function duplicateDocument(): Promise<void> {
    if (!documentId || !document || pending) return;
    setPending(true);
    setMessage('');
    setDuplicateCopyId(null);
    try {
      const response = await fetch(`/documents/${encodeURIComponent(documentId)}/duplicate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueDate: localToday() }),
      });
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      const result = await response.json() as DocumentData | { error?: { message?: string } };
      if (!response.ok) {
        setMessage((result as { error?: { message?: string } }).error?.message ?? 'Could not duplicate this document.');
        return;
      }
      const copy = result as DocumentData;
      setDuplicateCopyId(copy.id);
      setMessage('Draft duplicated.');
    } catch {
      setMessage('Connection failed. Source document stays open. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function deleteDraft(): Promise<void> {
    if (!documentId || !document || document.status !== 'draft' || pending) return;
    if (!window.confirm('Delete this draft and all its lines permanently?')) return;

    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      if (response.status === 404 || response.status === 409) {
        navigate('/documents');
        return;
      }
      if (!response.ok) {
        const error = await responseError(response);
        setMessage(error.message ?? 'Could not delete this draft. Try again.');
        return;
      }
      clearEditorValues(owner.id, documentId);
      navigate('/documents');
    } catch {
      setMessage('Connection failed. Draft stays saved. Try again.');
    } finally {
      setPending(false);
    }
  }

  const amounts = document?.status === 'finalized'
    ? document.amounts
    : previewAmounts;
  const successMessage = message === 'Draft saved.' || message === 'Draft duplicated.' || message.startsWith('Document finalized.');

  return {
    document, values, lines, loading, loadError, message, duplicateCopyId, submitted, pending,
    linePreviews, titleError, dateError, customerError, lineItemsError, serverLineErrors,
    canEdit, canMutate, statusLabel, amounts, successMessage,
    changeField, changeLine, moveLine, removeLine, addLine, saveDraft, duplicateDocument, deleteDraft,
  };
}
