# Multi-Rate Pricing Calculator MVP — implementation spec

**Status:** Approved production-build handoff, 14 October 2026. This document consolidates the accepted decisions and the user-approved clarifications from [Implementation-ready spec handoff](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/8).

## 1. Product boundary

Build a EUR web app for one registered person to prepare generic priced **documents** for customers. A document is a draft or an immutable finalized snapshot. Owners can find, duplicate, and print their own documents. A separate summary report aggregates finalized documents by issue date.

There are no formal quote or invoice types, team accounts, sharing, payment collection, tax-jurisdiction logic, compliance claims, delivery by email, or hosted-production requirements in this MVP. [Map and scope](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/1).

Use TypeScript, Node.js, React, Postgres, and Drizzle. The browser displays EUR amounts, while the API and DB use integer cents. Quantities are whole numbers. Calendar dates are `YYYY-MM-DD` values, never timestamps. [Map notes](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/1).

## 2. Domain and state

- A **document owner** is the single registered user who owns a document. A **customer** is the person or organization named on it. The MVP stores a customer display name on the document, not a shared customer record.
- A **line item** has a description, positive whole-number quantity, unit price, fixed line discount, and tax rate. Its description may be blank in a draft but is required at finalization. Its position determines print and editor order. Its ID stays stable while its draft is edited.
- A **draft** has a nonblank title and valid issue date, but may have no customer or line items. Only its owner can edit it. A **finalized document** preserves its title, customer name, issue date, ordered line inputs, and calculated amounts as a fixed snapshot. Finalization cannot be undone.
- A new document exists only in browser editing state until **Save as draft** or **Finalize**. An unsaved document has no server ID and cannot be duplicated. Finalizing a new document first creates the draft and then finalizes it. If finalization validation fails, the saved draft stays editable.
- Duplicating a saved draft or finalized document creates a separate draft with new document and line IDs, copied title, customer name, and ordered line inputs. The caller supplies the new issue date. The source is unchanged.

These state rules implement [Document lifecycle and REST API](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/3), [Auth and ownership contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/6), and the selected [Dashboard and editor prototype](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/7). The shared glossary is in [CONTEXT.md](../CONTEXT.md).

### Required fields

Saving a draft requires a nonblank title and valid issue date. Finalization additionally requires a nonblank customer name and at least one line item; every line item must have a nonblank description and valid numeric inputs. Line descriptions may be blank only in drafts. The user confirmed these clarifications during this handoff review. They supersede the `POST {}` acceptance example in [Document lifecycle and REST API](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/3); the rule that drafts may omit a customer or line items remains.

## 3. Calculation contract

For each line, calculate with exact integer arithmetic before range checks and rounding:

```text
lineSubtotalCents  = quantity × unitPriceCents
taxableLineCents   = lineSubtotalCents − discountCents
lineTaxCents       = roundHalfUp(taxableLineCents × taxRateBasisPoints / 10,000)
lineTotalCents     = taxableLineCents + lineTaxCents
```

The document subtotal, discount, taxable amount, tax, and total are the sums of the corresponding **line** amounts. Round each line's tax once, then sum. Never calculate tax on the document aggregate. Server calculations are authoritative; browser calculations are previews. Use exact intermediate arithmetic, such as `bigint`, and reject any entered or derived cent amount beyond JavaScript's safe-integer range before serializing JSON numbers.

Quantity must be an integer at least 1. Unit price and discount are nonnegative integer cents. Discount cannot exceed the line subtotal. Tax is integer basis points from 0 to 10,000 inclusive; `750` means 7.50%. Missing discount or tax defaults to zero; explicit `null` is invalid. Zero price, discount, and tax are valid. Reject malformed, nonnumeric, negative, fractional, or unsafe inputs. The UI accepts EUR amounts with at most two decimals and tax percentages with at most two decimals from 0 to 100.00%.

| Example | Subtotal | Discount | Taxable | Tax | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 × €19.99; €10.00 fixed discount; 19.00% tax | €59.97 | €10.00 | €49.97 | €9.49 | €59.46 |
| 2 × €2.50; no discount; 7.50% tax | €5.00 | €0.00 | €5.00 | €0.38 | €5.38 |
| **Document** | **€64.97** | **€10.00** | **€54.97** | **€9.87** | **€64.84** |

