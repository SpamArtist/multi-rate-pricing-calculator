import type { DraftSaveBody } from '../../shared/types/api-contracts.js';

export type PendingDraftSave = {
  body: DraftSaveBody;
  lineKeys: string[];
  signature: string;
};
