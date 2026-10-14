import { and, asc, count, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { json, Router, type Request, type RequestHandler } from 'express';
import { authenticatedOwnerId } from './auth.js';
import { documents, lineItems } from '../db/schema.js';
import { withTenantTransaction, type AuthenticatedOwnerId, type TenantTransaction } from '../db/client.js';
import { isCalendarDate } from '../shared/document-validation.js';
import {
  amountsWithinSafeRange,
  calculateDocumentAmounts,
  calculateLineAmounts,
  MAX_SAFE_AMOUNT,
  type LinePricingInput,
} from '../shared/pricing.js';
import { type Clock } from './clock.js';

type Fields = Record<string, string>;
type Amounts = {
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
};

type DocumentFields = {
  title: string;
  customerName: string;
  issueDate: string;
};

function requestOwnerId(request: Request): AuthenticatedOwnerId {
  return (request as Request & { authenticatedOwnerId?: AuthenticatedOwnerId }).authenticatedOwnerId!;
}

const DOCUMENT_PAGE_SIZE = 25;
const DOCUMENT_LIST_QUERY_FIELDS = ['search', 'status', 'issueDateStart', 'issueDateEnd', 'sort', 'page'] as const;

function parseDocumentListQuery(request: Request): { fields: Fields; values?: DocumentListQuery } {
  const fields = Object.create(null) as Fields;
  const params = new URL(request.originalUrl, 'http://localhost').searchParams;

  for (const name of new Set(params.keys())) {
    if (!DOCUMENT_LIST_QUERY_FIELDS.includes(name as typeof DOCUMENT_LIST_QUERY_FIELDS[number])) {
      fields[name] = 'This query parameter is not allowed.';
    } else if (params.getAll(name).length !== 1) {
      fields[name] = 'Provide this query parameter once.';
    }
  }

  const value = (name: typeof DOCUMENT_LIST_QUERY_FIELDS[number]): string | undefined => {
    if (params.getAll(name).length !== 1) return undefined;
    return params.get(name) ?? undefined;
  };

  const search = value('search') ?? '';
  const statusValue = value('status');
  const status: DocumentListStatus = statusValue === undefined ? 'all' : statusValue as DocumentListStatus;
  if (statusValue !== undefined && !['all', 'draft', 'finalized'].includes(statusValue)) {
    fields.status = 'Choose all, draft, or finalized.';
  }

  const issueDateStartValue = value('issueDateStart');
  const issueDateEndValue = value('issueDateEnd');
  if (issueDateStartValue !== undefined && !isCalendarDate(issueDateStartValue)) {
    fields.issueDateStart = 'Enter a valid calendar date.';
  }
  if (issueDateEndValue !== undefined && !isCalendarDate(issueDateEndValue)) {
    fields.issueDateEnd = 'Enter a valid calendar date.';
  }
  if (
    issueDateStartValue !== undefined
    && issueDateEndValue !== undefined
    && isCalendarDate(issueDateStartValue)
    && isCalendarDate(issueDateEndValue)
    && issueDateStartValue > issueDateEndValue
  ) {
    fields.issueDateEnd = 'End date must be on or after start date.';
  }

  const sortValue = value('sort');
  const sort: DocumentListSort = sortValue === undefined ? 'desc' : sortValue as DocumentListSort;
  if (sortValue !== undefined && sortValue !== 'desc' && sortValue !== 'asc') {
    fields.sort = 'Choose ascending or descending issue date.';
  }

  const pageValue = value('page');
  let page = 1;
  if (pageValue !== undefined) {
    if (!/^[1-9]\d*$/.test(pageValue)) {
      fields.page = 'Enter a positive whole page number.';
    } else {
      const parsedPage = Number(pageValue);
      if (!Number.isSafeInteger(parsedPage) || parsedPage - 1 > Math.floor(Number.MAX_SAFE_INTEGER / DOCUMENT_PAGE_SIZE)) {
        fields.page = 'Enter a positive whole page number.';
      } else {
        page = parsedPage;
      }
    }
  }

  if (Object.keys(fields).length > 0) return { fields };
  return {
    fields,
    values: {
      search: search.trim(),
      status,
      ...(issueDateStartValue === undefined ? {} : { issueDateStart: issueDateStartValue }),
      ...(issueDateEndValue === undefined ? {} : { issueDateEnd: issueDateEndValue }),
      sort,
      page,
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DATABASE_INTEGER = 2_147_483_647;

type DocumentListStatus = 'all' | 'draft' | 'finalized';
type DocumentListSort = 'desc' | 'asc';
type DocumentListQuery = {
  search: string;
  status: DocumentListStatus;
  issueDateStart?: string;
  issueDateEnd?: string;
  sort: DocumentListSort;
  page: number;
};

type ParsedLineValues = Partial<{
  description: string;
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
  position: number;
}>;

type CompleteLineInput = LinePricingInput & { description: string };
type DraftLineMutation =
  | { kind: 'missing' }
  | { kind: 'finalized' }
  | { kind: 'draft'; documentId: string; lines: (typeof lineItems.$inferSelect)[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFields(body: unknown, allowed: readonly string[], required: readonly string[] = []): { fields: Fields; values?: Partial<DocumentFields> } {
  const fields = Object.create(null) as Fields;
  if (!isRecord(body)) {
    fields.body = 'Send a document object.';
    return { fields };
  }

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fields[key] = 'This field is not allowed.';
  }
  if (required.length === 0 && Object.keys(body).length === 0) {
    fields.body = 'Update at least one document field.';
  }

  const values: Partial<DocumentFields> = {};
  for (const key of allowed) {
    const isRequired = required.includes(key);
    if (!Object.hasOwn(body, key)) {
      if (isRequired) fields[key] = key === 'issueDate' ? 'Enter a valid calendar date.' : 'Enter a document name.';
      continue;
    }

    const value = body[key];
    if (key === 'issueDate') {
      if (!isCalendarDate(value)) fields.issueDate = 'Enter a valid calendar date.';
      else values.issueDate = value;
      continue;
    }

    if (typeof value !== 'string') {
      fields[key] = key === 'title' ? 'Enter a document name.' : 'Enter a customer name.';
      continue;
    }
    const trimmed = value.trim();
    if (key === 'title' && trimmed.length === 0) fields.title = 'Enter a document name.';
    else if (key === 'title') values.title = trimmed;
    else values.customerName = trimmed;
  }
  return Object.keys(fields).length > 0 ? { fields } : { fields, values };
}

function sendValidation(response: Parameters<RequestHandler>[1], fields: Fields): void {
  response.status(422).json({
    error: { code: 'validation_failed', message: 'Check the highlighted fields.', fields },
  });
}

function sendNotFound(response: Parameters<RequestHandler>[1]): void {
  response.status(404).json({ error: { code: 'not_found', message: 'Document not found.' } });
}

function toSafeNumber(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_AMOUNT) throw new RangeError('Document amount exceeds the safe integer range.');
  return Number(value);
}

function parseLineFields(body: unknown, required: readonly string[] = []): { fields: Fields; values?: ParsedLineValues } {
  const fields = Object.create(null) as Fields;
  if (!isRecord(body)) {
    fields.body = 'Send a line item object.';
    return { fields };
  }

  const allowed = ['description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints', 'position'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fields[key] = 'This field is not allowed.';
  }
  if (required.length === 0 && Object.keys(body).length === 0) {
    fields.body = 'Update at least one line item field.';
  }

  const values: ParsedLineValues = {};
  for (const key of allowed) {
    const isRequired = required.includes(key);
    if (!Object.hasOwn(body, key)) {
      if (isRequired) fields[key] = key === 'quantity' ? 'Enter a positive whole quantity.' : 'Enter a nonnegative whole amount in cents.';
      continue;
    }

    const value = body[key];
    if (key === 'description') {
      if (typeof value !== 'string') fields.description = 'Enter a line description.';
      else values.description = value.trim();
    } else if (key === 'quantity') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fields.quantity = 'Enter a positive whole quantity.';
      else values.quantity = BigInt(value);
    } else if (key === 'unitPriceCents' || key === 'discountCents') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fields[key] = 'Enter a nonnegative whole amount in cents.';
      else values[key] = BigInt(value);
    } else if (key === 'taxRateBasisPoints') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
        fields.taxRateBasisPoints = 'Enter a whole tax rate from 0 to 10000 basis points.';
      } else values.taxRateBasisPoints = value;
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_DATABASE_INTEGER) {
      fields.position = 'Enter a valid line position.';
    } else values.position = value;
  }

  return Object.keys(fields).length > 0 ? { fields } : { fields, values };
}

