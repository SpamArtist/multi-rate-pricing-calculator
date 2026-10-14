import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  emailDisplay: text('email_display').notNull(),
  emailCanonical: text('email_canonical').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, table => [
  unique('users_email_canonical_unique').on(table.emailCanonical),
  check('users_email_display_trimmed', sql`${table.emailDisplay} = btrim(${table.emailDisplay}) AND btrim(${table.emailDisplay}) <> ''`),
  check('users_email_canonical_normalized', sql`${table.emailCanonical} = lower(btrim(${table.emailCanonical})) AND btrim(${table.emailCanonical}) <> ''`),
  check('users_password_argon2id', sql`${table.passwordHash} LIKE '$argon2id$%'`),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
}, table => [
  unique('sessions_token_hash_unique').on(table.tokenHash),
  check('sessions_activity_after_creation', sql`${table.lastActivityAt} >= ${table.createdAt}`),
  check('sessions_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  customerName: text('customer_name').default('').notNull(),
  issueDate: date('issue_date', { mode: 'string' }).notNull(),
  status: text('status').default('draft').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }),
  finalizedSubtotalCents: bigint('finalized_subtotal_cents', { mode: 'bigint' }),
  finalizedDiscountCents: bigint('finalized_discount_cents', { mode: 'bigint' }),
  finalizedTaxableCents: bigint('finalized_taxable_cents', { mode: 'bigint' }),
  finalizedTaxCents: bigint('finalized_tax_cents', { mode: 'bigint' }),
  finalizedTotalCents: bigint('finalized_total_cents', { mode: 'bigint' }),
}, table => [
  check('documents_title_nonblank', sql`btrim(${table.title}) <> ''`),
  check('documents_status_valid', sql`${table.status} IN ('draft', 'finalized')`),
  check('documents_finalization_complete', sql`
    (${table.status} = 'draft' AND ${table.finalizedAt} IS NULL
      AND ${table.finalizedSubtotalCents} IS NULL AND ${table.finalizedDiscountCents} IS NULL
      AND ${table.finalizedTaxableCents} IS NULL AND ${table.finalizedTaxCents} IS NULL
      AND ${table.finalizedTotalCents} IS NULL)
    OR
    (${table.status} = 'finalized' AND ${table.finalizedAt} IS NOT NULL AND btrim(${table.customerName}) <> ''
      AND ${table.finalizedSubtotalCents} IS NOT NULL AND ${table.finalizedDiscountCents} IS NOT NULL
      AND ${table.finalizedTaxableCents} IS NOT NULL AND ${table.finalizedTaxCents} IS NOT NULL
      AND ${table.finalizedTotalCents} IS NOT NULL)
  `),
  check('documents_finalized_amounts_safe', sql`
    (${table.finalizedSubtotalCents} IS NULL OR ${table.finalizedSubtotalCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedDiscountCents} IS NULL OR ${table.finalizedDiscountCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTaxableCents} IS NULL OR ${table.finalizedTaxableCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTaxCents} IS NULL OR ${table.finalizedTaxCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTotalCents} IS NULL OR ${table.finalizedTotalCents} BETWEEN 0 AND 9007199254740991)
  `),
  check('documents_finalized_amounts_consistent', sql`
    ${table.finalizedSubtotalCents} IS NULL OR (
      ${table.finalizedSubtotalCents}::numeric = ${table.finalizedDiscountCents}::numeric + ${table.finalizedTaxableCents}::numeric
      AND ${table.finalizedTotalCents}::numeric = ${table.finalizedTaxableCents}::numeric + ${table.finalizedTaxCents}::numeric
    )
  `),
]);

export const lineItems = pgTable('line_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  description: text('description').default('').notNull(),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  unitPriceCents: bigint('unit_price_cents', { mode: 'bigint' }).notNull(),
  discountCents: bigint('discount_cents', { mode: 'bigint' }).default(0n).notNull(),
  taxRateBasisPoints: integer('tax_rate_basis_points').default(0).notNull(),
  finalizedSubtotalCents: bigint('finalized_subtotal_cents', { mode: 'bigint' }),
  finalizedTaxableCents: bigint('finalized_taxable_cents', { mode: 'bigint' }),
  finalizedTaxCents: bigint('finalized_tax_cents', { mode: 'bigint' }),
  finalizedTotalCents: bigint('finalized_total_cents', { mode: 'bigint' }),
}, table => [
  unique('line_items_document_position_unique').on(table.documentId, table.position),
  check('line_items_position_positive', sql`${table.position} > 0`),
  check('line_items_quantity_positive', sql`${table.quantity} > 0`),
  check('line_items_price_nonnegative', sql`${table.unitPriceCents} >= 0`),
  check('line_items_discount_nonnegative', sql`${table.discountCents} >= 0`),
  check('line_items_discount_within_subtotal', sql`${table.discountCents}::numeric <= ${table.quantity}::numeric * ${table.unitPriceCents}::numeric`),
  check('line_items_tax_rate_valid', sql`${table.taxRateBasisPoints} BETWEEN 0 AND 10000`),
  check('line_items_finalization_complete', sql`
    (${table.finalizedSubtotalCents} IS NULL AND ${table.finalizedTaxableCents} IS NULL
      AND ${table.finalizedTaxCents} IS NULL AND ${table.finalizedTotalCents} IS NULL)
    OR
    (${table.finalizedSubtotalCents} IS NOT NULL AND ${table.finalizedTaxableCents} IS NOT NULL
      AND ${table.finalizedTaxCents} IS NOT NULL AND ${table.finalizedTotalCents} IS NOT NULL)
  `),
  check('line_items_finalized_amounts_safe', sql`
    (${table.finalizedSubtotalCents} IS NULL OR ${table.finalizedSubtotalCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTaxableCents} IS NULL OR ${table.finalizedTaxableCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTaxCents} IS NULL OR ${table.finalizedTaxCents} BETWEEN 0 AND 9007199254740991)
    AND (${table.finalizedTotalCents} IS NULL OR ${table.finalizedTotalCents} BETWEEN 0 AND 9007199254740991)
  `),
  check('line_items_finalized_amounts_consistent', sql`
    ${table.finalizedSubtotalCents} IS NULL OR (
      ${table.finalizedSubtotalCents}::numeric = ${table.quantity}::numeric * ${table.unitPriceCents}::numeric
      AND ${table.finalizedTaxableCents}::numeric = ${table.finalizedSubtotalCents}::numeric - ${table.discountCents}::numeric
      AND ${table.finalizedTotalCents}::numeric = ${table.finalizedTaxableCents}::numeric + ${table.finalizedTaxCents}::numeric
    )
  `),
]);