A €0.01 taxable line at 50.00% has €0.01 tax. Two such lines have €0.02 total tax. An empty draft has €0.00 for every amount. [Calculation contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/2).

## 4. Storage model

Names below describe logical tables and constraints; migration syntax may vary. Use UUIDs as opaque IDs. Store monetary fields as `bigint` in Postgres but expose only safe-range integer JSON numbers. No client may choose an owner ID, status, or calculated amount.

| Table | Required columns and constraints |
| --- | --- |
| `users` | `id` UUID PK; `email_display` trimmed text; `email_canonical` unique lowercase text; `password_hash` Argon2id encoded hash; `created_at` timestamp. |
| `sessions` | `id` UUID PK; `user_id` FK; unique `token_hash`; `created_at`, `last_activity_at`, `expires_at` timestamps; revocation by row deletion. A separate row exists per login. |
| `documents` | `id` UUID PK; `owner_id` FK; nonblank `title` text; `customer_name` text default empty; nonnull `issue_date` date; `status` draft/finalized; `created_at`, `updated_at`, nullable `finalized_at`; finalized subtotal, discount, taxable, tax, and total cents snapshot fields. Check title/date at save and finalized customer completeness; validate nonnegative, safe-range snapshot amounts. |
| `line_items` | `id` UUID PK; `document_id` FK with cascade on draft deletion; `position` positive integer unique per document; `description` text default empty; `quantity` positive bigint; `unit_price_cents` nonnegative bigint; `discount_cents` nonnegative bigint; `tax_rate_basis_points` integer 0–10,000; finalized subtotal, taxable, tax, and total cents snapshot fields. Validate quantity's JSON safe range, discount against subtotal, and derived safe ranges in application logic. |

Draft totals are recalculated from current line inputs for every read/write response; finalization writes the final line and document amount snapshots in the same transaction as the status transition. Reads of finalized documents use those snapshots, so later calculation-code changes cannot silently alter them. Keep finalized rows immutable in application logic. A DB constraint or trigger may reinforce that rule, provided duplication still copies inputs into new draft rows. Lock the document row while finalizing or mutating it so concurrent requests cannot bypass the state transition.

### Ownership enforcement

Migration/owner and runtime DB roles are separate. The runtime role is `NOSUPERUSER NOBYPASSRLS`, does not own tenant tables, and has narrow grants. Enable RLS on `documents` and `line_items`; use both `USING` and `WITH CHECK`. A line item's owner is its parent document's owner, including during insert or attempted reparenting. Server code authenticates first, opens one Drizzle transaction, sets transaction-local `app.user_id`, and uses that same transaction for every tenant query. Missing identity fails closed. Parameterize SQL. The custom setting guards trusted queries against missing tenant filters; it does not contain arbitrary SQL execution. [RLS and session architecture](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/5), [Auth and ownership contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/6).

## 5. Authentication and sessions

Email input is trimmed. Preserve the trimmed case-retaining value for display; use a lowercase canonical value for uniqueness and lookup. Browser checks are immediate; server format validation is authoritative. Duplicate canonical sign-up email returns `409` with “Email already registered.” This deliberately reveals account existence at sign-up; throttle abuse.

For both sign-up and sign-in, trim surrounding Unicode whitespace from the password, reject remaining whitespace, and require 6–10 Unicode code points inclusive. Symbols are allowed; never truncate. Store only a salted Argon2id hash with at least OWASP's minimum work parameters. This short password maximum is an explicit product decision. [Auth and ownership contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/6).

Sign-up and sign-in create a fresh random opaque token. Store only its hash in `sessions`. Return the token in a host-scoped `Secure; HttpOnly; SameSite=Lax` cookie; enforce 24 hours idle and seven days absolute expiration server-side. Multiple devices can stay signed in. Logout revokes only the current token and clears its cookie. Check request origin or a CSRF token on all state-changing cookie-authenticated requests. Throttle repeated sign-in attempts by canonical email and IP. Do not log passwords or tokens.

