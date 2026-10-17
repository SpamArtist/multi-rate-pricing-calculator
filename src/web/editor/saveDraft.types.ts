import type { Amounts, DocumentData } from '../../shared/types/api-contracts.js';
import type { splitFinalizationErrors } from './model.js';
import type { DocumentValues, LineValues } from './model.types.js';
import type { PendingDraftSave } from './storage.types.js';

export type SaveErrors = ReturnType<typeof splitFinalizationErrors>;

export type SaveDraftOutcome = {
  kind: 'saved' | 'failed' | 'uncertain' | 'auth-expired' | 'cancelled';
  errors: SaveErrors | null;
  message: string;
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

export type SavePhase =
  | { kind: 'ready' }
  | { kind: 'saving'; request: PendingDraftSave }
  | { kind: 'finalizing'; document: DocumentData };
