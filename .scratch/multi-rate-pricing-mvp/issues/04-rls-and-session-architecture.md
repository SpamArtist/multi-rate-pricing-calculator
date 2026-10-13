Type: research
Status: resolved

## Question

What implementation pattern for password-based sessions and Postgres row-level security works reliably with Node.js, Drizzle, and pooled connections? Compare primary-source guidance on request-scoped database identity, transaction boundaries, table policies, and migration privileges; recommend an MVP pattern for later decision.

## Answer

Primary-source research recommends a non-owner, `NOBYPASSRLS` runtime role; explicit `USING` and `WITH CHECK` ownership policies; and a transaction-local `app.user_id` set before every tenant query through the same Drizzle transaction. For passwords and sessions, it recommends Argon2id and server-side opaque session tokens in secure HttpOnly cookies. These are input to [Auth and ownership contract](05-auth-and-ownership-contract.md), where the product decision remains open.

Research asset: branch `research/rls-session-architecture`, commit `77d6976`, file `research/rls-session-architecture.md` (worktree: `/private/tmp/multi-rate-rls-research`). The note includes source links, caveats, and verification cases.