### Proposed auth endpoints

| Method and route | Request | Success |
| --- | --- | --- |
| `POST /auth/sign-up` | `{ "email": string, "password": string }` | `201` `{ user: { id, email } }` and session cookie |
| `POST /auth/sign-in` | Same | `200` `{ user: { id, email } }` and fresh session cookie |
| `GET /auth/session` | Cookie | `200` `{ user: { id, email } }` |
| `POST /auth/logout` | Cookie and origin/CSRF proof | `204`, revoke current session, clear cookie |

`email` in responses is the display value. Invalid sign-in credentials, including unknown email, return the same `401` “Invalid email or password.” Missing or expired session returns `401`; the browser returns to sign-in while preserving unsaved input where feasible. Throttling returns `429`. The route names and response shapes above are proposed handoff choices; observable behavior is settled in [Auth and ownership contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/6).

## 6. Document API

All routes below require a session. Responses are JSON except `204`. `Document` responses use this shape; `LineItem` uses the nested line shape. Amounts and totals are server-derived. `finalizedAt` is `null` while a document is a draft.

```json
{
  "id": "opaque-uuid",
  "title": "Brand workshop",
  "customerName": "Alpen Studio",
  "issueDate": "2026-10-14",
  "status": "draft",
  "createdAt": "2026-10-14T08:00:00Z",
  "updatedAt": "2026-10-14T08:00:00Z",
  "finalizedAt": null,
  "lineItems": [{
    "id": "opaque-uuid", "position": 1, "description": "Brand workshop",
    "quantity": 3, "unitPriceCents": 1999, "discountCents": 1000,
    "taxRateBasisPoints": 1900,
    "amounts": { "subtotalCents": 5997, "discountCents": 1000,
      "taxableCents": 4997, "taxCents": 949, "totalCents": 5946 }
  }],
  "amounts": { "subtotalCents": 5997, "discountCents": 1000,
    "taxableCents": 4997, "taxCents": 949, "totalCents": 5946 }
}
```

IDs and timestamps above illustrate shape, not literal values. No response includes `ownerId`, password data, or session token. An empty draft has `lineItems: []` and zero amounts. All document detail responses order line items by position, then ID as tie-breaker.

| Method and route | Request | Success | State rule |
| --- | --- | --- | --- |
| `POST /documents` | Required `title`, `issueDate`; optional `customerName` | `201` `Document` draft | Reject blank title, absent/invalid date, client state/amount fields, and other unknown fields. |
| `GET /documents` | List query below | `200` list envelope | Owner's documents only. |
| `GET /documents/{id}` | — | `200` `Document` | Owner's document only. |
| `PATCH /documents/{id}` | Any nonempty subset of `title`, `customerName`, `issueDate` | `200` `Document` | Draft only; omitted fields unchanged. |
| `DELETE /documents/{id}` | — | `204` | Permanently delete draft and its lines. |
| `POST /documents/{id}/line-items` | `description?`, `quantity`, `unitPriceCents`, `discountCents?`, `taxRateBasisPoints?`, `position?` | `201` `LineItem` | Draft only; default description empty, discount/tax zero, position at end. |
| `PATCH /documents/{id}/line-items/{lineItemId}` | Any nonempty subset of the line input fields or `position` | `200` `LineItem` | Draft only; omitted fields unchanged, stable ID. |
| `DELETE /documents/{id}/line-items/{lineItemId}` | — | `204` | Draft only; renumber remaining positions. |
| `POST /documents/{id}/finalize` | Empty object or no body | `200` `Document` finalized | Validate completeness and calculated amounts; atomic snapshot. |
| `POST /documents/{id}/duplicate` | `{ "issueDate": "YYYY-MM-DD" }` | `201` `Document` draft | Copy title, customer, and ordered line inputs; new IDs; preserve source. |

