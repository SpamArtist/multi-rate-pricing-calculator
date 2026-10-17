# Coding standards

## Test independence

Tests must still run and validate product behavior if `prototype/` is removed. Build test inputs and expected results from documented product contracts or independently authored fixtures. Do not copy or derive fixtures, baselines, or expected values from prototype code, sample data, screenshots, or runtime output.

When reviewing a test change, check where its fixtures and expected values came from. A passing test is insufficient if its expected result came from a prototype. Direct references are blocked by CI; review must catch copied or derived dependencies.

## Backend architecture

Review new and substantially changed backend flows against `docs/agents/backend-architecture.md`. HTTP adapters should handle transport concerns; use-case modules should coordinate business decisions and one tenant transaction; persistence functions should own Drizzle queries and SQL while using that transaction. Check the whole flow, not whether a query uses raw SQL or the query builder. Existing mixed handlers are migration work, not a pattern to copy. An isolated fix need not restructure an unrelated workflow.
