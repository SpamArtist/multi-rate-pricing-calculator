import { eq } from 'drizzle-orm';
import type { TenantTransaction } from './client.types.js';
import { documents, lineItems } from './schema.js';
import type { ExactAmounts, LinePricingInput } from '../shared/types/pricing.js';

export async function readDraftLineInputs(transaction: TenantTransaction, documentId: string): Promise<LinePricingInput[]> {
  return transaction.select({
    quantity: lineItems.quantity,
    unitPriceCents: lineItems.unitPriceCents,
    discountCents: lineItems.discountCents,
    taxRateBasisPoints: lineItems.taxRateBasisPoints,
  }).from(lineItems).where(eq(lineItems.documentId, documentId));
}

export async function writeDraftAmounts(
  transaction: TenantTransaction, documentId: string, amounts: ExactAmounts, updatedAt?: Date,
): Promise<void> {
  await transaction.update(documents).set({
    draftSubtotalCents: amounts.subtotalCents,
    draftDiscountCents: amounts.discountCents,
    draftTaxableCents: amounts.taxableCents,
    draftTaxCents: amounts.taxCents,
    draftTotalCents: amounts.totalCents,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }).where(eq(documents.id, documentId));
}
