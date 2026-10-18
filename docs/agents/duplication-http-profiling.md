# Validate duplication policies through HTTP

Run `node scripts/profile-duplication-http.mjs` to compare the original line-item ownership policy with the scalar lookup through the actual `POST /documents/:id/duplicate` endpoint. The experiment temporarily changes only the policy's USING clause in a disposable database. It does not apply migrations or edit product code.

## Preconditions and command

Use an empty, migrated, disposable PostgreSQL database at `127.0.0.1:5433/pricing`, with no other application or test traffic. The harness rejects other database addresses and an occupied HTTP port 4194. It shares the SQL profiler's advisory lock; this excludes cooperating profilers, not arbitrary application writers.

```sh
node scripts/profile-duplication-http.mjs
```

Default URLs use the repository's local bootstrap, runtime and migrator roles. Override `HTTP_PROFILE_DATABASE_URL`, `HTTP_PROFILE_RUNTIME_URL`, and `HTTP_PROFILE_MIGRATOR_URL` if necessary. URLs are not written to evidence. The child server and test suite receive explicit disposable URLs for all three roles, so a local `.env` cannot redirect them to the populated database. The endpoint runs as `pricing_runtime`, checked to be neither superuser nor BYPASSRLS, with forced RLS on documents and line items.

Options:

- `HTTP_PROFILE_SAMPLES`: 1–100 trace-disabled samples per case and policy; default 40.
- `HTTP_PROFILE_TRACED_SAMPLES`: 1–100 trace-enabled samples per case and policy; default 10.
- `HTTP_PROFILE_PARENTS`: distinct comma-separated owner document counts, 8–100,000, up to four; default `100,33086`.

There are five warmups per case, policy and tracing mode. Each population includes draft and finalized sources of 2/40/337/411 lines, plus twice as many foreign-owned documents and a foreign source. Fixtures contain 1,581 line items across both owners. Sources and authentication sessions are created through HTTP; unrelated empty parents are inserted by bootstrap. Fixture line inputs vary quantity, unit price, discount and tax. A separate BigInt oracle checks copied line amounts and document totals.

## What is measured

The harness builds the current working tree's server once with the production esbuild bundling options. Evidence records the Git HEAD, bundle hash and every bundled source hash. Both policies use that identical build, including any existing uncommitted changes. The generated entry adds only parent-disconnect shutdown handling. Existing endpoint tracing must be available for the traced pass; failure to collect every measured request's trace is an error.

The primary measurement runs with tracing disabled and covers HTTP request start through receipt and `JSON.parse`. It separately records time to headers, body receipt and JSON parsing. A separate pass enables the existing endpoint spans, joined by `X-Duplication-Request-Id`. Every measured trace must have a successful response, expected copied-row count and matching response bytes. Traced and untraced passes are sequential, so their difference is not a causal recorder-overhead estimate. Server finish timing does not include the client's receipt/parse time. Nested spans overlap; do not sum parent and child spans.

Policy order alternates each round and case order rotates. Each policy installation commits before runtime work; its DDL lock is absent from timed requests. Both variants execute ALTER POLICY. Only USING changes; WITH CHECK and all other policy properties are verified unchanged. The scalar expression is the same candidate used by [the SQL profiler](line-insertion-profiling.md); it can perform one parent lookup per line rather than one lookup per document.

Before each population, empty heaps are vacuumed with forced index cleanup/truncation and checked to be empty. Indexes are rebuilt after fixture creation. Before every timed copy, tables are vacuumed/analyzed with forced index cleanup, outside timing. Starting sizes and estimates are saved for each sample. This controls storage/statistics drift but creates a warm-cache, maintenance-heavy workload. It is not a production load, concurrency-throughput, cold-cache or tail-latency benchmark. Large owners have many empty parents, not millions of unrelated line items.

Each copy commits through the endpoint, is checked for fresh IDs, exact response shape, input order, independently calculated amounts, stored draft totals and absence of finalized snapshots, then is deleted through HTTP and verified missing. These checks and deletion are outside timing. Source HTTP responses and full stored source rows must remain unchanged across the experiment.

## Correctness and recovery

Before population setup, the existing `tests/api/document-duplication.test.ts` suite runs under each policy, including divergent finalized snapshots. For each population and policy, additional HTTP probes check unauthenticated denial, foreign/missing indistinguishability, invalid date rejection without writes, alternating owner visibility, and two concurrent complete, distinct and private copies. Alternating HTTP owners does not prove that the same pooled connection was reused; transaction binding is separately covered by the SQL profiler. These are correctness probes, not contention benchmarks.

A durable cleanup ledger is written before signup or the test suite can commit fixtures. It records only synthetic owner email markers and the original policy, never passwords or cookies. The three fixed duplication-suite fixture emails are explicitly allowlisted because those tests own their cleanup during ordinary completion. Ledger updates flush a temporary file and atomically rename it. Child processes receive parent-disconnect shutdown handling; regular shutdown stops the active child before database restoration.

Ordinary success or failure restores the exact original policy, deletes only recorded fixture owners (cascading their data), and checks zero users/documents/lines. Abrupt termination can leave committed fixtures and the temporary scalar policy. Wait for any child to terminate, then recover with that run's ledger:

```sh
node scripts/profile-duplication-http.mjs --cleanup .artifacts/http-policy-RUN-ID/cleanup-ledger.json
```

Recovery is idempotent. Do not alter the ledger or substitute one from another run/database. Keep it until its phase is `clean`. The empty-database guard refuses to start a fresh experiment over abandoned fixtures. HTTP requests have a 30-second timeout; administrative statements have a 30-second statement timeout and two-second lock timeout.

Raw results, joined traces, suite output, the generated server, hashes, relation sizes, correctness results and cleanup status are saved under ignored `.artifacts/http-policy-<run-id>/`. `summary.json` reports per-case medians and same-round paired savings, positive-pair counts and first/last-half drift. Median means sorted index `floor(n/2)`. No p95 or confidence interval is reported. Inspect trace-disabled latency first, then use trace spans for attribution. Preserve the distinction between the synthetic endpoint measurements and timings from a populated local seed.
