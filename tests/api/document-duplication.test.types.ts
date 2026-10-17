export type LineItem = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  taxRateBasisPoints: number;
  amounts: Record<string, number>;
};

export type Document = {
  id: string;
  title: string;
  customerName: string;
  issueDate: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  lineItems: LineItem[];
  amounts: Record<string, number>;
};
