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

export type ExactPricing = {
  lines: Array<{ amounts: ExactAmounts; discountExceedsSubtotal: boolean; withinSafeRange: boolean }>;
  amounts: ExactAmounts;
  withinSafeRange: boolean;
};
