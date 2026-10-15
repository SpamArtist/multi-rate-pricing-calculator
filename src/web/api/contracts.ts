export type User = { id: string; email: string };
export type Amounts = {
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
};
export type DocumentSummary = {
  id: string;
  title: string;
  customerName: string;
  issueDate: string;
  status: 'draft' | 'finalized';
  amounts: Amounts;
};
export type SummaryReport = {
  start: string;
  end: string;
  finalizedDocumentCount: number;
  amounts: Amounts;
};
export type DocumentData = DocumentSummary & {
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  lineItems: Array<{
    id: string;
    position: number;
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    taxRateBasisPoints: number;
    amounts: Amounts;
  }>;
};
export type FieldErrors = Record<string, string>;
