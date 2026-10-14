# Production check scaffold

This repository keeps the approved in-memory design prototype separate from the production seams. Production checks use a TypeScript API, React app, Drizzle migrations, and real PostgreSQL. They establish health, role separation, tenant isolation, and browser smoke checks; document lifecycle and auth behavior arrive in later slices.

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

## Latest local verification

Verified 2026-10-14 after applying migrations and running production check commands against local PostgreSQL:

- `npm run db:migrate` on a fresh temporary PostgreSQL database — exit 0; migrations applied as `pricing_migrator`.
- `npm run check` — exit 0: typecheck and lint passed; API 2 files / 3 tests passed; DB 1 file / 7 tests passed as `pricing_runtime`; UI 1 Playwright test passed.
- `npm run check:db` on the fresh temporary database — 1 file / 7 tests passed.
- `npm run build` — exit 0; Vite built React and esbuild produced API bundle.
- `git diff --check` — exit 0.
