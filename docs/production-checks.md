# Production check scaffold

This repository keeps the approved in-memory design prototype separate from the production seams. Production checks use a TypeScript API, React app, Drizzle migrations, and real PostgreSQL. They establish health, role separation, tenant isolation, authentication, draft-document flows, authoritative line pricing, draft line editing, removal, reordering, and immutable finalized snapshots.

## One-command local setup

Requirements: Node.js 24+, npm, PostgreSQL 18 via Docker Compose, Podman, or local server tools (`initdb`, `pg_ctl`, `psql`, `createdb`), and network access to download Chromium. From a clean checkout, run:

```sh
npm run setup:local
```

This writes `.env` from `.env.example` if missing, installs locked dependencies and Chromium, starts fresh-or-existing local Postgres, applies Drizzle migrations using `pricing_migrator`, and runs the same check graph as CI. It uses Docker Compose when available, Podman otherwise, then local PostgreSQL tools as a fallback. The API and Vite React app start automatically for API and Playwright checks. PostgreSQL is bound to `127.0.0.1:5432`; the browser app uses `127.0.0.1:4173`, and the API uses `127.0.0.1:4174`.

To run the app without checks after setup:

```sh
npm run db:up
npm run db:migrate
npm run dev
```

## Check commands

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | Strict TypeScript across app, tests, and configs |
| `npm run lint` | ESLint across production and test source |
| `npm run check:api` | Public HTTP health and error-envelope behavior against runtime DB role |
| `npm run check:db` | PostgreSQL role separation, RLS, durable data isolation, and transaction-local identity |
| `npm run check:ui` | Playwright Chromium smoke against served React and API |
| `npm run check` | Same typecheck, lint, API, DB, and browser sequence used by CI |
| `npm run check:local` | Starts Postgres, migrates as owner, then runs `npm run check` |

`docker compose down --volumes --remove-orphans` removes the local database and test state. Run `npm run check:local` afterward to rebuild it from scratch.

## Roles and test isolation

Compose bootstraps separate `pricing_migrator` and `pricing_runtime` logins. Drizzle migrations run as `pricing_migrator`, which owns tenant tables. The API and tests connect as `pricing_runtime`, a `NOSUPERUSER NOBYPASSRLS` role that cannot create objects in `public` or own tenant tables. It has narrow user/session grants and tenant-table grants without owner-reassignment or truncate privileges.

`users`, `sessions`, `documents`, and `line_items` use UUID keys. Documents reference their owner; line items reference documents with cascade deletion. PostgreSQL checks required fields, draft/finalized snapshot completeness, nonnegative safe-range finalized amounts, quantity/price/discount/tax bounds, and unique positive line positions. Money and quantity use PostgreSQL `bigint`; Drizzle reads them as JavaScript `bigint` so conversion to API JSON numbers must be explicit and safe.

`withTenantTransaction(authenticatedOwnerId, operation)` opens one Drizzle transaction, binds `app.user_id` with parameterized `set_config(..., true)`, then gives the same transaction to tenant repositories. The database pool stays private to the DB module. Documents have owner policies with `USING` and `WITH CHECK`; line policies resolve both checks through the parent document. Missing identity returns no rows and cannot write. The setting protects trusted application queries from omitted tenant filters; it does not protect against arbitrary SQL execution.

Real-Postgres DB checks create fresh UUID owners with the migration role and run tenant operations as `pricing_runtime`. They verify owner/role attributes, document and line isolation for read/insert/update/delete, line reparent denial, missing identity, rollback, foreign-key cascade, storage defaults/checks, and sequential A→B→A reuse on one pooled connection. Assertions inspect database effects, not policy text. `createApiSession()` creates a fresh cookie jar per test user; its helper check verifies cookie state stays separate. API app construction accepts an injected clock, and `TestClock` freezes or advances time without changing host time.

Playwright launches API and React together through `npm run dev`, uses semantic roles and visible status text, and creates separate browser contexts for user sessions. It does not use the prototype as its result source.

## Authentication session behavior

Sign-in trims and validates credentials with the same Unicode rules as sign-up, uses case-insensitive canonical email lookup, and returns one generic credential failure for unknown email or wrong password. Every successful sign-in creates a separate opaque session. The API enforces 24-hour idle and seven-day absolute expiry; session checks refresh idle activity without moving the absolute bound. Every cookie-bearing state-changing request checks same-origin proof. Logout returns `401 unauthenticated` for absent or expired sessions and revokes only a current session; cross-origin cookie requests retain `403 invalid_origin` precedence. Sign-in attempts are throttled by canonical email and client IP.

