import type { DashboardFilters } from './useDashboard.types.js';
import React from 'react';
import type { DocumentSummary } from '../../shared/types/api-contracts.js';
import type { DocumentListResponse } from '../../shared/types/document-list.js';
import { responseError } from '../api/client.js';

export function useDashboard(userId: string, onAuthExpired: () => void) {
  const [items, setItems] = React.useState<DocumentSummary[]>([]);
  const [totalItems, setTotalItems] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [filters, setFilters] = React.useState<DashboardFilters>({
    search: '',
    status: 'all',
    issueDateStart: '',
    issueDateEnd: '',
    sort: 'desc',
    page: 1,
  });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [requestCursor, setRequestCursor] = React.useState<string | undefined>();
  const pageCursors = React.useRef(new Map<number, { first: string; last: string }>());

  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.issueDateStart) params.set('issueDateStart', filters.issueDateStart);
    if (filters.issueDateEnd) params.set('issueDateEnd', filters.issueDateEnd);
    if (filters.sort !== 'desc') params.set('sort', filters.sort);
    if (filters.page > 1 || requestCursor) params.set('page', String(filters.page));
    if (requestCursor) {
      params.set('cursor', requestCursor);
      params.set('includeTotal', 'false');
    }

    const fetchPage = async (): Promise<DocumentListResponse | null> => {
      const query = params.toString();
      const response = await fetch(`/documents${query ? `?${query}` : ''}`, { signal: controller.signal });
      if (response.status === 401) {
        onAuthExpired();
        return null;
      }
      if (!response.ok) throw new Error((await responseError(response)).message ?? 'Could not load documents.');
      return response.json() as Promise<DocumentListResponse>;
    };

    setLoading(true);
    setError('');
    void fetchPage()
      .then(async initialResult => {
        let result = initialResult;
        if (!active || !result) return;
        if (requestCursor && result.items.length === 0) {
          pageCursors.current.clear();
          params.delete('cursor');
          params.delete('includeTotal');
          result = await fetchPage();
          if (!active || !result) return;
        }
        if (result.totalPages !== undefined && filters.page > Math.max(1, result.totalPages)) {
          pageCursors.current.clear();
          setRequestCursor(undefined);
          setFilters(current => ({ ...current, page: Math.max(1, result.totalPages ?? 0) }));
          return;
        }
        setItems(result.items);
        if (result.totalItems !== undefined && result.totalPages !== undefined) {
          setTotalItems(result.totalItems);
          setTotalPages(result.totalPages);
        }
        if (result.firstCursor && result.lastCursor) {
          pageCursors.current.set(result.page, { first: result.firstCursor, last: result.lastCursor });
        }
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setItems([]);
        setTotalItems(0);
        setTotalPages(0);
        setError(reason instanceof Error ? reason.message : 'Could not load documents.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [filters, requestCursor, onAuthExpired, userId]);

  const updateFilters = (changes: Partial<DashboardFilters>): void => {
    pageCursors.current.clear();
    setRequestCursor(undefined);
    setFilters(current => ({ ...current, ...changes, page: 1 }));
  };
  const hasActiveFilters = Boolean(
    filters.search.trim()
    || filters.status !== 'all'
    || filters.issueDateStart
    || filters.issueDateEnd
    || filters.sort !== 'desc',
  );
  const visiblePageNumbers = paginationPages(filters.page, totalPages);
  const resetFilters = (): void => {
    pageCursors.current.clear();
    setRequestCursor(undefined);
    setFilters({ search: '', status: 'all', issueDateStart: '', issueDateEnd: '', sort: 'desc', page: 1 });
  };
  const setPage = (page: number): void => {
    const current = pageCursors.current.get(filters.page);
    const visited = pageCursors.current.get(page);
    const cursor = page === filters.page + 1 && current ? `after:${current.last}`
      : page === filters.page - 1 && current ? `before:${current.first}`
        : visited ? `at:${visited.first}` : undefined;
    setRequestCursor(cursor);
    setFilters(previous => ({ ...previous, page }));
  };

  const movePage = (direction: -1 | 1): void => {
    setPage(filters.page + direction);
  };

  return { items, totalItems, totalPages, filters, loading, error, updateFilters, resetFilters, setPage, movePage, hasActiveFilters, visiblePageNumbers };
}

function paginationPages(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  const ordered = [...pages].filter(page => page >= 1 && page <= total).sort((left, right) => left - right);
  const result: Array<number | 'ellipsis'> = [];
  for (const [index, page] of ordered.entries()) {
    if (index > 0 && page - ordered[index - 1] > 1) result.push('ellipsis');
    result.push(page);
  }
  return result;
}
