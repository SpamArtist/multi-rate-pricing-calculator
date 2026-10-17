export type LineInput = { id?: string; description: string; quantity: number; unitPriceCents: number; discountCents: number; taxRateBasisPoints: number };

export type Document = { id: string; title: string; status: string; lineItems: Array<LineInput & { id: string; position: number; amounts: unknown }>; amounts: { totalCents: number } };

export type SaveBody = { mutationId: string; documentId?: string; title: string; customerName: string; issueDate: string; lineItems: LineInput[] };
