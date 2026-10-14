import { asc, desc, eq, sql } from 'drizzle-orm';
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DATABASE_INTEGER = 2_147_483_647;

type ParsedLineValues = Partial<{
  description: string;
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
  position: number;
}>;

type CompleteLineInput = LinePricingInput & { description: string };

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

function serializeLineItem(line: typeof lineItems.$inferSelect) {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: toSafeNumber(line.quantity),
    unitPriceCents: toSafeNumber(line.unitPriceCents),
    discountCents: toSafeNumber(line.discountCents),
    taxRateBasisPoints: line.taxRateBasisPoints,
    amounts: lineAmounts(line),
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

function lineAmounts(line: typeof lineItems.$inferSelect): Amounts {
  if (
    line.finalizedSubtotalCents === null
    || line.finalizedTaxableCents === null
    || line.finalizedTaxCents === null
    || line.finalizedTotalCents === null
  ) return inputLineAmounts(line);
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
  const lineItemsResponse = lines.map(serializeLineItem);

  const calculated = lines.reduce((total, line) => {
    const amounts = lineAmounts(line);
    total.subtotalCents += BigInt(amounts.subtotalCents);
    total.discountCents += BigInt(amounts.discountCents);
    total.taxableCents += BigInt(amounts.taxableCents);
    total.taxCents += BigInt(amounts.taxCents);
    total.totalCents += BigInt(amounts.totalCents);
    return total;
  }, { subtotalCents: 0n, discountCents: 0n, taxableCents: 0n, taxCents: 0n, totalCents: 0n });
  const amounts = snapshotAmounts(row) ?? {
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
    const ownerId = requestOwnerId(request);
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const rows = await transaction.select().from(documents)
          .orderBy(desc(documents.issueDate), asc(documents.id));
        const items = await Promise.all(rows.slice(0, 25).map(async row => {
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
          page: 1,
          pageSize: 25,
          totalItems: rows.length,
          totalPages: Math.ceil(rows.length / 25),
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
        const [parent] = await transaction.select({ id: documents.id, status: documents.status })
          .from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!parent) return { kind: 'missing' as const };
        if (parent.status !== 'draft') return { kind: 'finalized' as const };

        const existing = await transaction.select().from(lineItems)
          .where(eq(lineItems.documentId, parent.id))
          .orderBy(asc(lineItems.position), asc(lineItems.id));
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
            ${parent.id}, ${requestedPosition}, ${input.description}, ${input.quantity}, ${input.unitPriceCents},
            ${input.discountCents}, ${input.taxRateBasisPoints}
          ) RETURNING id
        `);
        const [created] = await transaction.select().from(lineItems)
          .where(eq(lineItems.id, inserted.rows[0].id))
          .limit(1);
        await transaction.update(documents).set({ updatedAt: clock.now() }).where(eq(documents.id, parent.id));
        return { kind: 'created' as const, line: created };
      });

      if (result.kind === 'missing') {
        sendNotFound(response);
        return;
      }
      if (result.kind === 'finalized') {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be edited.' } });
        return;
      }
      if (result.kind === 'invalid') {
        sendValidation(response, result.fields);
        return;
      }
      response.status(201).json(serializeLineItem(result.line));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
