import type { documents, lineItems } from './schema.js';

export type DocumentRow = typeof documents.$inferSelect;

export type LineRow = typeof lineItems.$inferSelect;
