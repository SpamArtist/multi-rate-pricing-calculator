import { and, asc, count, desc, eq, gt, gte, ilike, lt, lte, or, type SQL } from 'drizzle-orm';
import { documents } from './schema.js';
import type { TenantTransaction } from './client.types.js';
import type { DocumentListCursor, DocumentListQuery } from '../shared/types/document-list.js';

function filtersFor(query: DocumentListQuery): SQL | undefined {
  const predicates: SQL[] = [];
  if (query.search) {
    const escaped = query.search.replace(/[\\%_]/g, '\\$&');
    predicates.push(ilike(documents.customerName, `%${escaped}%`));
  }
  if (query.status !== 'all') predicates.push(eq(documents.status, query.status));
  if (query.issueDateStart) predicates.push(gte(documents.issueDate, query.issueDateStart));
  if (query.issueDateEnd) predicates.push(lte(documents.issueDate, query.issueDateEnd));
  return predicates.length ? and(...predicates) : undefined;
}

function seekPredicate(cursor: DocumentListCursor, sort: DocumentListQuery['sort']): SQL | undefined {
  const after = cursor.direction !== 'before';
  const dateForward = sort === 'asc' ? gt : lt;
  const dateComparison = after ? dateForward : sort === 'asc' ? lt : gt;
  const idComparison = after ? gt : lt;
  const sameDate = and(eq(documents.issueDate, cursor.issueDate), idComparison(documents.id, cursor.id));
  const exclusive = or(dateComparison(documents.issueDate, cursor.issueDate), sameDate);
  if (cursor.direction !== 'at') return exclusive;
  return or(exclusive, and(eq(documents.issueDate, cursor.issueDate), eq(documents.id, cursor.id)));
}

export async function countDocumentsForList(transaction: TenantTransaction, query: DocumentListQuery): Promise<number> {
  const [result] = await transaction.select({ totalItems: count() }).from(documents).where(filtersFor(query));
  return result?.totalItems ?? 0;
}

export async function readDocumentListPage(
  transaction: TenantTransaction, query: DocumentListQuery, totalItems: number, pageSize: number,
): Promise<Array<typeof documents.$inferSelect>> {
  const forwardOffset = (query.page - 1) * pageSize;
  if (forwardOffset >= totalItems) return [];
  const pageLength = Math.min(pageSize, totalItems - forwardOffset);
  const backwardOffset = totalItems - forwardOffset - pageLength;
  const reverse = query.cursor?.direction === 'before' || (!query.cursor && backwardOffset < forwardOffset);
  const where = and(filtersFor(query), query.cursor ? seekPredicate(query.cursor, query.sort) : undefined);
  const dateOrder = query.sort === 'asc' ? asc(documents.issueDate) : desc(documents.issueDate);
  const reverseDateOrder = query.sort === 'asc' ? desc(documents.issueDate) : asc(documents.issueDate);
  const rows = await transaction.select().from(documents)
    .where(where)
    .orderBy(reverse ? reverseDateOrder : dateOrder, reverse ? desc(documents.id) : asc(documents.id))
    .limit(query.cursor ? pageSize : pageLength)
    .offset(query.cursor ? 0 : reverse ? backwardOffset : forwardOffset);
  return reverse ? rows.reverse() : rows;
}
