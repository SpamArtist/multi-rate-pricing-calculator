import type { DocumentRow, LineRow } from './document-projection.types.js';
import { asc, eq, inArray } from 'drizzle-orm';
import { lineItems } from './schema.js';
import type { TenantTransaction } from './client.types.js';
import { calculatePricing, MAX_SAFE_AMOUNT } from '../shared/pricing.js';
import type { ExactAmounts, LinePricingInput } from '../shared/types/pricing.js';

export function databaseLineInput(line: LineRow): LinePricingInput & { description: string } {
  return {
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountCents: line.discountCents,
    taxRateBasisPoints: line.taxRateBasisPoints,
  };
}

function toSafeNumber(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_AMOUNT) throw new RangeError('Document amount exceeds the safe integer range.');
  return Number(value);
}

function jsonAmounts(amounts: ExactAmounts) {
  return {
    subtotalCents: toSafeNumber(amounts.subtotalCents),
    discountCents: toSafeNumber(amounts.discountCents),
    taxableCents: toSafeNumber(amounts.taxableCents),
    taxCents: toSafeNumber(amounts.taxCents),
    totalCents: toSafeNumber(amounts.totalCents),
  };
}

function documentSnapshot(row: DocumentRow): ExactAmounts {
  if (row.finalizedSubtotalCents === null || row.finalizedDiscountCents === null
    || row.finalizedTaxableCents === null || row.finalizedTaxCents === null || row.finalizedTotalCents === null) {
    throw new RangeError('Finalized document snapshot is incomplete.');
  }
  return {
    subtotalCents: row.finalizedSubtotalCents,
    discountCents: row.finalizedDiscountCents,
    taxableCents: row.finalizedTaxableCents,
    taxCents: row.finalizedTaxCents,
    totalCents: row.finalizedTotalCents,
  };
}

function lineSnapshot(line: LineRow): ExactAmounts {
  if (line.finalizedSubtotalCents === null || line.finalizedTaxableCents === null
    || line.finalizedTaxCents === null || line.finalizedTotalCents === null) {
    throw new RangeError('Finalized line snapshot is incomplete.');
  }
  return {
    subtotalCents: line.finalizedSubtotalCents,
    discountCents: line.discountCents,
    taxableCents: line.finalizedTaxableCents,
    taxCents: line.finalizedTaxCents,
    totalCents: line.finalizedTotalCents,
  };
}

export function serializeLineItem(line: LineRow, amounts: ExactAmounts = calculatePricing([databaseLineInput(line)]).lines[0].amounts) {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: toSafeNumber(line.quantity),
    unitPriceCents: toSafeNumber(line.unitPriceCents),
    discountCents: toSafeNumber(line.discountCents),
    taxRateBasisPoints: line.taxRateBasisPoints,
    amounts: jsonAmounts(amounts),
  };
}

export async function serializeDocument(transaction: TenantTransaction, row: DocumentRow) {
  const lines = await transaction.select().from(lineItems)
    .where(eq(lineItems.documentId, row.id))
    .orderBy(asc(lineItems.position), asc(lineItems.id));
  const finalized = row.status === 'finalized';
  const pricing = finalized ? undefined : calculatePricing(lines.map(databaseLineInput));
  const lineItemsResponse = lines.map((line, index) => serializeLineItem(
    line, finalized ? lineSnapshot(line) : pricing!.lines[index].amounts,
  ));
  return {
    id: row.id,
    title: row.title,
    customerName: row.customerName,
    issueDate: row.issueDate,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    lineItems: lineItemsResponse,
    amounts: jsonAmounts(finalized ? documentSnapshot(row) : pricing!.amounts),
  };
}

export async function projectDocumentSummaries(transaction: TenantTransaction, rows: DocumentRow[]) {
  const draftIds = rows.filter(row => row.status === 'draft').map(row => row.id);
  const draftLines = draftIds.length === 0 ? [] : await transaction.select().from(lineItems)
    .where(inArray(lineItems.documentId, draftIds));
  const linesByDocument = new Map<string, LineRow[]>();
  for (const line of draftLines) {
    const lines = linesByDocument.get(line.documentId) ?? [];
    lines.push(line);
    linesByDocument.set(line.documentId, lines);
  }
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    customerName: row.customerName,
    issueDate: row.issueDate,
    status: row.status,
    amounts: jsonAmounts(row.status === 'finalized'
      ? documentSnapshot(row)
      : calculatePricing((linesByDocument.get(row.id) ?? []).map(databaseLineInput)).amounts),
  }));
}
