# Investigate insertion cost at a larger data footprint

`node scripts/profile-representative-insert.mjs` loads an empty disposable database, measures the unchanged duplication insert and actual HTTP endpoint, and removes its fixtures. It never installs the scalar policy, applies migrations, changes column statistics options, or edits product code. The default mode preserves schema throughout; opt-in UUID HTTP and serial modes make narrowly scoped disposable schema changes with restoration described below.

Use only an empty, already migrated `127.0.0.1:5433/pricing` without other traffic. Database URL guards reject other addresses. The shared profiler advisory lock excludes cooperating profilers. Defaults use the repository's local bootstrap and runtime credentials; override `REPRESENTATIVE_DATABASE_URL` and `REPRESENTATIVE_RUNTIME_URL` if needed. HTTP port 4194 must be unused. Runtime privileges and active table RLS are asserted. Existing duplication tracing must be available in the working tree for the diagnostic HTTP pass; source/bundle hashes identify the exact code measured.

```sh
node scripts/profile-representative-insert.mjs
```

The default stages populate 1,004 and then 10,004 of 100,000 parent documents. Three synthetic owners have roughly equal parent counts, with about 45% of documents finalized. Four sources belong to the first owner: draft337, finalized411, draft411 and finalized337. Other populated documents have deterministically varied 300–450 lines and independently authored pricing inputs, descriptions and valid snapshots. All parents exist at every stage, physically grouped by owner; the remaining parents are empty. This is a bounded synthetic workload, not an exact clone of the populated database.

Options:

- `REPRESENTATIVE_LEVELS`: increasing populated-parent counts, 4–20,004; default `1004,10004`. Use `4` for a small smoke run or `10004` for one approximately 3.75-million-line stage.
- `REPRESENTATIVE_SAMPLES`: 5–100 plain SQL and trace-disabled HTTP samples per case; default 20.
- `REPRESENTATIVE_UUID_LOCALITY=1`: replace the baseline SQL/HTTP measurement phase with the paired UUID locality experiment described below. No HTTP candidate is exercised in this mode.
- `REPRESENTATIVE_UUID_HTTP=1`: run the endpoint/concurrency experiment below. Mutually exclusive with the SQL locality mode.
- `REPRESENTATIVE_SERIAL_COSTS=1`: run the serial decomposition below; mutually exclusive with both UUID modes.

The host filesystem must have at least 7 GiB free initially. Each committed 50-parent load batch checks a 5 GiB reserve. These are host free-space guards, not a guarantee about the container filesystem or future WAL growth. The level cap bounds fixture growth. Stop the process gracefully if other work consumes space.

## Measurement lifecycle

Owner IDs and synthetic email markers are durably recorded before any fixture commit. Parent creation commits, followed by one initial parent VACUUM/ANALYZE. Loading then updates populated parents naturally, clearing visibility bits. Each stage receives ANALYZE. There is **no per-sample VACUUM, REINDEX, policy change or JIT override**. Natural autovacuum is not disabled; timestamps, estimates, visibility and relation sizes are recorded before and after measurement. Inspect drift instead of assuming a stable physical layout.

The SQL harness extracts the exact `INSERT … SELECT` from the current duplicate route. Each fresh runtime-role transaction binds its owner, locks the source, inserts a destination parent, copies lines, and commits. Only the insert span is the principal SQL metric. The SQL slice does not perform the endpoint's pricing/projection work or update copied parent totals; its destination is verified and deleted immediately outside timing. Full HTTP copies separately exercise those product behaviors.

Five warmup rounds precede measured SQL. Plain insertion runs in every measured round; EXPLAIN ANALYZE TIMING OFF/ON also runs in the first five measured rounds, with probe order alternating. Plans capture BUFFERS, WAL, SETTINGS, trigger calls/time and I/O timing. The SQL worker explicitly enables track_io_timing before assuming pricing_runtime; the administrative/default setting may remain off. Plain measurements are authoritative for elapsed time; plans have recorder overhead and cover only early rounds.

The actual endpoint is bundled once from the current working tree and runs under runtime credentials. HTTP measures through response receipt and JSON parsing: a trace-disabled primary pass, then ten traced samples per case, each with five warmups. HTTP covers the draft337 and finalized411 sources; SQL additionally covers both states at both sizes. Copies must have fresh IDs, ordered inputs and independently computed prices; DELETE204/GET404 verifies removal. Full stored source-line snapshots and fixture counts must match after each stage. Child shutdown is tied to the profiler's IPC connection.

