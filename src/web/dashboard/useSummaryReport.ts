import React from 'react';
import { isCalendarDate } from '../../shared/document-validation.js';
import type { SummaryReport } from '../../shared/types/api-contracts.js';
import { responseError } from '../api/client.js';
import { localMonthRange } from '../formatting.js';

export function useSummaryReport(userId: string, reportOpen: boolean, onAuthExpired: () => void) {
  const [reportRange, setReportRange] = React.useState(localMonthRange);
  const [reportSummary, setReportSummary] = React.useState<SummaryReport | null>(null);
  const [reportLoading, setReportLoading] = React.useState(false);
  const [reportError, setReportError] = React.useState('');
  const reportRangeError = !isCalendarDate(reportRange.start) || !isCalendarDate(reportRange.end)
    ? 'Enter both report dates.'
    : reportRange.start > reportRange.end
      ? 'End date must be on or after start date.'
      : '';

  React.useEffect(() => {
    if (!reportOpen) return undefined;
    if (reportRangeError) {
      setReportSummary(null);
      setReportLoading(false);
      setReportError('');
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ start: reportRange.start, end: reportRange.end });
    setReportLoading(true);
    setReportError('');
    void fetch(`/reports/summary?${query}`, { signal: controller.signal })
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (!response.ok) {
          const result = await responseError(response);
          throw new Error(result.message ?? 'Could not load summary.');
        }
        return response.json() as Promise<SummaryReport>;
      })
      .then(result => {
        if (active && result) setReportSummary(result);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setReportSummary(null);
        setReportError(reason instanceof Error ? reason.message : 'Could not load summary.');
      })
      .finally(() => { if (active) setReportLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [onAuthExpired, reportOpen, reportRange.end, reportRange.start, reportRangeError, userId]);

  const currentReport = reportSummary?.start === reportRange.start && reportSummary.end === reportRange.end
    ? reportSummary
    : null;

  const updateReportRange = (changes: Partial<Pick<SummaryReport, 'start' | 'end'>>): void => {
    setReportRange(current => ({ ...current, ...changes }));
  };

  return { reportRange, updateReportRange, reportLoading, reportError, reportRangeError, currentReport };
}