`title`, `customerName`, and `description` are strings; trim surrounding whitespace on persistence. A blank title is invalid at create and PATCH; a blank customer or line description is valid only in a draft. A saved line requires a valid quantity and unit price even in a draft; an unfinished line form can remain local in the browser until those values are valid. Every saved document has a real calendar `issueDate` in `YYYY-MM-DD` form. Omitting it on PATCH leaves it unchanged; explicit `null` is invalid. Duplicate always requires a valid date. The UI defaults the date of a new document and duplicate to the viewer's local today, then sends that date explicitly. The server does not substitute its own clock.

For line insertion, `position` ranges from 1 through current count + 1. For line repositioning, it ranges from 1 through current count. Inserting/moving shifts neighboring lines and leaves contiguous 1-based positions. The server validates the resulting complete line after PATCH, recalculates its amounts, and rejects discount-over-subtotal even when quantity or price changes. A mutation that would make document or line amounts unsafe fails without partial writes.

### List endpoint

`GET /documents?search=&status=all|draft|finalized&issueDateStart=&issueDateEnd=&sort=desc|asc&page=1`. All query parameters are optional; defaults are no search/date/status filtering, descending issue date, page 1. Trim `search`; match `customerName` case-insensitively by substring. Combine active filters with AND. Date endpoints are inclusive and may stand alone. Compare date values without timezone conversion. Sort by issue date only; use ID ascending as a stable tie-breaker. Return 25 rows per numbered page. Changing a browser filter or sort resets to page 1.

```json
{
  "items": [{ "id": "opaque-uuid", "title": "Brand workshop",
    "customerName": "Alpen Studio", "issueDate": "2026-10-14",
    "status": "draft", "amounts": { "subtotalCents": 5997,
      "discountCents": 1000, "taxableCents": 4997,
      "taxCents": 949, "totalCents": 5946 } }],
  "page": 1, "pageSize": 25, "totalItems": 1, "totalPages": 1
}
```

The list excludes nested line items but includes current totals. `page` must be a positive integer. A requested page beyond the end returns `items: []` and the accurate totals. The browser should reset its page when filters or sort change. A reversed supplied date range is invalid, not an empty result. [Report and dashboard semantics](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/4).

### Summary endpoint

`GET /reports/summary?start=YYYY-MM-DD&end=YYYY-MM-DD` requires both valid dates with `start <= end`. It is independent of `/documents` list query state. The UI initially sends the viewer's current local-calendar month, first through last day; the server never guesses the viewer's month. Count each owned finalized document once if its **issue date** falls in the inclusive range. Sum its snapshotted subtotal, discount, taxable, tax, and total amounts. An empty range returns count 0 and zero amounts. A document finalized in October with a September issue date belongs to September's report.

```json
{
  "start": "2026-10-01", "end": "2026-10-31",
  "finalizedDocumentCount": 1,
  "amounts": { "subtotalCents": 6497, "discountCents": 1000,
    "taxableCents": 5497, "taxCents": 987, "totalCents": 6484 }
}
```

