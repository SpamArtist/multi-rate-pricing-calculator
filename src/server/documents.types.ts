import type { LinePricingInput } from '../shared/types/pricing.js';
import type { DraftLineInput } from '../shared/types/draft-line.js';

export type DocumentFields = {
  title: string;
  customerName: string;
  issueDate: string;
};

export type ParsedLineValues = Partial<{
  description: string;
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
  position: number;
}>;

export type CompleteLineInput = LinePricingInput & { description: string };

export type DraftLineMutation =
  | { kind: 'missing' }
  | { kind: 'finalized' }
  | { kind: 'draft'; documentId: string; lines: (DraftLineInput & { id: string })[] };