After sign-in, the Documents page lists the owner's drafts. New document opens a local unsaved editor with the viewer's current local date and no server ID. Saving requires a nonblank title and real calendar date; customer name and lines may be empty. Line rows accept whole quantities, EUR values with at most two decimals, and tax percentages with at most two decimals. Browser previews use exact integer arithmetic; successful saves reload API-calculated amounts as authority. A draft line may have blank description, but invalid numeric input stays visible and blocks Save. Line inserts, edits, moves, and deletes use public line-item routes inside locked tenant transactions; line and document totals must fit JavaScript's safe-integer range before commit. Existing draft rows remain editable. Move and remove controls update the local order; Save changes persists current line values and positions, removes selected rows, then reloads authoritative amounts. Unsaved field edits and row order are kept in per-owner, per-document browser session storage and restored after reload or sign-in; credentials are never stored for recovery.

Playwright's local API server raises auth request limits only when `PRICING_PLAYWRIGHT_TEST=1` is set by `playwright.config.ts`. Production defaults remain unchanged.

## Latest local verification

Verified 2026-10-14 against local PostgreSQL for issue #15:

- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `npm run check:api` — 5 files / 20 tests passed. Public HTTP inserts verify the two-line €64.84 fixture, two €0.01 at 50% ties, optional defaults, blank descriptions, field validation, client-calculated/unknown fields, nulls, safe boundaries, unsafe line/document totals, atomic rejection, owner 404, and unauthenticated 401.
- `npm run check:db` — 1 file / 7 tests passed as `pricing_runtime`.
- `npm run check:ui` — 8 Playwright tests passed. New editor coverage verifies Add line item, five-part live arithmetic, save and reload, API-derived line/document values, invalid unfinished input retention, and 390px no-overflow layout. UI test attaches `issue-15-authoritative-document.json`, `issue-15-ledger-editor-desktop.png`, and `issue-15-ledger-editor-mobile.png`.
- `npm run build` — exit 0; Vite built React and esbuild produced API bundle.
- Older issue #14 evidence remains in `tests/ui/documents.spec.ts`; issue #15 adds populated-line evidence without changing finalization or line edit/remove/reorder scope.

Verified 2026-10-14 for issue #16 on `LLM/issue-16-line-mutations`:

- `npm run check` — exit 0. Typecheck and lint passed; API checks passed 6 files / 24 tests; DB checks passed 1 file / 7 tests; Playwright passed 9 tests.
- `npm run build` — exit 0; Vite built the editor and esbuild bundled the API.
- Public HTTP coverage inserts at beginning, middle, and end; verifies ordered detail and stable IDs after each mutation; moves in both directions; partially edits; deletes and renumbers; rejects invalid/empty/unknown patches, out-of-range positions, discount-over-subtotal after partial edits, and unsafe aggregate totals without changing saved values.
- Ownership tests return identical `404` for foreign/missing parent and line IDs. A finalized row seeded directly under the fixture owner returns `409` for insert, patch, and delete without changing its snapshot. Finalization route remains out of scope for issue #16.
- Playwright edits a saved price, retains invalid `1.239` input and field error across reload, confirms API data unchanged, moves a line, removes another, reloads, and verifies stable IDs, order, contiguous positions, and persisted price. It also verifies 390px layout has no horizontal overflow. Attachments: `issue-16-after-move.json`, `issue-16-persisted-document.json`, `issue-16-editor-desktop.png`, and `issue-16-editor-mobile.png`.

Verified 2026-10-14 for issue #17 on `LLM/issue-17-finalization`:

- `npm run check` — exit 0. Typecheck and lint passed; API checks passed 7 files / 31 tests; DB checks passed 1 file / 7 tests; Playwright passed 10 tests.
- `npm run build` — exit 0; Vite built the React editor and esbuild bundled the API.
- Public HTTP finalization coverage checks combined missing-customer/no-line errors, blank descriptions, unsafe persisted numeric input, draft recovery after `422`, exact €64.84 line and document snapshots, and `409 invalid_state` for metadata PATCH, line insert/PATCH/delete, document DELETE, and repeat finalize. Foreign and missing finalize/delete IDs return identical `404` responses; client-controlled finalize fields return `422`.
- A forced PostgreSQL trigger failure on the first line snapshot write returns `500` and rolls back every line and document snapshot field; the draft remains editable. A concurrent line-price PATCH/finalize race returns either a serialized `200` edit reflected in the snapshot or `409` after finalization, with no mixed amount state.
- Frozen-read coverage changes a finalized line's tax-rate input directly under the owner test transaction, then verifies GET still returns the stored per-line and document amounts. Finalized reads reject incomplete snapshots instead of falling back to calculator code.
- Playwright creates an unsaved document with valid prices but missing customer and line description, clicks Finalize, verifies both field errors and retained values on the saved draft, repairs fields, finalizes, reloads, verifies inputs/actions disabled, and checks the persisted API snapshot. Attachment: `issue-17-finalized-snapshot.json`.