The numeric example illustrates the two-line document in the [Calculation contract](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/2); the report includes its amounts only if that document is finalized and dated inside the range. [Report and dashboard semantics](https://github.com/SpamArtist/multi-rate-pricing-calculator/issues/4).

### Error contract

```json
{ "error": { "code": "validation_failed", "message": "Check the highlighted fields.",
  "fields": { "issueDate": "Enter a valid calendar date." } } }
```

Use stable machine-readable `code`, user-readable `message`, and optional `fields` keyed by request field path, for example `lineItems[0].quantity`. `422 validation_failed` covers invalid values, incomplete finalization, bad/reversed dates, missing duplicate date, and invalid pagination/filter parameters. Field messages identify every known validation failure in a request. `401 unauthenticated` covers absent/expired sessions; `401 invalid_credentials` covers sign-in. `403 invalid_origin` covers a failed origin/CSRF check. `404 not_found` is identical for nonexistent and other-owner document/line IDs. `409 invalid_state` covers edits, line mutation, deletion, or repeat finalization after finalization; `409 email_registered` covers duplicate sign-up. `429 rate_limited` covers throttling. Errors never disclose another owner's existence. Retrying a failed finalization cannot partially freeze a draft.

## 7. UI and print contract

Implement **Variant B · Ledger** from the [reviewed runnable prototype](https://github.com/SpamArtist/multi-rate-pricing-calculator/tree/LLM/prototype-dashboard-editor/prototype/dashboard-editor) at [114b357](https://github.com/SpamArtist/multi-rate-pricing-calculator/commit/114b357). The dashboard is a title-first, row-clickable document table. IDs stay internal to routing. There is no separate Editor navigation button. “Generate Summary” beside “New document” opens a right sidebar, initially closed. The report has its own required date range and is unaffected by list search, filters, sort, or page. The editor has compact line controls, visible per-line arithmetic and document totals, with right-aligned line totals on narrow screens.

New documents permit editing before save and default their issue date to the viewer's local today. “Save as draft” requires a title and issue date, creates the draft, then persists its valid line inputs. If a line form is unfinished or invalid, keep its local input and show field errors; never silently discard it. “Finalize” validates and fixes the saved draft; show the irreversible result and disable edits. For a new unsaved document, the browser creates the draft, saves its lines, then calls finalize; failure leaves the draft available for correction. A blank line description is permitted while drafting and gets a field error at finalization. “Duplicate” appears only after save and leaves the source open while linking to the new draft. Drafts and finalized documents can print from the normal detail representation; the print view visibly labels `DRAFT` or `FINALIZED` and shows details and amounts. A draft may print while incomplete. Print needs no separate API. The prototype's in-memory persistence and simplified paging are demonstration limits, not production behavior.

## 8. Acceptance checks for the production build

1. `POST /documents` with `{}` returns `422` for title and issue date. Save a draft with title and date but no customer or lines: it returns zero totals. Finalization returns `422` for customer name and missing line; the draft remains editable. A draft line with blank description can be saved, but finalization returns a description field error.
2. Enter the two calculation-example lines. Verify exact line and document amounts above. Verify two half-cent ties sum to €0.02 tax. Reject discount above subtotal, invalid numbers, and unsafe integer results.
3. Finalize a complete draft. Its title, customer, date, ordered lines, and amounts remain fixed. Later PATCH, line mutation, delete, or repeat finalize returns `409` without change. Print labels it `FINALIZED`; an incomplete printable draft labels `DRAFT`.
4. Duplicate a finalized document using the caller's local date. The response is a new editable draft with new IDs, copied ordered inputs, and unchanged source. An unsaved document must be saved before duplication.
5. A September 30 issue date finalized October 3 counts in a report ending September 30 and not one starting October 1. Both date endpoints are inclusive; drafts never count. A zero-match report has zero values. A reversed range displays inline error and sends no successful result.
6. Customer search for `  acME  ` finds names containing `Acme` without case sensitivity. Status/date filters combine with AND; report totals do not change. With 26 list matches, pages contain 25 and 1. Filter/sort change resets to page 1.
7. User A's documents appear across A's signed-in devices. User B's list/report excludes them; guessed A IDs and nonexistent IDs both return `404` for reads and writes, while no session returns `401`. Logging out one device revokes only that session. Idle and absolute expiration each end a session.
8. Browser-validation bypass still fails on server for invalid email/password. Duplicate canonical email returns `409`. Unknown email and wrong password return indistinguishable sign-in failures. Repeated attempts return `429`.
9. Alternating users on pooled DB connections, missing transaction identity, cross-owner line insertion/reparenting, and transaction rollback never reveal or modify another owner's data.

## 9. Handoff clarifications

The user confirmed these choices and approved the consolidated spec during review:

1. **Fields and completeness:** customer is a name stored on each document; title is required when saving; every line needs a nonblank description at finalization. A saved draft line has valid quantity and unit price but may lack a description, while an unfinished browser line may stay local.
2. **Dates and ordering:** issue date is required when saving a draft. IDs are opaque UUIDs and break issue-date ties in a stable ascending order.
3. **API shape:** use the route names, camel-case JSON bodies, list/report envelopes, field-error envelope, and strict unknown-field rejection defined here.

This approved document is the production-build handoff. Later changes should be recorded as new decisions against this baseline.
