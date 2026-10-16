# Issue #10 verification

Status: acceptance evidence complete; issue stays open for orchestrator review.
Verified 2026-10-16 on `LLM/issue-10-ci-verification`, based on local
`LLM/mvp-integration` commit `a8454cc`.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| One-command local setup | `npm run setup:local` passed. It ran `npm ci`, installed Chromium, ensured real PostgreSQL was available, applied migrations as `pricing_migrator`, then ran `npm run check:local` and same `npm run check` graph as CI. Setup path: `scripts/setup-local.sh`, `scripts/check-local.sh`; script starts PostgreSQL when needed. |
| Typecheck, lint, API, DB, Playwright commands | `npm run typecheck` and `npm run lint` passed. API: 12 files / 73 tests passed. DB: 2 files / 10 tests passed under `pricing_runtime`. Playwright: 56 tests passed against served React app and API. |
| Health and browser smoke | `tests/api/health.test.ts` makes HTTP request and checks DB-backed health response. `tests/ui/smoke.spec.ts` checks served React sign-in controls by accessible role and visible text; `tests/ui/auth-signup.spec.ts` clicks visible “Create account” and reaches private workspace. Both included in CI. |
| Isolated data, sessions, controlled time | `tests/support/db-fixture.ts` creates UUID owners and performs DB cleanup; `tests/support/api-session.ts` gives each API session a separate cookie jar; UI tests use separate browser contexts. `tests/support/test-clock.ts` freezes/advances API time; auth tests cover expiry, and report tests pin clock at 2026-10-03 while checking inclusive Sep 30 / Oct 1 issue-date boundaries. |
| Commands and inspection docs | `docs/production-checks.md` documents setup, app startup, checks, DB roles, test isolation, and teardown. Package scripts expose each requested check. |

## Scope and seams

- Stack: TypeScript, Node.js, React, PostgreSQL, Drizzle. Production checks use one-owner EUR documents and real Postgres; money/discounts use integer cents, tax rates use basis points, and issue dates use validated calendar dates. See `package.json`, `src/`, `drizzle/`, and `docs/production-checks.md`.
- API tests exercise public HTTP behavior and persisted effects. DB tests connect as restricted `pricing_runtime` and verify role/RLS behavior through reads and writes. See `tests/api/` and `tests/db/`.
- UI tests use Playwright only against served app/API. No component harness or in-memory prototype is result source. See `playwright.config.ts` and `tests/ui/`.
- `{error:{code,message,fields?}}` contract is established and tested for stable codes, readable messages, and field paths. See `tests/api/request-body.test.ts` and `src/server/`.
- Generic priced documents only. Formal quote/invoice types, numbering, payments, tax compliance, delivery email, sharing/transfers, account email flows, and hosted deployment remain outside scope, as issue specifies.

## GitHub Actions evidence

Workflow: [Production checks](https://github.com/SpamArtist/multi-rate-pricing-calculator/blob/main/.github/workflows/ci.yml). Each run checks out branch, installs locked dependencies and Chromium, removes Compose DB volumes, then runs `npm run check:local`. That path starts Postgres, migrates as `pricing_migrator`, and executes typecheck, lint, API, DB, and Playwright checks.

| Result | Commit | Run |
| --- | --- | --- |
| Deliberate failure | `bea9880` temporarily changed health status expectation from `200` to `201`. Workflow removed DB volumes, applied migrations with `pricing_migrator`, then failed on exact assertion `expected 200 to be 201`; 72 API tests passed, 1 failed. | [Run 38883602027](https://github.com/SpamArtist/multi-rate-pricing-calculator/actions/runs/38883602027) |
| Restored passing assertion | `fa47687` restored expected `200`. Clean-volume reset and migration passed; typecheck/lint passed; API 12 files / 73 tests, DB 2 files / 10 tests, Playwright 56 tests passed. | [Run 38883909881](https://github.com/SpamArtist/multi-rate-pricing-calculator/actions/runs/38883909881) |

Negative control changed only `tests/api/health.test.ts`; restored before final branch state. No application behavior changed.