function completeLineInput(values: ParsedLineValues): CompleteLineInput {
  return {
    description: values.description ?? '',
    quantity: values.quantity!,
    unitPriceCents: values.unitPriceCents!,
    discountCents: values.discountCents ?? 0n,
    taxRateBasisPoints: values.taxRateBasisPoints ?? 0,
  };
}

function databaseLineInput(line: typeof lineItems.$inferSelect): CompleteLineInput {
  return {
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountCents: line.discountCents,
    taxRateBasisPoints: line.taxRateBasisPoints,
  };
}

function lineValidation(input: CompleteLineInput): Fields {
  const fields = Object.create(null) as Fields;
  const amounts = calculateLineAmounts(input);
  if (input.discountCents > amounts.subtotalCents) {
    fields.discountCents = 'Discount cannot exceed the line subtotal.';
  }
  if (!amountsWithinSafeRange(amounts)) {
    fields.body = 'Line amounts exceed the supported safe integer range.';
  }
  return fields;
}

async function lockDraftLines(transaction: TenantTransaction, documentId: string): Promise<DraftLineMutation> {
  const [parent] = await transaction.select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update')
    .limit(1);
  if (!parent) return { kind: 'missing' };
  if (parent.status !== 'draft') return { kind: 'finalized' };

  const lines = await transaction.select().from(lineItems)
    .where(eq(lineItems.documentId, parent.id))
    .orderBy(asc(lineItems.position), asc(lineItems.id));
  return { kind: 'draft', documentId: parent.id, lines };
}

