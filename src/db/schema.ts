import { date, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  issueDate: date('issue_date', { mode: 'string' }).notNull(),
});
