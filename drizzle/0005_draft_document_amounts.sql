ALTER TABLE "documents"
  ADD COLUMN "draft_subtotal_cents" bigint DEFAULT 0,
  ADD COLUMN "draft_discount_cents" bigint DEFAULT 0,
  ADD COLUMN "draft_taxable_cents" bigint DEFAULT 0,
  ADD COLUMN "draft_tax_cents" bigint DEFAULT 0,
  ADD COLUMN "draft_total_cents" bigint DEFAULT 0;
--> statement-breakpoint
-- The migration role owns these tables but FORCE ROW LEVEL SECURITY applies to it.
-- Visit every tenant in the same transaction so no existing draft reaches list reads
-- with its temporary zero defaults. Empty drafts already have the correct zero totals.
DO $$
DECLARE
  seed_owner_id uuid;
BEGIN
  FOR seed_owner_id IN SELECT id FROM "users" LOOP
    PERFORM set_config('app.user_id', seed_owner_id::text, true);

    UPDATE "documents" AS target SET
      "draft_subtotal_cents" = totals.subtotal_cents::bigint,
      "draft_discount_cents" = totals.discount_cents::bigint,
      "draft_taxable_cents" = totals.taxable_cents::bigint,
      "draft_tax_cents" = totals.tax_cents::bigint,
      "draft_total_cents" = (totals.taxable_cents + totals.tax_cents)::bigint
    FROM (
      SELECT lines.document_id,
        sum(lines.subtotal_cents) AS subtotal_cents,
        sum(lines.discount_cents) AS discount_cents,
        sum(lines.taxable_cents) AS taxable_cents,
        sum(lines.tax_cents) AS tax_cents
      FROM (
        SELECT item.document_id,
          item.quantity::numeric * item.unit_price_cents::numeric AS subtotal_cents,
          item.discount_cents::numeric AS discount_cents,
          item.quantity::numeric * item.unit_price_cents::numeric - item.discount_cents::numeric AS taxable_cents,
          floor(((item.quantity::numeric * item.unit_price_cents::numeric - item.discount_cents::numeric)
            * item.tax_rate_basis_points::numeric + 5000) / 10000) AS tax_cents
        FROM "line_items" AS item
        JOIN "documents" AS draft ON draft.id = item.document_id
        WHERE draft.owner_id = seed_owner_id AND draft.status = 'draft'
      ) AS lines
      GROUP BY lines.document_id
    ) AS totals
    WHERE target.id = totals.document_id AND target.owner_id = seed_owner_id AND target.status = 'draft';
  END LOOP;
  PERFORM set_config('app.user_id', '', true);
END $$;
--> statement-breakpoint
ALTER TABLE "documents"
  ALTER COLUMN "draft_subtotal_cents" SET NOT NULL,
  ALTER COLUMN "draft_discount_cents" SET NOT NULL,
  ALTER COLUMN "draft_taxable_cents" SET NOT NULL,
  ALTER COLUMN "draft_tax_cents" SET NOT NULL,
  ALTER COLUMN "draft_total_cents" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_draft_amounts_safe" CHECK (
    "draft_subtotal_cents" BETWEEN 0 AND 9007199254740991
    AND "draft_discount_cents" BETWEEN 0 AND 9007199254740991
    AND "draft_taxable_cents" BETWEEN 0 AND 9007199254740991
    AND "draft_tax_cents" BETWEEN 0 AND 9007199254740991
    AND "draft_total_cents" BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT "documents_draft_amounts_consistent" CHECK (
    "draft_subtotal_cents"::numeric = "draft_discount_cents"::numeric + "draft_taxable_cents"::numeric
    AND "draft_total_cents"::numeric = "draft_taxable_cents"::numeric + "draft_tax_cents"::numeric
  );
--> statement-breakpoint
GRANT UPDATE ("draft_subtotal_cents", "draft_discount_cents", "draft_taxable_cents",
              "draft_tax_cents", "draft_total_cents") ON "documents" TO pricing_runtime;