async function moveLinePosition(
  transaction: TenantTransaction,
  lines: (typeof lineItems.$inferSelect)[],
  lineId: string,
  newPosition: number,
): Promise<void> {
  const line = lines.find(item => item.id === lineId);
  if (!line || line.position === newPosition) return;

  const temporaryPosition = lines.length + 1;
  await transaction.update(lineItems).set({ position: temporaryPosition }).where(eq(lineItems.id, line.id));

  if (line.position < newPosition) {
    const shifted = lines.filter(item => item.position > line.position && item.position <= newPosition)
      .sort((left, right) => left.position - right.position);
    for (const item of shifted) {
      await transaction.update(lineItems).set({ position: item.position - 1 }).where(eq(lineItems.id, item.id));
    }
  } else {
    const shifted = lines.filter(item => item.position >= newPosition && item.position < line.position)
      .sort((left, right) => right.position - left.position);
    for (const item of shifted) {
      await transaction.update(lineItems).set({ position: item.position + 1 }).where(eq(lineItems.id, item.id));
    }
  }

  await transaction.update(lineItems).set({ position: newPosition }).where(eq(lineItems.id, line.id));
}

function sendLineMutationState(
  response: Parameters<RequestHandler>[1],
  result: { kind: string },
): result is { kind: 'missing' | 'finalized' } {
  if (result.kind === 'missing') {
    sendNotFound(response);
    return true;
  }
  if (result.kind === 'finalized') {
    response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be edited.' } });
    return true;
  }
  return false;
}

function serializeLineItem(line: typeof lineItems.$inferSelect, requireSnapshot = false) {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: toSafeNumber(line.quantity),
    unitPriceCents: toSafeNumber(line.unitPriceCents),
    discountCents: toSafeNumber(line.discountCents),
    taxRateBasisPoints: line.taxRateBasisPoints,
    amounts: lineAmounts(line, requireSnapshot),
  };
}

function inputLineAmounts(line: typeof lineItems.$inferSelect): Amounts {
  const amounts = calculateLineAmounts(databaseLineInput(line));
  return {
    subtotalCents: toSafeNumber(amounts.subtotalCents),
    discountCents: toSafeNumber(amounts.discountCents),
    taxableCents: toSafeNumber(amounts.taxableCents),
    taxCents: toSafeNumber(amounts.taxCents),
    totalCents: toSafeNumber(amounts.totalCents),
  };
}

