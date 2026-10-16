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

After sign-in, the Documents page lists the owner's drafts. New document opens a local unsaved editor with the viewer's current local date and no server ID. Saving requires a nonblank title and real calendar date; customer name and lines may be empty. Line rows accept whole quantities, EUR values with at most two decimals, and tax percentages with at most two decimals. Browser previews use exact integer arithmetic; the aggregate draft-save response supplies authoritative IDs and amounts. A draft line may have blank description, but invalid numeric input stays visible and blocks Save. The editor saves metadata and its intended ordered line set in one locked tenant transaction; line and document totals must fit JavaScript's safe-integer range before commit. Existing draft rows remain editable. Move and remove controls update the local order; Save changes returns the complete persisted draft without a per-line request chain. Unsaved field edits, row order, and any pending save request are kept in per-owner, per-document browser session storage and restored after reload or sign-in; credentials are never stored for recovery. Legacy line-item routes remain available to API callers.

Playwright's local API server raises auth request limits only when `PRICING_PLAYWRIGHT_TEST=1` is set by `playwright.config.ts`. Production defaults remain unchanged.
