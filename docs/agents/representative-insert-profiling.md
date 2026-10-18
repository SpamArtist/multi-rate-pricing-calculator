# Investigate insertion cost at a larger data footprint

`node scripts/profile-representative-insert.mjs` loads an empty disposable database, measures the unchanged duplication insert and actual HTTP endpoint, and removes its fixtures. It never installs the scalar policy, applies migrations, changes indexes, changes column statistics options, or edits product code.

Use only an empty, already migrated `127.0.0.1:5433/pricing` without other traffic. Database URL guards reject other addresses. The shared profiler advisory lock excludes cooperating profilers. Defaults use the repository's local bootstrap and runtime credentials; override `REPRESENTATIVE_DATABASE_URL` and `REPRESENTATIVE_RUNTIME_URL` if needed. HTTP port 4194 must be unused. Runtime privileges and active table RLS are asserted. Existing duplication tracing must be available in the working tree for the diagnostic HTTP pass; source/bundle hashes identify the exact code measured.

```sh
node scripts/profile-representative-insert.mjs
```

The default stages populate 1,004 and then 10,004 of 100,000 parent documents. Three synthetic owners have roughly equal parent counts, with about 45% of documents finalized. Four sources belong to the first owner: draft337, finalized411, draft411 and finalized337. Other populated documents have deterministically varied 300–450 lines and independently authored pricing inputs, descriptions and valid snapshots. All parents exist at every stage, physically grouped by owner; the remaining parents are empty. This is a bounded synthetic workload, not an exact clone of the populated database.

Options:

- `REPRESENTATIVE_LEVELS`: increasing populated-parent counts, 4–20,004; default `1004,10004`. Use `4` for a small smoke run or `10004` for one approximately 3.75-million-line stage.
- `REPRESENTATIVE_SAMPLES`: 5–100 plain SQL and trace-disabled HTTP samples per case; default 20.
- `REPRESENTATIVE_UUID_LOCALITY=1`: replace the baseline SQL/HTTP measurement phase with the paired UUID locality experiment described below. No HTTP candidate is exercised in this mode.

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
