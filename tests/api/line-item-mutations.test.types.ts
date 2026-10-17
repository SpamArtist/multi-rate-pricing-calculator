export type Line = { id: string; position: number; description: string; quantity: number; unitPriceCents: number; discountCents: number; taxRateBasisPoints: number };

export type Detail = { id: string; lineItems: Line[]; amounts: Record<string, number> };
