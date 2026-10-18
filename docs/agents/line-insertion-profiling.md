# Profile the duplication bulk insert

Use `node scripts/profile-duplication-insert.mjs` to inspect the database work inside line insertion. This is a diagnostic harness, not a product optimization or an endpoint benchmark. It extracts the exact `INSERT … SELECT` from the duplication route and fails if that SQL shape moves or gains unknown parameters.

## Environment and execution

Use an **empty, disposable, migrated** PostgreSQL database at `127.0.0.1:5433/pricing`. The harness refuses other hosts, ports, databases, or a nonempty users/documents table. Its default connection uses the repository's local `pricing_bootstrap` credentials. Override with `INSERT_PROFILE_DATABASE_URL` if necessary; never print that URL or save it in evidence. The bootstrap connection must permit session-local I/O timing, fixture setup, vacuum, and switching to `pricing_runtime`.

```sh
node scripts/profile-duplication-insert.mjs
```

Defaults: five warmups, 40 measured rounds per case and probe, 100 and 33,086 owned parent documents, draft/finalized sources at 2/40/337/411 lines. Each population also contains twice as many foreign-owned parents, and 1,580 total source lines. These fixtures are independently authored. No real customer data is read. Run without other traffic on that disposable database; the advisory lock excludes another copy of this profiler, not application writers.

Set `INSERT_PROFILE_SAMPLES` (1–200) and `INSERT_PROFILE_PARENTS` (comma-separated counts, each 8–100,000; at most four) to narrow a run. Optional `INSERT_PROFILE_MAX_MS` makes the command fail **after saving results and cleaning up** if any case's plain insert median exceeds that diagnostic budget. This is an explicit local investigation threshold, not a production SLO or CI timing assertion.

```sh
INSERT_PROFILE_SAMPLES=10 INSERT_PROFILE_PARENTS=33086 INSERT_PROFILE_MAX_MS=20 \
  node scripts/profile-duplication-insert.mjs
```

## Markers and safeguards

Each sample records savepoint creation, runtime role selection, tenant binding, source `FOR UPDATE`, destination parent insertion, bulk line insertion, invariant verification, and rollback. The timed insert runs as `pricing_runtime`, checked to be nonsuperuser/non-BYPASSRLS with RLS active on both tables. Fixture setup is outside sample timings. No policies, indexes, constraints, or triggers are disabled or altered.

Three probes rotate within each round: plain INSERT, `EXPLAIN ANALYZE` with TIMING OFF, and TIMING ON. Both plans include BUFFERS, WAL, VERBOSE, SETTINGS, and JSON output. Full plans retain ownership subplans, actual rows/loops, sorting/window work, buffer hits/reads/writes, I/O timing, WAL, planning/execution/JIT information when present, and FK trigger calls/time. The harness records version/settings, policies, indexes, constraints, trigger definitions, table statistics, and before/after relation sizes. No custom policy-function timer is claimed: the current ownership checks are inline expressions.

Fixtures stay in a separate outer transaction for each population; each sample rolls back its new parent and lines to a savepoint. Final rollback removes fixtures even after an error or lost connection. Every successful copy checks count, positions, descriptions, pricing inputs, and absence of copied finalized totals. Source state/counts and total table populations are checked after each workload; final empty tables are verified. `VACUUM ANALYZE` on the empty line/document tables before each population removes previous rollback debris. A 30-second statement timeout and two-second lock timeout bound individual SQL waits.

Output lives in ignored `.artifacts/insert-profile-<run-id>/`: `results.json` retains every timing/plan, `summary.json` gives comparable metrics, and `report.md` explains the run. Files use mode 0600. Raw EXPLAIN contains synthetic UUIDs and SQL expressions; do not generalize this recorder to production data without redaction. Partial raw results are saved on ordinary errors. Abrupt process termination can prevent file writing, but database connection closure still rolls back uncommitted fixtures.

## Interpretation

Use the median of paired same-round probe-minus-plain durations to estimate recorder overhead. Medians use sorted index `floor(n/2)`; the harness reports no p95. Inspect first/last-half timing drift and relation-size changes before claiming a stable baseline. Compare only matched cases; draft and finalized sources have equal line-count controls.

Plan nodes are inclusive and per-loop averages. Multiply node time by loops when interpreting repeated operations; do not add parents and children. The ownership scan is part of the source subtree, which is part of execution. Built-in FK cost appears in trigger entries; very small per-loop timings lose precision. TIMING OFF omits node timing and cannot provide a phase breakdown. See [PostgreSQL EXPLAIN documentation](https://www.postgresql.org/docs/18/using-explain.html).

These serial rollback cohorts have uncommitted fixtures, accumulated aborted tuples within each population, and different visibility/cache/snapshot behavior from normal committed transactions. They exclude durable COMMIT, HTTP/auth/JSON/React work, concurrency, and intentional lock contention. The synthetic line table is much smaller than the populated local seed. Results can identify expensive plan work; they cannot be subtracted from earlier endpoint timings or establish an optimization win. Validate any future solution with matched endpoint runs plus tenant-isolation and concurrency checks.
