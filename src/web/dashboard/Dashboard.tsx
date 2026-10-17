import React from 'react';
import type { User } from '../../shared/types/api-contracts.js';
import { formatDate, formatEuro } from '../formatting.js';
import { PrototypeIcon } from '../PrototypeIcon.js';
import { navigate } from '../routing.js';
import { SummaryReport } from './SummaryReport.js';
import { useDashboard } from './useDashboard.js';
import type { DashboardFilters } from './useDashboard.types.js';

export function Dashboard({ user, onAuthExpired }: { user: User; onAuthExpired: () => void }): React.JSX.Element {
  const { items, totalItems, totalPages, filters, loading, error, updateFilters, resetFilters, setPage, movePage, hasActiveFilters, visiblePageNumbers } = useDashboard(user.id, onAuthExpired);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [searchDraft, setSearchDraft] = React.useState(filters.search);
  const clearFilters = (): void => {
    setSearchDraft('');
    resetFilters();
  };

  return (
    <div className={`dashboard-layout${reportOpen ? ' summary-open' : ''}`}>
    <main className="dashboard-page">
      <div className="page-heading">
        <div className="dashboard-intro">
          <p className="eyebrow">Pricing documents</p>
          <h1>Documents</h1>
          <p className="dashboard-subtitle">Find and continue your customer work.</p>
        </div>
        <div className="dashboard-actions">
          <button
            className="secondary-button summary-action"
            type="button"
            aria-controls="summary-report-sidebar"
            aria-expanded={reportOpen}
            onClick={() => setReportOpen(true)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 16.5h14M5.5 13V8m4 5V4m4 9v-3" /></svg>
            Generate Summary
          </button>
          <button className="primary-button new-document-action" type="button" onClick={() => navigate('/documents/new')}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 3.5v13M3.5 10h13" /></svg>
            New document
          </button>
        </div>
      </div>

      <section className="document-list-section" aria-labelledby="document-list-title">
        <div className="section-heading list-heading">
          <h2 id="document-list-title">All documents</h2>
          <span aria-live="polite">{loading ? 'Loading…' : totalItems === 0 ? '0 documents' : `${totalItems} shown`}</span>
        </div>
        {error && <p className="request-error" role="alert">{error}</p>}
        <form className="dashboard-filters" role="search" onSubmit={event => {
          event.preventDefault();
          if (searchDraft !== filters.search) updateFilters({ search: searchDraft });
        }}>
          <label className="search-control">
            <span className="visually-hidden">Search customers</span>
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
            <input
              type="search"
              aria-label="Search customers"
              placeholder="Search customers"
              value={searchDraft}
              onChange={event => setSearchDraft(event.currentTarget.value)}
            />
          </label>
          <button className="primary-button search-submit" type="submit" disabled={searchDraft === filters.search}>Search</button>
          <label className="filter-select">
            <span className="visually-hidden">Status</span>
            <select aria-label="Status" value={filters.status} onChange={event => updateFilters({ status: event.currentTarget.value as DashboardFilters['status'] })}>
              <option value="all">All statuses</option>
              <option value="draft">Drafts</option>
              <option value="finalized">Finalized</option>
            </select>
          </label>
          <label className="filter-select">
            <span className="visually-hidden">Sort by issue date</span>
            <select aria-label="Sort by issue date" value={filters.sort} onChange={event => updateFilters({ sort: event.currentTarget.value as DashboardFilters['sort'] })}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <label className="date-filter">
            <span>From</span>
            <input aria-label="From issue date" type="date" value={filters.issueDateStart} onChange={event => updateFilters({ issueDateStart: event.currentTarget.value })} />
          </label>
          <label className="date-filter">
            <span>To</span>
            <input aria-label="To issue date" type="date" value={filters.issueDateEnd} onChange={event => updateFilters({ issueDateEnd: event.currentTarget.value })} />
          </label>
          {(hasActiveFilters || searchDraft !== '') && (
            <button className="reset-filters" type="button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </form>
        {loading ? (
          <p className="empty-state" aria-live="polite">Loading your documents…</p>
        ) : items.length === 0 ? (
          hasActiveFilters ? (
            <div className="empty-state">
              <p>No documents match these filters.</p>
              <button className="text-button" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <p>No documents yet.</p>
              <p>Start with a name and issue date. Add customer details when ready.</p>
            </div>
          )
        ) : (
          <div className="table-scroll">
            <table className="document-table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Issue date</th>
                  <th scope="col">Status</th>
                  <th className="number-cell" scope="col">Total</th>
                  <th className="row-arrow-cell" scope="col"><span className="visually-hidden">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <th scope="row">
                      <a className="table-link" href={`#/documents/${encodeURIComponent(item.id)}`}>
                        {item.title}
                      </a>
                    </th>
                    <td>{item.customerName || '—'}</td>
                    <td>{formatDate(item.issueDate)}</td>
                    <td><span className={`status-badge ${item.status}`}>{item.status === 'draft' ? 'Draft' : 'Finalized'}</span></td>
                    <td className="number-cell"><span className="row-total">{formatEuro(item.amounts.totalCents)}</span></td>
                    <td className="row-arrow-cell"><PrototypeIcon name="arrow" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && totalPages > 0 && (
          <nav className="document-pagination" aria-label="Document pages">
            <button type="button" aria-label="Previous page" disabled={filters.page <= 1} onClick={() => movePage(-1)}>←</button>
            {visiblePageNumbers.map((pageNumber, index) => typeof pageNumber === 'number' ? (
              <button
                type="button"
                key={pageNumber}
                aria-label={`Page ${pageNumber}`}
                aria-current={pageNumber === filters.page ? 'page' : undefined}
                onClick={() => setPage(pageNumber)}
              >
                {pageNumber}
              </button>
            ) : <span className="page-ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>)}
            <button type="button" aria-label="Next page" disabled={filters.page >= totalPages} onClick={() => movePage(1)}>→</button>
          </nav>
        )}
      </section>
    </main>
    <SummaryReport userId={user.id} reportOpen={reportOpen} onClose={() => setReportOpen(false)} onAuthExpired={onAuthExpired} />
    </div>
  );
}