After timed work, `profile-index-probes.mjs` performs a privileged **read-only surrogate**: 337/411 fresh random UUID primary-key misses, immediately repeated with identical keys. It asserts a primary-key lookup plan with the expected loop count. These probes isolate index-page access from source ownership, writes, WAL and constraints. They are not insert timings. PostgreSQL buffer reads may come from the OS cache; reported I/O time does not identify physical device activity by itself. Do not clear global caches to manufacture a result.

## Evidence and recovery

Raw results, generated server, source hashes, trace records and a cleanup ledger live under ignored `.artifacts/representative-insert-<run-id>/`. Summarize a successful run with:

```sh
node scripts/profile-representative-report.mjs .artifacts/representative-insert-RUN-ID/results.json
```

Inspect plain insert medians and first/last halves, the selected source plan, ownership-node loops, FK time, root/source buffer differences, read/write I/O, WAL/FPI, and HTTP spans. Node totals include descendants; owner point-check times are rounded per-loop averages. The write-node residual includes destination checks and writes, not a pure index measurement. Staged levels are sequential observations rather than paired causal configurations. No p95 or confidence interval is reported.

On ordinary completion or error, the active server/worker stops before cleanup. Cleanup verifies the original policy records, synthetic owner markers and that every current tenant row belongs to the ledger. It locks the relevant tables and rechecks ownership before truncating this verified disposable fixture, then removes its users. It refuses unrelated users/documents or changed policies rather than deleting them. Policies are never rewritten, even during recovery. Zero users/documents/lines and unchanged policies are asserted afterward.

Abrupt termination may leave a committed fixture. Wait for its child to exit and recover using its original ledger:

```sh
node scripts/profile-representative-insert.mjs --cleanup .artifacts/representative-insert-RUN-ID/cleanup-ledger.json
```

Recovery is idempotent; retain the ledger until `phase` is `clean`. A new experiment refuses a nonempty database. Never alter a ledger or substitute one from another database.

For comparison with a populated database, use separate **BEGIN READ ONLY** sessions: catalog/storage/settings inventories, nonexecuting EXPLAIN of the insert, EXPLAIN ANALYZE of its source SELECT, and bounded primary-key probes. Do not run INSERT/DELETE or install candidate policies there. Match plan shape and cache-footprint conditions explicitly; matching source line count alone does not establish representativeness. Keep generated source observations out of Git and omit credentials/cookies from evidence.

## Compare UUID insertion locality without a migration

```sh
REPRESENTATIVE_UUID_LOCALITY=1 REPRESENTATIVE_LEVELS=10004 REPRESENTATIVE_SAMPLES=36 node scripts/profile-representative-insert.mjs
node scripts/profile-uuid-locality-report.mjs .artifacts/representative-insert-RUN-ID/results.json
```

This PostgreSQL 18 diagnostic compares three insert variants against the same existing UUIDv4 background:

1. The extracted endpoint insert, using the existing `gen_random_uuid()` column default.
2. The same insert with an explicit `id` generated by `gen_random_uuid()`, controlling for the changed SQL shape.
3. The same explicit-ID insert using native `uuidv7()`.

Only new copied line IDs differ. Parent IDs remain UUIDv4. Existing IDs, column defaults, RLS policies, indexes and constraints are never rewritten. The runtime role normally lacks permission to insert the `id` column, so this mode asserts that restriction, durably records recovery intent, and temporarily grants only `INSERT(id)` on the disposable table. All three arms share that permission. Normal/error/recovery cleanup revokes it and compares column ACLs with the original snapshot. Do not use this diagnostic grant as a proposed application permission change.

Five warmup rounds precede measurement. Six permutations counterbalance the three variants; choose a sample count divisible by six for equal ordering coverage. Source-case order also reverses across rounds. TIMING OFF/ON plans are spread across the run, separate from plain latency measurements. The summary reports paired savings against the unchanged default, both relative execution orders, explicit-ID control, first/last halves, root read/write/WAL counters, source reads/time and FK time. Buffer counters cover the top-level ModifyTable node and child plans and can include OS-cache reads; they are not isolated physical-device or primary-key-only misses.