function lineAmounts(line: typeof lineItems.$inferSelect, requireSnapshot = false): Amounts {
  if (
    line.finalizedSubtotalCents === null
    || line.finalizedTaxableCents === null
    || line.finalizedTaxCents === null
    || line.finalizedTotalCents === null
  ) {
    if (requireSnapshot) throw new RangeError('Finalized line snapshot is incomplete.');
    return inputLineAmounts(line);
  }
  return {
    subtotalCents: toSafeNumber(line.finalizedSubtotalCents),
    discountCents: toSafeNumber(line.discountCents),
    taxableCents: toSafeNumber(line.finalizedTaxableCents),
    taxCents: toSafeNumber(line.finalizedTaxCents),
    totalCents: toSafeNumber(line.finalizedTotalCents),
  };
}

function snapshotAmounts(row: typeof documents.$inferSelect): Amounts | undefined {
  const values = [
    row.finalizedSubtotalCents,
    row.finalizedDiscountCents,
    row.finalizedTaxableCents,
    row.finalizedTaxCents,
    row.finalizedTotalCents,
  ];
  if (values.some(value => value === null)) return undefined;
  return {
    subtotalCents: toSafeNumber(row.finalizedSubtotalCents!),
    discountCents: toSafeNumber(row.finalizedDiscountCents!),
    taxableCents: toSafeNumber(row.finalizedTaxableCents!),
    taxCents: toSafeNumber(row.finalizedTaxCents!),
    totalCents: toSafeNumber(row.finalizedTotalCents!),
  };
}

async function serializeDocument(transaction: TenantTransaction, row: typeof documents.$inferSelect) {
  const lines = await transaction.select().from(lineItems)
    .where(eq(lineItems.documentId, row.id))
    .orderBy(asc(lineItems.position), asc(lineItems.id));
  const finalized = row.status === 'finalized';
  const lineItemsResponse = lines.map(line => serializeLineItem(line, finalized));

  const calculated = lines.reduce((total, line) => {
    const amounts = lineAmounts(line);
    total.subtotalCents += BigInt(amounts.subtotalCents);
    total.discountCents += BigInt(amounts.discountCents);
    total.taxableCents += BigInt(amounts.taxableCents);
    total.taxCents += BigInt(amounts.taxCents);
    total.totalCents += BigInt(amounts.totalCents);
    return total;
  }, { subtotalCents: 0n, discountCents: 0n, taxableCents: 0n, taxCents: 0n, totalCents: 0n });
  const persistedAmounts = snapshotAmounts(row);
  if (finalized && !persistedAmounts) throw new RangeError('Finalized document snapshot is incomplete.');
  const amounts = persistedAmounts ?? {
    subtotalCents: toSafeNumber(calculated.subtotalCents),
    discountCents: toSafeNumber(calculated.discountCents),
    taxableCents: toSafeNumber(calculated.taxableCents),
    taxCents: toSafeNumber(calculated.taxCents),
    totalCents: toSafeNumber(calculated.totalCents),
  };

  return {
    id: row.id,
    title: row.title,
    customerName: row.customerName,
    issueDate: row.issueDate,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    lineItems: lineItemsResponse,
    amounts,
  };
}

function sessionRequired(response: Parameters<RequestHandler>[1]): void {
  response.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } });
}

