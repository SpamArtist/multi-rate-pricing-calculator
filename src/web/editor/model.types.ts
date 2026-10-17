import type { Amounts } from '../../shared/types/api-contracts.js';
import type { FieldErrors } from '../../shared/types/field-errors.js';

export type DocumentValues = { title: string; customerName: string; issueDate: string };

export type LineValues = {
  key: string;
  id?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRate: string;
  amounts?: Amounts;
};

export type EditableLineField = 'description' | 'quantity' | 'unitPrice' | 'discount' | 'taxRate';

export type PersistedEditorErrors = {
  document: FieldErrors;
  lines: Record<string, Partial<Record<EditableLineField, string>>>;
  submitted: boolean;
};

export type LineInputErrors = Partial<Record<'quantity' | 'unitPrice' | 'discount' | 'taxRate', string>>;

export type LinePreview = { errors: LineInputErrors; amounts?: Amounts; input?: {
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
} };