Committed copies stay live through the measurement phase so the UUIDv7 key range grows. Every copy must preserve ordered inputs, clear finalized snapshots, have the expected UUID version and fresh unique IDs, and pass the existing database constraints under active runtime RLS. The copies are removed after timing; complete source-line snapshots, fixture counts, policies, defaults, index definitions, constraints and restored column ACLs must match. Generated evidence records fixture growth and maintenance statistics. Recovery uses the same ledger command above.

This is a serial SQL experiment, not a migration, endpoint improvement claim or concurrent-throughput test. UUIDv7 should cluster writes around a narrow timestamp range even while old UUIDv4 keys remain; it does not make arbitrary old-key reads local. Assess generation-time disclosure and concurrent writer contention before adoption. A bounded fixture cannot predict the exact gain at a larger storage/cache footprint.

## Validate UUIDv7 through HTTP and concurrent writes

```sh
REPRESENTATIVE_UUID_HTTP=1 REPRESENTATIVE_LEVELS=10004 REPRESENTATIVE_SAMPLES=24 node scripts/profile-representative-insert.mjs
node scripts/profile-uuid-http-report.mjs .artifacts/representative-insert-RUN-ID/results.json
```

This mode keeps the compiled endpoint and its runtime privileges unchanged. It temporarily switches **only the disposable `line_items.id` default** between `gen_random_uuid()` and `uuidv7()`. No migration runner or migration file is used. The normal insert omits `id`, so the real endpoint receives the selected database default. Source IDs and parent defaults remain UUIDv4; the scalar ownership policy is not installed. The ledger records the original default and database identity before any default change. Every switch checks all other defaults, constraints, index definitions, column ACLs and policies. DDL runs outside request timing, only after preceding requests settle, with a three-second lock timeout.

Check free space on the database's actual filesystem before a large run; host free space alone is insufficient. Budget for the background fixture, retained copies, WAL and cleanup. Use a smaller level such as `5004` when database storage cannot accommodate the larger stage with headroom. Do not clear unrelated database/container data to make room.

The actual runtime connection is checked for `pricing_runtime`, no superuser/BYPASSRLS, active document/line RLS, and no `INSERT(id)` privilege. Eight ordinary fixture sessions are seeded with hashed random tokens and verified through `/auth/session`; tokens and cookies never enter result artifacts. This avoids changing sign-in limits and prevents session-row refresh locks from serializing the primary concurrent workload. Login/password performance is outside scope. The app uses its existing shared connection pool.

Eight distinct 337-line draft sources are created through the original endpoint. Workloads are serial draft337, serial finalized411, distinct-source bursts of 2/4/8 requests, and an eight-request same-source control. Each concurrent lane uses its own session. The same-source control intentionally includes the endpoint's source-row lock serialization. Distinct-source bursts use equal-sized sources owned by the same tenant.

Even measured rounds run UUIDv4 first and odd rounds UUIDv7 first; workload order rotates. Each variant remains active for the six workloads in a round. Three warmup rounds precede each pass. Trace-disabled requests are the primary timing pass; six separately traced rounds provide insertion, source-lock, auth, pool-entry and projection spans. Every burst awaits all requests through response receipt/JSON parsing before validation. Per-request durations overlap and must not be summed into burst time. Aggregate burst throughput excludes setup, validation, default switches and gaps, so it is not sustained production capacity. DDL plan invalidation and shared client/server processes are additional limits of the controlled experiment.

Every copy is checked against the independent pricing oracle, retrieved through HTTP, checked for UUID version and globally fresh IDs, verified in storage for ownership and absent finalized snapshots, and tested for foreign-owner privacy. Both defaults also receive unauthenticated/foreign/missing/invalid-input isolation checks. Complete source snapshots must remain unchanged. A UUIDv7 copy exercises editing, reordering, finalization, finalized-delete rejection and ordinary draft deletion outside performance timing.

Copies remain live across both passes, so report initial and final counts and inspect first/last-half paired effects and maintenance statistics. The dataset grows; it is not a fixed steady-state workload. After measured passes, separate eight-source diagnostic bursts sample `pg_stat_activity` to check overlapping insert statements. These samples are outside primary measurements; `state=active` includes waiting queries, so examine wait fields and do not equate overlapping statements with simultaneous CPU execution.

Cleanup stops the app before restoration. Under the fixture cleanup lock it verifies owner IDs/email markers and database identity before restoring defaults or permissions. It checks the restored schema before truncating the owned fixture. Replaying a clean ledger refuses a changed schema; unrelated owners are rejected before restoration. The same `--cleanup` command handles ordinary, error and interrupted runs. Validate crash recovery after UUIDv7 activation and repeat recovery to confirm idempotence. The report command rejects runs with errors or unverified restoration.

