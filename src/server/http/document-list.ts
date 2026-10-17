import type { Request } from 'express';
import type { AuthenticatedResponse } from '../auth.types.js';
import type { DocumentListCursor, DocumentListQuery, DocumentListSort, DocumentListStatus } from '../../shared/types/document-list.js';
import type { FieldErrors } from '../../shared/types/field-errors.js';
import { isCalendarDate } from '../../shared/document-validation.js';
import { containsControlCharacters } from '../../shared/text-validation.js';
import { DOCUMENT_PAGE_SIZE, listDocuments } from '../document-list.js';

const QUERY_FIELDS = ['search', 'status', 'issueDateStart', 'issueDateEnd', 'sort', 'page', 'cursor', 'includeTotal'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseQuery(request: Request): { fields: FieldErrors; values?: DocumentListQuery } {
  const fields = Object.create(null) as FieldErrors;
  const params = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const name of new Set(params.keys())) {
    if (!QUERY_FIELDS.includes(name as typeof QUERY_FIELDS[number])) fields[name] = 'This query parameter is not allowed.';
    else if (params.getAll(name).length !== 1) fields[name] = 'Provide this query parameter once.';
  }
  const value = (name: typeof QUERY_FIELDS[number]): string | undefined =>
    params.getAll(name).length === 1 ? params.get(name) ?? undefined : undefined;

  const search = value('search') ?? '';
  if (containsControlCharacters(search)) fields.search = 'Remove control characters from search.';
  const statusValue = value('status');
  const status = (statusValue ?? 'all') as DocumentListStatus;
  if (statusValue !== undefined && !['all', 'draft', 'finalized'].includes(statusValue)) fields.status = 'Choose all, draft, or finalized.';
  const start = value('issueDateStart');
  const end = value('issueDateEnd');
  if (start !== undefined && !isCalendarDate(start)) fields.issueDateStart = 'Enter a valid calendar date.';
  if (end !== undefined && !isCalendarDate(end)) fields.issueDateEnd = 'Enter a valid calendar date.';
  if (start !== undefined && end !== undefined && isCalendarDate(start) && isCalendarDate(end) && start > end) {
    fields.issueDateEnd = 'End date must be on or after start date.';
  }
  const sortValue = value('sort');
  const sort = (sortValue ?? 'desc') as DocumentListSort;
  if (sortValue !== undefined && sortValue !== 'desc' && sortValue !== 'asc') fields.sort = 'Choose ascending or descending issue date.';
  const pageValue = value('page');
  let page = 1;
  if (pageValue !== undefined) {
    if (!/^[1-9]\d*$/.test(pageValue)) fields.page = 'Enter a positive whole page number.';
    else {
      const parsed = Number(pageValue);
      if (!Number.isSafeInteger(parsed) || parsed - 1 > Math.floor(Number.MAX_SAFE_INTEGER / DOCUMENT_PAGE_SIZE)) {
        fields.page = 'Enter a positive whole page number.';
      } else page = parsed;
    }
  }
  const cursorValue = value('cursor');
  let cursor: DocumentListCursor | undefined;
  if (cursorValue !== undefined) {
    const parts = cursorValue.split(':');
    if (parts.length !== 3 || !['after', 'before', 'at'].includes(parts[0]) || !isCalendarDate(parts[1]) || !UUID.test(parts[2])) {
      fields.cursor = 'Enter a valid document cursor.';
    } else if (pageValue === undefined) {
      fields.page = 'Provide a page number with the cursor.';
    } else cursor = { direction: parts[0] as DocumentListCursor['direction'], issueDate: parts[1], id: parts[2] };
  }
  const includeTotalValue = value('includeTotal');
  if (includeTotalValue !== undefined && includeTotalValue !== 'true' && includeTotalValue !== 'false') {
    fields.includeTotal = 'Choose true or false.';
  } else if (includeTotalValue === 'false' && cursor === undefined) {
    fields.includeTotal = 'A cursor is required when totals are omitted.';
  }
  if (Object.keys(fields).length > 0) return { fields };
  return { fields, values: {
    search: search.trim(), status, ...(start === undefined ? {} : { issueDateStart: start }),
    ...(end === undefined ? {} : { issueDateEnd: end }), sort, page,
    ...(cursor === undefined ? {} : { cursor }), includeTotal: includeTotalValue !== 'false',
  } };
}

export async function listDocumentsHandler(request: Request, response: AuthenticatedResponse, next: (error: unknown) => void): Promise<void> {
  const parsed = parseQuery(request);
  if (!parsed.values) {
    response.status(422).json({ error: { code: 'validation_failed', message: 'Check the highlighted fields.', fields: parsed.fields } });
    return;
  }
  try {
    response.status(200).json(await listDocuments(response.locals.ownerId, parsed.values));
  } catch (error) { next(error); }
}
