import type { DraftLineInput } from '../shared/types/draft-line.js';

export type DraftSaveInput = {
  mutationId: string;
  documentId?: string;
  title: string;
  customerName: string;
  issueDate: string;
  lineItems: DraftLineInput[];
};
