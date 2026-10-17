CREATE INDEX "documents_owner_issue_date_desc_id_idx"
  ON "documents" ("owner_id", "issue_date" DESC, "id" ASC);
