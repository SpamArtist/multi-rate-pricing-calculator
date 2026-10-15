export type LinePricingInput = {
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
};

export type ExactAmounts = {
  subtotalCents: bigint;
  discountCents: bigint;
  taxableCents: bigint;
  taxCents: bigint;
  totalCents: bigint;
};

export const MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

export type ExactPricing = {
  lines: Array<{ amounts: ExactAmounts; discountExceedsSubtotal: boolean; withinSafeRange: boolean }>;
  amounts: ExactAmounts;
  withinSafeRange: boolean;
};

export function calculateLineAmounts(line: LinePricingInput): ExactAmounts {
  const subtotalCents = line.quantity * line.unitPriceCents;
  const taxableCents = subtotalCents - line.discountCents;
  const taxCents = (taxableCents * BigInt(line.taxRateBasisPoints) + 5_000n) / 10_000n;
  return {
    subtotalCents,
    discountCents: line.discountCents,
    taxableCents,
    taxCents,
    totalCents: taxableCents + taxCents,
  };
}

export function calculateDocumentAmounts(lines: readonly LinePricingInput[]): ExactAmounts {
  return calculatePricing(lines).amounts;
}

export function calculatePricing(lines: readonly LinePricingInput[]): ExactPricing {
  const totals: ExactAmounts = {
    subtotalCents: 0n, discountCents: 0n, taxableCents: 0n, taxCents: 0n, totalCents: 0n,
  };
  const pricedLines = lines.map(line => {
    const amounts = calculateLineAmounts(line);
    totals.subtotalCents += amounts.subtotalCents;
    totals.discountCents += amounts.discountCents;
    totals.taxableCents += amounts.taxableCents;
    totals.taxCents += amounts.taxCents;
    totals.totalCents += amounts.totalCents;
    return {
      amounts,
      discountExceedsSubtotal: line.discountCents > amounts.subtotalCents,
      withinSafeRange: amountsWithinSafeRange(amounts),
    };
  });
  return {
    lines: pricedLines,
    amounts: totals,
    withinSafeRange: amountsWithinSafeRange(totals) && pricedLines.every(line => line.withinSafeRange && !line.discountExceedsSubtotal),
  };
}

export function amountsWithinSafeRange(amounts: ExactAmounts): boolean {
  return Object.values(amounts).every(value => value >= 0n && value <= MAX_SAFE_AMOUNT);
}
