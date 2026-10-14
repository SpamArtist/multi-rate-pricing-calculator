# Production check scaffold

This repository keeps the approved in-memory design prototype separate from the production seams. Production checks use a TypeScript API, React app, Drizzle migrations, and real PostgreSQL. They establish health, role, tenant isolation, and browser smoke checks; document lifecycle and auth behavior arrive in later slices.

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

Compose bootstraps separate `pricing_migrator` and `pricing_runtime` logins. Drizzle migrations run as `pricing_migrator`, which owns the schema. The API and tests connect as `pricing_runtime`, a `NOSUPERUSER NOBYPASSRLS` role that does not own tenant tables. The first migration applies row-level security to the production-check `documents` table; runtime queries set `app.user_id` locally inside one transaction. Missing identity returns no tenant rows and cannot insert.

Database fixtures use fresh UUID owner identities, transaction-local identity, and cleanup in `finally`. `createApiSession()` creates a fresh cookie jar per test user; its helper check verifies cookie state stays separate. API app construction accepts an injected clock, and `TestClock` freezes or advances time without changing host time. Health tests pin an instant at an October month boundary and advance by 24 hours. Later expiry/report tests can reuse this clock and per-user fixtures instead of changing machine time or sharing sessions.

Playwright launches API and React together through `npm run dev`, uses semantic roles and visible status text, and creates separate browser contexts for user sessions. It does not use the prototype as its result source.

## Latest local verification

Verified 2026-10-14 after removing the local Podman container and data volume, so setup started from empty PostgreSQL:

- `npm run setup:local` — exit 0. Installed dependencies (0 audit findings), started PostgreSQL, applied migrations as `pricing_migrator`, and ran full check graph.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `npm run check:api` — 2 files, 3 tests passed.
- `npm run check:db` — 1 file, 1 test passed as `pricing_runtime`.
- `npm run check:ui` — 1 Playwright Chromium test passed.
- `npm run build` — exit 0; Vite built React and esbuild produced API bundle.
- `npm start` smoke — `/health` HTTP 200 and `/` HTTP 200.
- `npm audit` — 0 vulnerabilities.
- Failure injection — temporary failing assertion made `npm run check` exit 1 (1 failed, 3 passed); temporary test removed. CI runs the same check graph through `npm run check:local`, so assertion failures propagate to the workflow.
