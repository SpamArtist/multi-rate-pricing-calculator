# Backend architecture

Use these seams for new backend flows and substantial changes to existing ones. The current handlers predate this layout; migrate a touched workflow as a coherent unit rather than copying their mixed responsibilities.

## Flow and ownership

`HTTP adapter → use-case module → persistence functions → PostgreSQL`

- **HTTP adapter** (`src/server/http/` for new routes): authenticate, parse request data, call one use-case interface, and map outcomes to HTTP status and JSON. Do not import Drizzle, table schema, or the database client. Do not build queries here.
- **Use-case module** (`src/server/`): own the application operation and its transaction boundary. Coordinate validation, idempotency, state transitions, and calls to persistence functions. Return typed outcomes, not Express responses. Keep SQL and table-specific Drizzle calls inside persistence functions.
- **Persistence functions** (`src/db/` for new functions): own table access and SQL. Accept the caller's `TenantTransaction` for tenant data; do not open a separate transaction inside an operation. Return the rows or domain data the use case needs, and keep HTTP types out.
- **Pure rules** (`src/shared/`): keep calculations and reusable validation independent of Express and the database.

`withTenantTransaction(authenticatedOwnerId, operation)` binds tenant identity before the operation runs. Every read and write that belongs to one save must use that same transaction. Keep database uniqueness, row-level security, and constraints as the final enforcement of concurrency and data integrity. A query builder may replace SQL syntax, but does not change module ownership.

Authentication creates or finds users before there is an authenticated tenant owner; those non-tenant operations use their own DB access path. Keep their transport and persistence responsibilities separate too.

## Draft-save example

The save operation must claim `(owner_id, mutation_id)`, detect replay or conflict, lock an existing draft, replace its ordered lines, update metadata, and store the response in one transaction. `ON CONFLICT DO NOTHING RETURNING` identifies which request claimed the mutation. Preserve that behavior when moving queries.

Today `src/server/draft-save.ts` contains the HTTP adapter, use-case decisions, and direct queries. `src/server/line-set-persistence.ts` shows a persistence function that accepts the caller's transaction. `src/db/client.ts` owns transaction setup. `tests/api/draft-save.test.ts` covers replay, conflict, concurrent retries, and atomicity.

For a small fix in an existing mixed handler, preserve its current behavior and avoid adding another query there. For a new workflow or a substantial change, extract the touched workflow into the seams above. Do not add a generic repository interface merely to wrap one database implementation; use narrow operations that hide meaningful persistence details.
