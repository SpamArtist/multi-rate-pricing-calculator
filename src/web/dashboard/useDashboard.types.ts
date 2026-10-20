export type DashboardFilters = {
  search: string;
  status: 'all' | 'draft' | 'finalized';
  issueDateStart: string;
  issueDateEnd: string;
  sort: 'desc' | 'asc';
  page: number;
};
