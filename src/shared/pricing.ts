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
  return lines.reduce((total, line) => {
    const amounts = calculateLineAmounts(line);
    total.subtotalCents += amounts.subtotalCents;
    total.discountCents += amounts.discountCents;
    total.taxableCents += amounts.taxableCents;
    total.taxCents += amounts.taxCents;
    total.totalCents += amounts.totalCents;
    return total;
  }, {
    subtotalCents: 0n,
    discountCents: 0n,
    taxableCents: 0n,
    taxCents: 0n,
    totalCents: 0n,
  });
}

export function amountsWithinSafeRange(amounts: ExactAmounts): boolean {
  return Object.values(amounts).every(value => value >= 0n && value <= MAX_SAFE_AMOUNT);
}
