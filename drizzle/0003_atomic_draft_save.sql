ALTER TABLE "line_items" DROP CONSTRAINT "line_items_document_position_unique";
--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_document_position_unique" UNIQUE ("document_id", "position") DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
CREATE TABLE "draft_save_mutations" (
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mutation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "response" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "draft_save_mutations_owner_mutation_unique" UNIQUE ("owner_id", "mutation_id")
);
--> statement-breakpoint
ALTER TABLE "draft_save_mutations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "draft_save_mutations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "draft_save_mutations_owner_isolation" ON "draft_save_mutations"
  USING ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON "draft_save_mutations" FROM PUBLIC, pricing_runtime;
--> statement-breakpoint
GRANT SELECT ON "draft_save_mutations" TO pricing_runtime;
--> statement-breakpoint
GRANT INSERT ("owner_id", "mutation_id", "request_hash") ON "draft_save_mutations" TO pricing_runtime;
--> statement-breakpoint
GRANT UPDATE ("response") ON "draft_save_mutations" TO pricing_runtime;
