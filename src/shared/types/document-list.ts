import type { DocumentSummary } from './api-contracts.js';

export type DocumentListStatus = 'all' | 'draft' | 'finalized';
export type DocumentListSort = 'desc' | 'asc';
export type DocumentListCursor = {
  direction: 'after' | 'before' | 'at';
  issueDate: string;
  id: string;
};
export type DocumentListQuery = {
  search: string;
  status: DocumentListStatus;
  issueDateStart?: string;
  issueDateEnd?: string;
  sort: DocumentListSort;
  page: number;
  cursor?: DocumentListCursor;
  includeTotal: boolean;
};
export type DocumentListResponse = {
  items: DocumentSummary[];
  page: number;
  pageSize: number;
  totalItems?: number;
  totalPages?: number;
  firstCursor: string | null;
  lastCursor: string | null;
};
