import { isCalendarDate } from '../../shared/document-validation.js';
import { amountsWithinSafeRange, calculateDocumentAmounts, calculateLineAmounts, MAX_SAFE_AMOUNT } from '../../shared/pricing.js';
import type { Amounts, DocumentData, FieldErrors } from '../api/contracts.js';

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

export function newLineValues(): LineValues {
  return {
    key: globalThis.crypto.randomUUID(),
    description: '',
    quantity: '1',
    unitPrice: '0.00',
    discount: '0.00',
    taxRate: '0.00',
  };
}

export function lineValuesFromDocument(document: DocumentData): LineValues[] {
  return document.lineItems.map(line => ({
    key: line.id,
    id: line.id,
    description: line.description,
    quantity: String(line.quantity),
    unitPrice: centsToInput(line.unitPriceCents),
    discount: centsToInput(line.discountCents),
    taxRate: `${Math.floor(line.taxRateBasisPoints / 100)}.${String(line.taxRateBasisPoints % 100).padStart(2, '0')}`,
    amounts: line.amounts,
  }));
}

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function parseMoneyInput(value: string): bigint | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= MAX_SAFE_AMOUNT ? cents : null;
}

function parseQuantityInput(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = BigInt(normalized);
  return quantity > 0n && quantity <= MAX_SAFE_AMOUNT ? quantity : null;
}

function parseTaxInput(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return basisPoints <= 10_000n ? Number(basisPoints) : null;
}

export type LineInputErrors = Partial<Record<'quantity' | 'unitPrice' | 'discount' | 'taxRate', string>>;
export type LinePreview = { errors: LineInputErrors; amounts?: Amounts; input?: {
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
} };

export function previewLine(line: LineValues, useSnapshot = false): LinePreview {
  if (useSnapshot && line.amounts) return { errors: {}, amounts: line.amounts };

  const errors: LineInputErrors = {};
  const quantity = parseQuantityInput(line.quantity);
  const unitPriceCents = parseMoneyInput(line.unitPrice);
  const discountCents = parseMoneyInput(line.discount);
  const taxRateBasisPoints = parseTaxInput(line.taxRate);
  if (quantity === null) errors.quantity = 'Enter a positive whole quantity.';
  if (unitPriceCents === null) errors.unitPrice = 'Enter a EUR amount with up to two decimals.';
  if (discountCents === null) errors.discount = 'Enter a EUR amount with up to two decimals.';
  if (taxRateBasisPoints === null) errors.taxRate = 'Enter a tax rate from 0 to 100.00%.';
  if (Object.keys(errors).length > 0 || quantity === null || unitPriceCents === null || discountCents === null || taxRateBasisPoints === null) {
    return { errors };
  }

  const input = { quantity, unitPriceCents, discountCents, taxRateBasisPoints };
  const amounts = calculateLineAmounts(input);
  if (discountCents > amounts.subtotalCents) {
    errors.discount = 'Discount cannot exceed the line subtotal.';
  }
  if (!amountsWithinSafeRange(amounts)) {
    errors.unitPrice = 'Line amounts exceed the supported safe integer range.';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    input,
    amounts: {
      subtotalCents: Number(amounts.subtotalCents),
      discountCents: Number(amounts.discountCents),
      taxableCents: Number(amounts.taxableCents),
      taxCents: Number(amounts.taxCents),
      totalCents: Number(amounts.totalCents),
    },
  };
}

export function documentFieldErrors(values: DocumentValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.title.trim()) errors.title = 'Enter a document name.';
  if (!isCalendarDate(values.issueDate)) errors.issueDate = 'Enter a valid issue date.';
  return errors;
}

export function lineFieldErrors(fields?: FieldErrors): Partial<Record<EditableLineField, string>> {
  if (!fields) return {};
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.quantity ? { quantity: fields.quantity } : {}),
    ...(fields.unitPriceCents ? { unitPrice: fields.unitPriceCents } : {}),
    ...(fields.discountCents ? { discount: fields.discountCents } : {}),
    ...(fields.taxRateBasisPoints ? { taxRate: fields.taxRateBasisPoints } : {}),
  };
}

export function splitFinalizationErrors(
  fields: FieldErrors,
  lines: LineValues[],
): { document: FieldErrors; lines: Record<string, Partial<Record<EditableLineField, string>>> } {
  const document: FieldErrors = {};
  const lineErrors: Record<string, Partial<Record<EditableLineField, string>>> = {};
  const fieldNames: Record<string, EditableLineField> = {
    description: 'description',
    quantity: 'quantity',
    unitPriceCents: 'unitPrice',
    discountCents: 'discount',
    taxRateBasisPoints: 'taxRate',
  };

  for (const [path, message] of Object.entries(fields)) {
    const match = /^lineItems\[(\d+)\]\.([A-Za-z]+)$/.exec(path);
    if (!match) {
      document[path] = message;
      continue;
    }
    const line = lines[Number(match[1])];
    const field = fieldNames[match[2]];
    if (!line || !field) {
      document[path] = message;
      continue;
    }
    lineErrors[line.key] = { ...lineErrors[line.key], [field]: message };
  }
  return { document, lines: lineErrors };
}

export function previewDocumentAmounts(previews: LinePreview[]): Amounts | undefined {
  if (previews.some(preview => Object.keys(preview.errors).length > 0)) return undefined;
  const exact = calculateDocumentAmounts(previews.flatMap(preview => preview.input ? [preview.input] : []));
  if (!amountsWithinSafeRange(exact)) return undefined;
  return {
    subtotalCents: Number(exact.subtotalCents),
    discountCents: Number(exact.discountCents),
    taxableCents: Number(exact.taxableCents),
    taxCents: Number(exact.taxCents),
    totalCents: Number(exact.totalCents),
  };
}
