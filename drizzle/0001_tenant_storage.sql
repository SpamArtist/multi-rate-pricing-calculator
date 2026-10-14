CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_display" text NOT NULL,
	"email_canonical" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_display_trimmed" CHECK ("email_display" = btrim("email_display") AND btrim("email_display") <> ''),
	CONSTRAINT "users_email_canonical_normalized" CHECK ("email_canonical" = lower(btrim("email_canonical")) AND btrim("email_canonical") <> ''),
	CONSTRAINT "users_password_argon2id" CHECK ("password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "users_email_canonical_unique" UNIQUE ("email_canonical")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE ("token_hash"),
	CONSTRAINT "sessions_activity_after_creation" CHECK ("last_activity_at" >= "created_at"),
	CONSTRAINT "sessions_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "documents"
	ADD COLUMN "customer_name" text DEFAULT '' NOT NULL,
	ADD COLUMN "status" text DEFAULT 'draft' NOT NULL,
	ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL,
	ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	ADD COLUMN "finalized_at" timestamp with time zone,
	ADD COLUMN "finalized_subtotal_cents" bigint,
	ADD COLUMN "finalized_discount_cents" bigint,
	ADD COLUMN "finalized_taxable_cents" bigint,
	ADD COLUMN "finalized_tax_cents" bigint,
	ADD COLUMN "finalized_total_cents" bigint;
--> statement-breakpoint
ALTER TABLE "documents"
	ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE,
	ADD CONSTRAINT "documents_status_valid" CHECK ("status" IN ('draft', 'finalized')),
	ADD CONSTRAINT "documents_finalization_complete" CHECK (
		("status" = 'draft' AND "finalized_at" IS NULL
		 AND "finalized_subtotal_cents" IS NULL AND "finalized_discount_cents" IS NULL
		 AND "finalized_taxable_cents" IS NULL AND "finalized_tax_cents" IS NULL
		 AND "finalized_total_cents" IS NULL)
		OR
		("status" = 'finalized' AND "finalized_at" IS NOT NULL AND btrim("customer_name") <> ''
		 AND "finalized_subtotal_cents" IS NOT NULL AND "finalized_discount_cents" IS NOT NULL
		 AND "finalized_taxable_cents" IS NOT NULL AND "finalized_tax_cents" IS NOT NULL
		 AND "finalized_total_cents" IS NOT NULL)
	),
	ADD CONSTRAINT "documents_finalized_amounts_safe" CHECK (
		("finalized_subtotal_cents" IS NULL OR "finalized_subtotal_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_discount_cents" IS NULL OR "finalized_discount_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_taxable_cents" IS NULL OR "finalized_taxable_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_tax_cents" IS NULL OR "finalized_tax_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_total_cents" IS NULL OR "finalized_total_cents" BETWEEN 0 AND 9007199254740991)
	),
	ADD CONSTRAINT "documents_finalized_amounts_consistent" CHECK (
		"finalized_subtotal_cents" IS NULL OR (
			"finalized_subtotal_cents"::numeric = "finalized_discount_cents"::numeric + "finalized_taxable_cents"::numeric
			AND "finalized_total_cents"::numeric = "finalized_taxable_cents"::numeric + "finalized_tax_cents"::numeric
		)
	);
--> statement-breakpoint
CREATE TABLE "line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity" bigint NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 0 NOT NULL,
	"finalized_subtotal_cents" bigint,
	"finalized_taxable_cents" bigint,
	"finalized_tax_cents" bigint,
	"finalized_total_cents" bigint,
	CONSTRAINT "line_items_document_position_unique" UNIQUE ("document_id", "position"),
	CONSTRAINT "line_items_position_positive" CHECK ("position" > 0),
	CONSTRAINT "line_items_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "line_items_price_nonnegative" CHECK ("unit_price_cents" >= 0),
	CONSTRAINT "line_items_discount_nonnegative" CHECK ("discount_cents" >= 0),
	CONSTRAINT "line_items_discount_within_subtotal" CHECK ("discount_cents"::numeric <= "quantity"::numeric * "unit_price_cents"::numeric),
	CONSTRAINT "line_items_tax_rate_valid" CHECK ("tax_rate_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "line_items_finalization_complete" CHECK (
		("finalized_subtotal_cents" IS NULL AND "finalized_taxable_cents" IS NULL
		 AND "finalized_tax_cents" IS NULL AND "finalized_total_cents" IS NULL)
		OR
		("finalized_subtotal_cents" IS NOT NULL AND "finalized_taxable_cents" IS NOT NULL
		 AND "finalized_tax_cents" IS NOT NULL AND "finalized_total_cents" IS NOT NULL)
	),
	CONSTRAINT "line_items_finalized_amounts_safe" CHECK (
		("finalized_subtotal_cents" IS NULL OR "finalized_subtotal_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_taxable_cents" IS NULL OR "finalized_taxable_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_tax_cents" IS NULL OR "finalized_tax_cents" BETWEEN 0 AND 9007199254740991)
		AND ("finalized_total_cents" IS NULL OR "finalized_total_cents" BETWEEN 0 AND 9007199254740991)
	),
	CONSTRAINT "line_items_finalized_amounts_consistent" CHECK (
		"finalized_subtotal_cents" IS NULL OR (
			"finalized_subtotal_cents"::numeric = "quantity"::numeric * "unit_price_cents"::numeric
			AND "finalized_taxable_cents"::numeric = "finalized_subtotal_cents"::numeric - "discount_cents"::numeric
			AND "finalized_total_cents"::numeric = "finalized_taxable_cents"::numeric + "finalized_tax_cents"::numeric
		)
	));
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "documents_owner_isolation" ON "documents";
--> statement-breakpoint
CREATE POLICY "documents_owner_isolation" ON "documents"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "line_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "line_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "line_items_owner_isolation" ON "line_items"
  USING (
    EXISTS (
      SELECT 1 FROM "documents" AS parent
      WHERE parent."id" = "line_items"."document_id"
        AND parent."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "documents" AS parent
      WHERE parent."id" = "line_items"."document_id"
        AND parent."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
--> statement-breakpoint
REVOKE ALL ON "users", "sessions", "documents", "line_items" FROM PUBLIC, pricing_runtime;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pricing_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "email_display", "email_canonical", "password_hash", "created_at"),
      INSERT ("email_display", "email_canonical", "password_hash") ON "users" TO pricing_runtime;
--> statement-breakpoint
GRANT SELECT ("id", "user_id", "token_hash", "created_at", "last_activity_at", "expires_at"),
      INSERT ("user_id", "token_hash", "expires_at"), UPDATE ("last_activity_at"), DELETE ON "sessions" TO pricing_runtime;
--> statement-breakpoint
GRANT SELECT, DELETE ON "documents", "line_items" TO pricing_runtime;
--> statement-breakpoint
GRANT INSERT ("owner_id", "title", "customer_name", "issue_date") ON "documents" TO pricing_runtime;
--> statement-breakpoint
GRANT UPDATE ("title", "customer_name", "issue_date", "updated_at", "status", "finalized_at",
              "finalized_subtotal_cents", "finalized_discount_cents", "finalized_taxable_cents",
              "finalized_tax_cents", "finalized_total_cents") ON "documents" TO pricing_runtime;
--> statement-breakpoint
GRANT INSERT ("document_id", "position", "description", "quantity", "unit_price_cents",
              "discount_cents", "tax_rate_basis_points") ON "line_items" TO pricing_runtime;
--> statement-breakpoint
GRANT UPDATE ("document_id", "position", "description", "quantity", "unit_price_cents",
              "discount_cents", "tax_rate_basis_points", "finalized_subtotal_cents",
              "finalized_taxable_cents", "finalized_tax_cents", "finalized_total_cents")
      ON "line_items" TO pricing_runtime;
