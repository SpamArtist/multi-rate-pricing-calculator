# Large local seed

Run `npm run db:seed:large` against the local PostgreSQL database after migrations. It creates 100,000 documents across three dedicated users, with 300–450 line items per document. Titles and customer names are unique within the seed. Issue dates span 1980-01-01 through the run date. Exactly 45% of documents are finalized; finalized snapshots use the same integer tax rounding as the app.

The three sign-in emails are `load-large-local-v1-{1,2,3}@example.test`. Their shared 10-character password is stored in ignored `.artifacts/large-local-v1-password.txt` with owner-only file permissions. Keep that file when resuming the seed.

The script commits batches of 50 documents and resumes from the last committed batch. `npm run db:seed:large -- --batches=1` runs one batch for a smoke check. It refuses to start when free space is below its estimated need and stops between batches if less than 5 GiB remains. `--allow-low-space` bypasses only the initial estimate, for a PostgreSQL data volume mounted outside the project filesystem.
