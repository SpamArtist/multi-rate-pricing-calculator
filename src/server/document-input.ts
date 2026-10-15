import { isCalendarDate } from '../shared/document-validation.js';
import { calculatePricing, type LinePricingInput } from '../shared/pricing.js';

export type Fields = Record<string, string>;

export const inputError = {
  unknown: 'This field is not allowed.',
  title: 'Enter a document name.',
  customerName: 'Enter a customer name.',
  issueDate: 'Enter a valid calendar date.',
  description: 'Enter a line description.',
  quantity: 'Enter a positive whole quantity.',
  amount: 'Enter a nonnegative whole amount in cents.',
  taxRateBasisPoints: 'Enter a whole tax rate from 0 to 10000 basis points.',
  position: 'Enter a valid line position.',
  discount: 'Discount cannot exceed the line subtotal.',
  lineRange: 'Line amounts exceed the supported safe integer range.',
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_DATABASE_INTEGER = 2_147_483_647;

export function fields(): Fields {
  return Object.create(null) as Fields;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], errors: Fields, prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors[`${prefix}${key}`] = inputError.unknown;
  }
}

export function parseUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

export function parseTitle(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function parseCustomerName(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

export function parseIssueDate(value: unknown): string | undefined {
  return isCalendarDate(value) ? value : undefined;
}

export function parseDescription(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

export function parseQuantity(value: unknown): bigint | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? BigInt(value) : undefined;
}

export function parseAmount(value: unknown): bigint | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

export function parseTaxRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

export function parsePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_DATABASE_INTEGER ? value : undefined;
}

export function linePricingErrors(input: LinePricingInput): Fields {
  const errors = fields();
  const priced = calculatePricing([input]).lines[0];
  if (priced.discountExceedsSubtotal) errors.discountCents = inputError.discount;
  if (!priced.withinSafeRange) errors.body = inputError.lineRange;
  return errors;
}