Verified 2026-10-14 for issue #18 on `LLM/issue-18-duplicate-document`:

- `npm run check` — exit 0. Typecheck and lint passed; API checks passed 8 files / 33 tests; DB checks passed 1 file / 7 tests; Playwright passed 11 tests.
- `npm run build` — exit 0; Vite built the React app and esbuild bundled the API.
- Public HTTP coverage duplicates both drafts and finalized documents. It reorders source lines before copying; verifies fresh document/line UUIDs, contiguous position order, copied input values, explicit caller dates, regenerated timestamps, draft status, unchanged source detail, and editable copies. Direct runtime-role reads confirm every copy's finalized snapshot column stays null. A finalized source input is changed under the test owner transaction while its snapshot stays fixed; duplicate amounts follow the copied inputs, proving the new draft recalculates instead of reusing snapshots. Missing, absent, null, malformed, and unknown date fields return `422`; foreign and missing IDs return identical `404`; failed requests create no documents.
- Playwright verifies Duplicate is absent for an unsaved editor, then duplicates a saved draft and finalized source. Both flows keep source open, show “Draft duplicated.” and “Open copy,” and open an editable copy dated with browser-local today. The draft-copy flow edits and reloads the persisted copy while the source detail remains unchanged. Attachment: `issue-18-duplicated-document.json`.

Verified 2026-10-14 for issue #19 on `LLM/issue-19-delete-draft`:

- `npm run check` — exit 0. Typecheck and lint passed; API checks passed 9 files / 35 tests; DB checks passed 1 file / 7 tests; Playwright passed 12 tests.
- `npm run build` — exit 0; Vite built the React app and esbuild bundled the API.
- The existing `DELETE /documents/{id}` route locks the tenant-scoped document row before checking status, deletes drafts in the same tenant transaction, and relies on the line-item FK cascade. Public HTTP coverage verifies `204` for owned draft, `401` without session, matching `404` for foreign/missing IDs, and `409 invalid_state` for finalized documents. Finalized detail remains byte-for-byte equivalent after rejected deletion.
- Cascade proof creates two lines, deletes the draft through HTTP, then checks deleted document/line access returns `404` and directly inspects Postgres to confirm both line rows are absent. This physical row check uses `BOOTSTRAP_DATABASE_URL` or local `pricing_bootstrap`, since forced RLS intentionally hides orphan rows from app and migration roles.
- Playwright confirms Cancel preserves the draft, accepted Delete draft removes it from the list, detail API returns `404`, and finalized editor has no Delete draft control. Attachment: `issue-19-deleted-draft.json`.

Verified 2026-10-14 for issue #20 on `LLM/issue-20-ledger-dashboard`:

- `npm run check` — exit 0. Typecheck and lint passed; API checks passed 9 files / 39 tests; DB checks passed 1 file / 7 tests; Playwright passed 13 tests.
- `npm run build` — exit 0; Vite built the Ledger dashboard and esbuild bundled the API.
- Public HTTP coverage checks list defaults, strict unknown/repeated/invalid query validation, trimmed case-insensitive customer search, standalone inclusive date bounds, AND-combined status/date/search filters, ascending ID ties in either date order, 25/1 pagination, beyond-end metadata, owner isolation, and current draft versus finalized snapshot amounts. List projection contains no line items.
- Playwright seeds 27 matching records plus one non-match, exercises search/status/date/sort, moves to page 2, verifies filter and sort reset to page 1, clears filters, checks 390px no-overflow, opens a document by clicking its row, reloads list/detail, and verifies API-backed data. Attachments: `issue-20-filtered-list.json`, `issue-20-ledger-document.json`, `issue-20-ledger-dashboard-filtered.png`, and `issue-20-ledger-dashboard-mobile.png`.
