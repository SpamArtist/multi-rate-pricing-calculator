---
status: accepted
---

# Store draft amounts for document listing

The Documents list needs current amounts for each saved draft, but deriving them on every list request loads all line items for the visible drafts. Store all five draft amount fields with the document and update them atomically on every application or seed write that changes its lines. Backfill existing drafts before switching list reads to those fields. Keep document detail amounts derived from its loaded lines and finalized amounts from their immutable snapshots. This moves calculation cost to writes and requires every supported draft write path to maintain the stored values; direct SQL edits outside those paths are not covered.
