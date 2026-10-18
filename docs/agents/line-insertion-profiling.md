# Profile the duplication bulk insert

Run `node scripts/profile-duplication-insert.mjs` to compare the current line-copy policy with an experimental scalar parent-owner lookup. This is a disposable-database experiment; it does not change application code or migrations. The harness extracts the exact `INSERT … SELECT` from the duplication route and fails if it moves or gains unknown parameters.

## Environment

Use an **empty, disposable, migrated** PostgreSQL database at `127.0.0.1:5433/pricing`, without other application/test traffic. Both connection URLs reject other hosts, ports and databases. The advisory lock excludes another profiler, not arbitrary application writers.

Defaults use the repository's local `pricing_bootstrap` and `pricing_runtime` credentials. Override `INSERT_PROFILE_DATABASE_URL` and `INSERT_PROFILE_RUNTIME_URL` if needed; never print them or save them in evidence. Bootstrap access prepares fixtures, performs maintenance, temporarily changes policy, and cleans up. Timed SQL runs under session `SET ROLE pricing_runtime`, checked to be nonsuperuser/non-BYPASSRLS with RLS active on both tables. Isolation probes use actual runtime-login connections. Bootstrap session privilege enables I/O timing before switching the measured connection's effective role.

```sh
node scripts/profile-duplication-insert.mjs
```

Defaults: five warmups, 40 measured rounds, 100 and 33,086 owned parent documents, and draft/finalized sources at 2/40/337/411 lines. Each population also has twice as many foreign-owned parents. Independently authored fixtures contain 1,581 lines including one foreign line for isolation checks.

Options:

- `INSERT_PROFILE_SAMPLES`: 1–200 measured rounds per case, variant and probe.
- `INSERT_PROFILE_LINES`: a comma-separated subset of `2,40,337,411`; use `411` for a shorter focused reproduction.
- `INSERT_PROFILE_PARENTS`: comma-separated parent counts, each 8–100,000; at most four. Reverse the order for a repeated control.
- `INSERT_PROFILE_VARIANTS`: `baseline`, `scalar`, or both in either order; default `baseline,scalar`. With both, order alternates each round.
- `INSERT_PROFILE_MAX_MS`: optional local diagnostic budget. Exits nonzero after saving evidence and cleanup if any plain insert median exceeds it. This is not a product SLO or CI timing assertion.

## Lifecycle and recovery

Fixture owners are recorded in `.artifacts/insert-profile-<run-id>/cleanup-ledger.json` **before setup can commit**. Before inserting each population, empty tables are vacuumed with forced index cleanup and heap truncation; zero heap bytes are asserted. Source fixtures are committed. Both tables’ indexes are rebuilt once per population, then tables are vacuumed/analyzed. Rebuilding removes allocated index space inherited from earlier experiments; index definitions do not change. Ledger writes flush a temporary file and atomically replace the previous ledger. Each copy uses a fresh transaction: bind tenant, lock source, insert parent, insert lines, store synthetic draft totals, and COMMIT. A privileged connection verifies committed line inputs/order/finalized fields and deletes the copy outside the timed transaction. The owner ledger covers copies even if a commit response is lost.

`VACUUM (ANALYZE, INDEX_CLEANUP ON, TRUNCATE ON)` runs before **every sample**, outside all sample timings. Explicit index cleanup prevents PostgreSQL’s AUTO shortcut from leaving sparse dead item identifiers that keep heap pages allocated. This prevents the old long-transaction/savepoint benchmark's accumulation of aborted tuples, inaccurate size-based estimates, and mid-run JIT activation. It also makes these controlled measurements maintenance-heavy and cache-warm; they are not an endpoint latency or production-load simulation. Each sample saves starting relation sizes, pages, and tuple estimates so stability remains inspectable.

Policy DDL commits before runtime work, so its exclusive table lock is absent from measured transactions and concurrency checks. Both variants execute ALTER POLICY, including a no-op installation of the original for baseline. The scalar variant changes only `line_items_owner_isolation`'s USING expression:

```sql
(SELECT parent.owner_id FROM public.documents AS parent
 WHERE parent.id = line_items.document_id)
= nullif(current_setting('app.user_id', true), '')::uuid
```

Parent-table RLS remains active, and the explicit WITH CHECK expression and other policy attributes must remain unchanged. This is a correlated lookup, potentially once per line; do not describe it as a guaranteed single lookup per document.

Ordinary completion/errors restore the original policy, remove only recorded fixture owners, and verify empty tables. Unlike the old rollback-only harness, **abrupt termination can leave committed fixtures and the experimental policy**. Recover using that run's ledger before other work:

```sh
node scripts/profile-duplication-insert.mjs --cleanup .artifacts/insert-profile-RUN-ID/cleanup-ledger.json
```

Recovery restores the saved original USING clause, verifies the remaining policy attributes, checks the synthetic owner email/hash markers, and deletes only those owner IDs. It is idempotent. Keep the ledger until its phase is `clean`; never replace it with a ledger from another database or modify its stored policy. A 30-second statement timeout and two-second lock timeout bound individual profiler queries. Runtime isolation probes have their own bounded timeouts.

## Markers and interpretation

Each sample records BEGIN, tenant binding, source lock/read, parent insertion, bulk insertion, draft amount write and COMMIT. The insert marker excludes maintenance, verification, cleanup and transaction commit. Plain INSERT, EXPLAIN ANALYZE TIMING OFF, and TIMING ON probes rotate within each case. Both plans include BUFFERS, WAL, VERBOSE, SETTINGS, and JSON; full plans retain source/destination ownership work, rows/loops, sort/window work, buffer and I/O activity, planning/execution/JIT, and FK trigger calls/time.

`results.json` contains raw evidence, runtime/policy/index/trigger inventories, every sample's relation sizes/statistics, and isolation results. `summary.json` contains phase summaries and paired variant comparisons. `report.md` explains the run. All output is ignored and written mode 0600. Raw plans include synthetic UUIDs and SQL expressions; do not reuse this collector against real data without redaction.

Medians use sorted index `floor(n/2)`. Savings and recorder overhead use same-round paired differences. No p95 or confidence interval is reported. Inspect first/last-half drift, JIT counts, plan shapes and row estimates. Source estimates include RLS selectivity, so they need not equal actual rows even after accurate ANALYZE. Parent-scale comparisons are not paired.

A scalar parent check can still use a sequential scan on a small parent table; inspect the index/seq-scan loop counts rather than assuming every one-row result is an index lookup. Plan nodes include their descendants and report per-loop average times. Multiply by loops where appropriate; never sum parents with children. JIT overlaps execution and some node times. TIMING OFF omits per-node durations; only TIMING ON supplies phase summaries. See [PostgreSQL EXPLAIN documentation](https://www.postgresql.org/docs/18/using-explain.html).

Before timing each variant/population, nine assertion groups verify owned CRUD, hidden foreign reads/updates/deletes, rejected foreign inserts/reparenting, missing/empty identity, A/B/A rebinding, transaction-local identity cleanup, source-lock contention and foreign denial while locked. Mutations roll back. These are correctness probes, not concurrent throughput or full endpoint tests. Any production policy proposal still needs API-level verification and matched workload measurement.
