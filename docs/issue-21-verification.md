# Issue #21 Verification

**Scope:** Private, on-demand summary of finalized document snapshots by inclusive issue date. The report has independent date state and ignores Ledger search, filters, sorting, and pagination.

## Recorded evidence

- Desktop sidebar screenshot at 1440 × 1000 and persisted `GET /reports/summary` response: attached to the Playwright test result.
- Visual target: [Variant B desktop snapshot](../prototype/dashboard-editor/snapshots/ledger-summary-desktop.png)

The original captures are retained locally under the ignored `.artifacts/evidence/` directory. The UI test confirms no report request before opening the sidebar, checks the viewer-local month, then changes Ledger page, search, status, sort, and dates while the report stays unchanged. A reversed report range shows an inline error and sends no request; repairing it returns the same persisted summary.

## API coverage

`GET /reports/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` requires an authenticated owner, both real calendar dates, and `start <= end`. It rejects unknown or repeated query parameters and sets `Cache-Control: private, no-store`. The query filters by owner, finalized status, and inclusive issue dates, then sums document snapshot columns in Postgres. Exact integer aggregates are range-checked before JSON serialization; overflow returns `422 validation_failed`.

The API tests cover a September 30 issue finalized October 3, both inclusive endpoints, draft exclusion, owner isolation, zero matches, invalid and reversed ranges, list-query rejection, and unsafe aggregate totals.

## Checks

- Targeted API test: 3 passed.
- Targeted Playwright report test: 1 passed.
- `npm run check`: passed — typecheck, lint, 42 API tests, 7 DB tests, and 14 Playwright tests.
- `npm run build`: passed — Vite client build and bundled Node server build.

The API suite emitted a nonfatal `pg` deprecation warning; all checks passed.