If measurement finished but cleanup failed, retain the original result unchanged. After successful ledger recovery, the reporter can accept the recovery run's `results.json` as a second argument. It requires the matching original run ID, no recovery errors, restored schema/policies and zero fixture counts, and explicitly records the original cleanup failure. Recovery establishes final state, not unbiased performance: storage-pressure runs require a separate timing caveat or a repeat with adequate headroom.

## Isolate serial insertion costs

```sh
REPRESENTATIVE_SERIAL_COSTS=1 REPRESENTATIVE_LEVELS=2504 REPRESENTATIVE_SAMPLES=36 node scripts/profile-representative-insert.mjs
node scripts/profile-serial-costs-report.mjs .artifacts/representative-insert-RUN-ID/results.json
```

Use this only on the guarded, empty disposable database with no other traffic. The mode uses its existing bootstrap connection to run rollback-only diagnostic transactions against the real fixture table. It never commits an altered default, index, constraint, trigger or policy, and does not apply migrations or edit the app. It requires PostgreSQL 18 and the current two-index, one-FK, nine-CHECK line schema. The database filesystem check uses a fixed read-only `df` command through `COPY FROM PROGRAM`, requires the known `/var/lib/postgresql/` data-directory prefix and 1 GiB initially, and checks a 600 MiB reserve before each load batch and after each measured round. The ordinary host checks still apply. Smaller levels reduce the cache footprint; preserve that limitation in interpretation.

For each draft337/finalized411 source and UUIDv4/v7, measure these arms:

- Exact endpoint insert, using a transaction-local default.
- Preloaded source with the same destination columns and no RETURNING. Source materialization happens under runtime RLS outside timing. This removes source authorization, reads and row numbering together.
- Preloaded source with RETURNING, the common baseline for all ablations. Returning values allows verification without a background-heap scan when the document-position index is absent. Its overhead has its own control above.
- Individually disabled FK INSERT trigger, removed CHECKs, removed primary-key constraint/index, or removed document-position unique constraint/index.
- Privileged-role comparison using the staged input; this is a role/RLS-bypass sensitivity, not a pure policy clock.
- Combined floor without those indexes, FK/CHECKs or RLS. It still includes heap/WAL, UUID generation, NOT NULL checks, executor, RETURNING and client transport.

Each rollback arm takes the same exclusive line-table lock. DDL, source staging, tenant binding, source lock and parent creation are outside the insertion timer. Actual runtime arms assert active RLS; the bypass role is explicitly verified. Policies are not rewritten. The FK trigger is selected from live catalogs by its constraint OID and INSERT event, preserving other triggers. Constraints are dropped without CASCADE. Rollback restores the existing indexes without rebuilding them; catalog OIDs/definitions, trigger states, RLS flags, defaults and table/column ACLs must match after every trial. Returned plain samples verify ordered inputs, cleared snapshots, UUID version and fresh IDs; EXPLAIN samples assert returned row counts. Exact/preloaded arms verify stored copies before rollback. Source snapshots and total counts match after the phase.

Use 36 plain rounds to cover every position in the 18-cell schedule in both forward and reverse order. Separate TIMING OFF/ON passes collect four rounds each, preceded by two warmups. Those smaller plan passes have diagnostic ordering coverage, not full position balance. Unmodified committed UUIDv4 anchors bracket the rollback phase, with COMMIT measured immediately after the insert; committed copies are verified then deleted outside timing. Read-only runtime/privileged source plans further distinguish source work from destination work.

A separate read-only generator probe compares UUIDv4, UUIDv7 and a NULL-projection control over 337/411 rows, with 36 rounds covering all six arm permutations. It measures executor/generator work without row insertion, indexes or WAL; do not subtract its timing directly from the insertion measurements.

Show paired differences, both halves, all outliers, source plans, FK aggregate trigger times, buffer I/O and WAL volume. Differences are non-additive sensitivities. Rollback preserves logical state but leaves physical dead tuples/index entries, WAL and cache effects; record drift and maintenance. The smaller fixture can choose a different ownership plan and fit more index pages in cache. Neither WAL byte counts nor the combined floor isolate WAL CPU from heap/executor work. Do not switch the populated table to UNLOGGED or infer durable commit latency from rollback trials. Report unsupported attribution explicitly instead of assigning every millisecond a cause.
