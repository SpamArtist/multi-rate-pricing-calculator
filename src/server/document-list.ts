import { withTenantTransaction } from '../db/client.js';
import { projectDocumentSummaries } from '../db/document-projection.js';
import { countDocumentsForList, readDocumentListPage } from '../db/document-list-persistence.js';
import type { DocumentListQuery, DocumentListResponse } from '../shared/types/document-list.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';

export const DOCUMENT_PAGE_SIZE = 25;

export async function listDocuments(ownerId: AuthenticatedOwnerId, query: DocumentListQuery): Promise<DocumentListResponse> {
  return withTenantTransaction(ownerId, async transaction => {
    const totalItems = query.includeTotal ? await countDocumentsForList(transaction, query) : undefined;
    const rows = await readDocumentListPage(transaction, query, totalItems, DOCUMENT_PAGE_SIZE);
    const items = projectDocumentSummaries(rows);
    const cursorFor = (item: typeof items[number]): string => `${item.issueDate}:${item.id}`;
    return {
      items, page: query.page, pageSize: DOCUMENT_PAGE_SIZE,
      ...(totalItems === undefined ? {} : { totalItems, totalPages: Math.ceil(totalItems / DOCUMENT_PAGE_SIZE) }),
      firstCursor: items.length ? cursorFor(items[0]) : null,
      lastCursor: items.length ? cursorFor(items[items.length - 1]) : null,
    };
  }, { consistentRead: true });
}
