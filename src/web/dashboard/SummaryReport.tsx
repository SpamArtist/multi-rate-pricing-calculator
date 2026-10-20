import type { SummaryReportProps } from './SummaryReport.types.js';
import React from 'react';
import { formatEuro } from '../formatting.js';
import { useSummaryReport } from './useSummaryReport.js';

export function SummaryReport({ userId, reportOpen, onClose, onAuthExpired }: SummaryReportProps): React.JSX.Element {
  const { reportRange, updateReportRange, reportLoading, reportError, reportRangeError, currentReport } = useSummaryReport(userId, reportOpen, onAuthExpired);

  return (
    <aside
      id="summary-report-sidebar"
      className="summary-sidebar"
      aria-label="Summary report"
      hidden={!reportOpen}
    >
      <div className="summary-sidebar-head">
        <span>Generated summary</span>
        <button className="summary-close" type="button" aria-label="Close summary" onClick={onClose}>×</button>
      </div>
      <section className="summary-report" aria-label="Summary report">
        <div className="summary-report-heading">
          <div>
            <span className="summary-label">Summary report</span>
            <h2>Issue date totals</h2>
          </div>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M7 16V9m5 7V4m5 12v-5" /></svg>
        </div>
        <div className="summary-date-fields">
          <label>
            <span>From</span>
            <input
              aria-label="Summary start date"
              aria-invalid={Boolean(reportRangeError)}
              aria-describedby={reportRangeError ? 'summary-range-error' : undefined}
              type="date"
              value={reportRange.start}
              onChange={event => updateReportRange({ start: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              aria-label="Summary end date"
              aria-invalid={Boolean(reportRangeError)}
              aria-describedby={reportRangeError ? 'summary-range-error' : undefined}
              type="date"
              value={reportRange.end}
              onChange={event => updateReportRange({ end: event.currentTarget.value })}
            />
          </label>
        </div>
        {reportRangeError ? (
          <p className="field-error summary-range-error" id="summary-range-error" role="alert">{reportRangeError}</p>
        ) : reportError ? (
          <p className="request-error" role="alert">{reportError}</p>
        ) : (
          <p className="summary-report-note">Finalized documents only · independent of list filters</p>
        )}
        <div className="summary-report-major" aria-live="polite">
          <span>Total</span>
          <strong>{currentReport ? formatEuro(currentReport.amounts.totalCents) : '—'}</strong>
        </div>
        <dl className="summary-amount-list">
          <div><dt>Documents</dt><dd>{currentReport ? currentReport.finalizedDocumentCount : reportLoading ? 'Loading…' : '—'}</dd></div>
          <div><dt>Subtotal</dt><dd>{currentReport ? formatEuro(currentReport.amounts.subtotalCents) : '—'}</dd></div>
          <div><dt>Discounts</dt><dd>{currentReport ? `−${formatEuro(currentReport.amounts.discountCents)}` : '—'}</dd></div>
          <div><dt>Taxable</dt><dd>{currentReport ? formatEuro(currentReport.amounts.taxableCents) : '—'}</dd></div>
          <div><dt>Tax</dt><dd>{currentReport ? formatEuro(currentReport.amounts.taxCents) : '—'}</dd></div>
        </dl>
      </section>
    </aside>
  );
}