export function createDocumentsRouter(clock: Clock): Router {
  const router = Router();

  router.use(async (request, response, next) => {
    try {
      const ownerId = await authenticatedOwnerId(request, clock);
      if (!ownerId) {
        sessionRequired(response);
        return;
      }
      (request as Request & { authenticatedOwnerId?: AuthenticatedOwnerId }).authenticatedOwnerId = ownerId;
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    const parsed = parseDocumentListQuery(request);
    if (!parsed.values) {
      sendValidation(response, parsed.fields);
      return;
    }
    const query = parsed.values;

    const ownerId = requestOwnerId(request);
    const filters = [];
    if (query.search) {
      const escapedSearch = query.search.replace(/[\\%_]/g, '\\$&');
      filters.push(ilike(documents.customerName, `%${escapedSearch}%`));
    }
    if (query.status !== 'all') filters.push(eq(documents.status, query.status));
    if (query.issueDateStart) filters.push(gte(documents.issueDate, query.issueDateStart));
    if (query.issueDateEnd) filters.push(lte(documents.issueDate, query.issueDateEnd));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const offset = (query.page - 1) * DOCUMENT_PAGE_SIZE;
    const issueDateOrder = query.sort === 'asc' ? asc(documents.issueDate) : desc(documents.issueDate);

    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const [countResult] = await transaction.select({ totalItems: count() }).from(documents).where(where);
        const rows = await transaction.select().from(documents)
          .where(where)
          .orderBy(issueDateOrder, asc(documents.id))
          .limit(DOCUMENT_PAGE_SIZE)
          .offset(offset);
        const items = await Promise.all(rows.map(async row => {
          const document = await serializeDocument(transaction, row);
          return {
            id: document.id,
            title: document.title,
            customerName: document.customerName,
            issueDate: document.issueDate,
            status: document.status,
            amounts: document.amounts,
          };
        }));
        return {
          items,
          page: query.page,
          pageSize: DOCUMENT_PAGE_SIZE,
          totalItems: countResult?.totalItems ?? 0,
          totalPages: Math.ceil((countResult?.totalItems ?? 0) / DOCUMENT_PAGE_SIZE),
        };
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', json({ limit: '64kb' }), async (request, response, next) => {
    const parsed = parseFields(request.body, ['title', 'issueDate', 'customerName'], ['title', 'issueDate']);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }

    const ownerId = requestOwnerId(request);
    const values = parsed.values as DocumentFields;
    try {
      const document = await withTenantTransaction(ownerId, async transaction => {
        const inserted = await transaction.execute<{ id: string }>(sql`
          INSERT INTO documents (owner_id, title, customer_name, issue_date)
          VALUES (${ownerId}, ${values.title}, ${values.customerName ?? ''}, ${values.issueDate})
          RETURNING id
        `);
        const [created] = await transaction.select().from(documents)
          .where(eq(documents.id, inserted.rows[0].id))
          .limit(1);
        return serializeDocument(transaction, created);
      });
      response.status(201).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (request, response, next) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }
    const ownerId = requestOwnerId(request);
    try {
      const document = await withTenantTransaction(ownerId, async transaction => {
        const [row] = await transaction.select().from(documents)
          .where(eq(documents.id, request.params.id))
          .limit(1);
        return row ? serializeDocument(transaction, row) : undefined;
      });
      if (!document) {
        sendNotFound(response);
        return;
      }
      response.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', json({ limit: '64kb' }), async (request, response, next) => {
    const parsed = parseFields(request.body, ['title', 'customerName', 'issueDate']);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    const values = parsed.values;
    try {
      const document = await withTenantTransaction(ownerId, async transaction => {
        const [current] = await transaction.select({ id: documents.id, status: documents.status })
          .from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!current) return { kind: 'missing' as const };
        if (current.status !== 'draft') return { kind: 'finalized' as const };

        await transaction.update(documents)
          .set({ ...values, updatedAt: clock.now() })
          .where(eq(documents.id, current.id));
        const [updated] = await transaction.select().from(documents)
          .where(eq(documents.id, current.id))
          .limit(1);
        return { kind: 'updated' as const, document: await serializeDocument(transaction, updated) };
      });
      if (document.kind === 'missing') {
        sendNotFound(response);
        return;
      }
      if (document.kind === 'finalized') {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be edited.' } });
        return;
      }
      response.status(200).json(document.document);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (request, response, next) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const [current] = await transaction.select({ id: documents.id, status: documents.status })
          .from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!current) return { kind: 'missing' as const };
        if (current.status !== 'draft') return { kind: 'finalized' as const };
        await transaction.delete(documents).where(eq(documents.id, current.id));
        return { kind: 'deleted' as const };
      });
      if (result.kind === 'missing') {
        sendNotFound(response);
        return;
      }
      if (result.kind === 'finalized') {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be deleted.' } });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/duplicate', json({ limit: '64kb' }), async (request, response, next) => {
    const fields = Object.create(null) as Fields;
    const body = request.body === undefined ? {} : request.body;
    if (!isRecord(body)) {
      fields.body = 'Send an object with an issue date.';
    } else {
      if (!Object.hasOwn(body, 'issueDate')) fields.issueDate = 'Enter a valid calendar date.';
      for (const key of Object.keys(body)) {
        if (key !== 'issueDate') fields[key] = 'This field is not allowed.';
      }
      if (Object.hasOwn(body, 'issueDate') && !isCalendarDate(body.issueDate)) {
        fields.issueDate = 'Enter a valid calendar date.';
      }
    }
    if (Object.keys(fields).length > 0) {
      sendValidation(response, fields);
      return;
    }
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    const issueDate = (body as { issueDate: string }).issueDate;
    try {
      const duplicate = await withTenantTransaction(ownerId, async transaction => {
        const [source] = await transaction.select().from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!source) return undefined;

        const sourceLines = await transaction.select().from(lineItems)
          .where(eq(lineItems.documentId, source.id))
          .orderBy(asc(lineItems.position), asc(lineItems.id));
        const inserted = await transaction.execute<{ id: string }>(sql`
          INSERT INTO documents (owner_id, title, customer_name, issue_date)
          VALUES (${ownerId}, ${source.title.trim()}, ${source.customerName.trim()}, ${issueDate})
          RETURNING id
        `);
        const copyId = inserted.rows[0].id;
        for (const [index, line] of sourceLines.entries()) {
          await transaction.execute(sql`
            INSERT INTO line_items (
              document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
            ) VALUES (
              ${copyId}, ${index + 1}, ${line.description}, ${line.quantity}, ${line.unitPriceCents},
              ${line.discountCents}, ${line.taxRateBasisPoints}
            )
          `);
        }
        const [copy] = await transaction.select().from(documents)
          .where(eq(documents.id, copyId))
          .limit(1);
        return serializeDocument(transaction, copy);
      });
      if (!duplicate) {
        sendNotFound(response);
        return;
      }
      response.status(201).json(duplicate);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/finalize', json({ limit: '64kb' }), async (request, response, next) => {
    const fields = Object.create(null) as Fields;
    const declaredBodyLength = Number(request.get('content-length') ?? '0');
    const hasUndecodedBody = request.body === undefined
      && ((Number.isFinite(declaredBodyLength) && declaredBodyLength > 0) || Boolean(request.get('transfer-encoding')));
    if (hasUndecodedBody) fields.body = 'Send an empty JSON object or omit the request body.';
    if (request.body !== undefined) {
      if (!isRecord(request.body)) {
        fields.body = 'Send an empty object or omit the request body.';
      } else {
        for (const key of Object.keys(request.body)) fields[key] = 'This field is not allowed.';
      }
    }
    if (Object.keys(fields).length > 0) {
      sendValidation(response, fields);
      return;
    }
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const [current] = await transaction.select().from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!current) return { kind: 'missing' as const };
        if (current.status !== 'draft') return { kind: 'finalized' as const };

        const lines = await transaction.select().from(lineItems)
          .where(eq(lineItems.documentId, current.id))
          .orderBy(asc(lineItems.position), asc(lineItems.id));
        const validationFields = Object.create(null) as Fields;
        if (!current.customerName.trim()) validationFields.customerName = 'Enter a customer name.';
        if (lines.length === 0) validationFields.lineItems = 'Add at least one line item.';

        const snapshots = lines.map((line, index) => {
          const input = databaseLineInput(line);
          if (line.quantity > MAX_SAFE_AMOUNT) {
            validationFields[`lineItems[${index}].quantity`] = 'Enter a positive whole quantity within the supported safe integer range.';
          }
          if (line.unitPriceCents > MAX_SAFE_AMOUNT) {
            validationFields[`lineItems[${index}].unitPriceCents`] = 'Enter a nonnegative amount within the supported safe integer range.';
          }
          if (line.discountCents > MAX_SAFE_AMOUNT) {
            validationFields[`lineItems[${index}].discountCents`] = 'Enter a nonnegative amount within the supported safe integer range.';
          }
          if (line.taxRateBasisPoints < 0 || line.taxRateBasisPoints > 10_000) {
            validationFields[`lineItems[${index}].taxRateBasisPoints`] = 'Enter a tax rate from 0 to 10000 basis points.';
          }
          if (!input.description.trim()) {
            validationFields[`lineItems[${index}].description`] = 'Enter a line description.';
          }
          const lineAmounts = calculateLineAmounts(input);
          if (input.discountCents > lineAmounts.subtotalCents) {
            validationFields[`lineItems[${index}].discountCents`] = 'Discount cannot exceed the line subtotal.';
          }
          if (!amountsWithinSafeRange(lineAmounts)) {
            validationFields[`lineItems[${index}].unitPriceCents`] = 'Line amounts exceed the supported safe integer range.';
          }
          return { line, amounts: lineAmounts };
        });
        const documentAmounts = calculateDocumentAmounts(lines.map(databaseLineInput));
        if (!amountsWithinSafeRange(documentAmounts)) {
          validationFields.body = 'Document amounts exceed the supported safe integer range.';
        }
        if (Object.keys(validationFields).length > 0) return { kind: 'invalid' as const, fields: validationFields };

        const finalizedAt = clock.now();
        for (const { line, amounts } of snapshots) {
          await transaction.update(lineItems).set({
            finalizedSubtotalCents: amounts.subtotalCents,
            finalizedTaxableCents: amounts.taxableCents,
            finalizedTaxCents: amounts.taxCents,
            finalizedTotalCents: amounts.totalCents,
          }).where(eq(lineItems.id, line.id));
        }
        await transaction.update(documents).set({
          status: 'finalized',
          finalizedAt,
          updatedAt: finalizedAt,
          finalizedSubtotalCents: documentAmounts.subtotalCents,
          finalizedDiscountCents: documentAmounts.discountCents,
          finalizedTaxableCents: documentAmounts.taxableCents,
          finalizedTaxCents: documentAmounts.taxCents,
          finalizedTotalCents: documentAmounts.totalCents,
        }).where(eq(documents.id, current.id));
        const [updated] = await transaction.select().from(documents)
          .where(eq(documents.id, current.id))
          .limit(1);
        return { kind: 'completed' as const, document: await serializeDocument(transaction, updated) };
      });
      if (result.kind === 'missing') {
        sendNotFound(response);
        return;
      }
      if (result.kind === 'finalized') {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Document is already finalized.' } });
        return;
      }
      if (result.kind === 'completed') {
        response.status(200).json(result.document);
        return;
      }
      sendValidation(response, result.fields);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/line-items', json({ limit: '64kb' }), async (request, response, next) => {
    const parsed = parseLineFields(request.body, ['quantity', 'unitPriceCents']);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    if (!UUID_PATTERN.test(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const input = completeLineInput(parsed.values);
    const inputErrors = lineValidation(input);
    if (Object.keys(inputErrors).length > 0) {
      sendValidation(response, inputErrors);
      return;
    }

    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const locked = await lockDraftLines(transaction, request.params.id);
        if (locked.kind !== 'draft') return locked;

        const existing = locked.lines;
        if (existing.length >= MAX_DATABASE_INTEGER) {
          return { kind: 'invalid' as const, fields: { position: 'This draft cannot contain more line items.' } as Fields };
        }
        const requestedPosition = parsed.values!.position ?? existing.length + 1;
        if (requestedPosition > existing.length + 1) {
          return { kind: 'invalid' as const, fields: { position: 'Position must be between 1 and the next line.' } as Fields };
        }

        const totals = calculateDocumentAmounts([...existing.map(databaseLineInput), input]);
        if (!amountsWithinSafeRange(totals)) {
          return { kind: 'invalid' as const, fields: { body: 'Document amounts exceed the supported safe integer range.' } as Fields };
        }

        for (const line of existing.filter(item => item.position >= requestedPosition).sort((a, b) => b.position - a.position)) {
          await transaction.update(lineItems).set({ position: line.position + 1 }).where(eq(lineItems.id, line.id));
        }
        const inserted = await transaction.execute<{ id: string }>(sql`
          INSERT INTO line_items (
            document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
          ) VALUES (
            ${locked.documentId}, ${requestedPosition}, ${input.description}, ${input.quantity}, ${input.unitPriceCents},
            ${input.discountCents}, ${input.taxRateBasisPoints}
          ) RETURNING id
        `);
        const [created] = await transaction.select().from(lineItems)
          .where(eq(lineItems.id, inserted.rows[0].id))
          .limit(1);
        await transaction.update(documents).set({ updatedAt: clock.now() }).where(eq(documents.id, locked.documentId));
        return { kind: 'created' as const, line: created };
      });

      if (sendLineMutationState(response, result)) return;
      if (result.kind === 'invalid') {
        sendValidation(response, result.fields);
        return;
      }
      response.status(201).json(serializeLineItem(result.line));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id/line-items/:lineItemId', json({ limit: '64kb' }), async (request, response, next) => {
    const parsed = parseLineFields(request.body);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    if (!UUID_PATTERN.test(request.params.id) || !UUID_PATTERN.test(request.params.lineItemId)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const locked = await lockDraftLines(transaction, request.params.id);
        if (locked.kind !== 'draft') return locked;
        const current = locked.lines.find(line => line.id === request.params.lineItemId);
        if (!current) return { kind: 'line_missing' as const };

        const input = {
          description: parsed.values!.description ?? current.description,
          quantity: parsed.values!.quantity ?? current.quantity,
          unitPriceCents: parsed.values!.unitPriceCents ?? current.unitPriceCents,
          discountCents: parsed.values!.discountCents ?? current.discountCents,
          taxRateBasisPoints: parsed.values!.taxRateBasisPoints ?? current.taxRateBasisPoints,
        };
        const inputErrors = lineValidation(input);
        const newPosition = parsed.values!.position ?? current.position;
        if (newPosition > locked.lines.length) {
          inputErrors.position = 'Position must be between 1 and the current line count.';
        }
        if (newPosition !== current.position && locked.lines.length >= MAX_DATABASE_INTEGER) {
          inputErrors.position = 'This draft cannot contain more line items.';
        }

        const proposedAmounts = calculateDocumentAmounts(locked.lines.map(line =>
          line.id === current.id ? input : databaseLineInput(line)));
        if (!amountsWithinSafeRange(proposedAmounts)) {
          inputErrors.body = 'Document amounts exceed the supported safe integer range.';
        }
        if (Object.keys(inputErrors).length > 0) return { kind: 'invalid' as const, fields: inputErrors };

        if (newPosition !== current.position) {
          await moveLinePosition(transaction, locked.lines, current.id, newPosition);
        }
        await transaction.update(lineItems).set({
          description: input.description,
          quantity: input.quantity,
          unitPriceCents: input.unitPriceCents,
          discountCents: input.discountCents,
          taxRateBasisPoints: input.taxRateBasisPoints,
        }).where(eq(lineItems.id, current.id));
        await transaction.update(documents).set({ updatedAt: clock.now() }).where(eq(documents.id, locked.documentId));
        const [updated] = await transaction.select().from(lineItems).where(eq(lineItems.id, current.id)).limit(1);
        return { kind: 'updated' as const, line: updated };
      });

      if (sendLineMutationState(response, result)) return;
      if (result.kind === 'line_missing') {
        sendNotFound(response);
        return;
      }
      if (result.kind === 'invalid') {
        sendValidation(response, result.fields);
        return;
      }
      response.status(200).json(serializeLineItem(result.line));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/line-items/:lineItemId', async (request, response, next) => {
    if (!UUID_PATTERN.test(request.params.id) || !UUID_PATTERN.test(request.params.lineItemId)) {
      sendNotFound(response);
      return;
    }

    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const locked = await lockDraftLines(transaction, request.params.id);
        if (locked.kind !== 'draft') return locked;
        const current = locked.lines.find(line => line.id === request.params.lineItemId);
        if (!current) return { kind: 'line_missing' as const };

        await transaction.delete(lineItems).where(eq(lineItems.id, current.id));
        const shifted = locked.lines.filter(line => line.position > current.position)
          .sort((left, right) => left.position - right.position);
        for (const line of shifted) {
          await transaction.update(lineItems).set({ position: line.position - 1 }).where(eq(lineItems.id, line.id));
        }
        await transaction.update(documents).set({ updatedAt: clock.now() }).where(eq(documents.id, locked.documentId));
        return { kind: 'deleted' as const };
      });

      if (sendLineMutationState(response, result)) return;
      if (result.kind === 'line_missing') {
        sendNotFound(response);
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
