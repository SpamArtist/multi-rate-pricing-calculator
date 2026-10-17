import type {
  CompleteLineInput, DocumentFields, DraftLineMutation, ParsedLineValues,
} from './documents.types.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { json, Router, type RequestHandler } from 'express';
import { requireAuthenticated } from './auth.js';
import type { AuthenticatedResponse } from './auth.types.js';
import { documents, lineItems } from '../db/schema.js';
import { withTenantTransaction } from '../db/client.js';
import { isCalendarDate } from '../shared/document-validation.js';
import type { TenantTransaction } from '../db/client.types.js';
import type { FieldErrors as Fields } from '../shared/types/field-errors.js';
import {
  amountsWithinSafeRange,
  calculatePricing,
  MAX_SAFE_AMOUNT,
} from '../shared/pricing.js';
import { databaseLineInput, serializeDocument, serializeLineItem } from '../db/document-projection.js';
import { listDocumentsHandler } from './http/document-list.js';
import type { Clock } from '../shared/types/clock.js';
import { replaceDraftLines, writeLineSnapshots } from '../db/line-set-persistence.js';
import type { DraftLineInput } from '../shared/types/draft-line.js';
import {
  fields as createFields, inputError, isRecord, linePricingErrors, MAX_DATABASE_INTEGER,
  parseAmount, parseCustomerName, parseDescription, parseIssueDate, parsePosition, parseQuantity,
  parseTaxRate, parseTitle, parseUuid, rejectUnknownFields,
} from './document-input.js';

function parseFields(body: unknown, allowed: readonly string[], required: readonly string[] = []): { fields: Fields; values?: Partial<DocumentFields> } {
  const fields = createFields();
  if (!isRecord(body)) {
    fields.body = 'Send a document object.';
    return { fields };
  }

  rejectUnknownFields(body, allowed, fields);
  if (required.length === 0 && Object.keys(body).length === 0) {
    fields.body = 'Update at least one document field.';
  }

  const values: Partial<DocumentFields> = {};
  for (const key of allowed) {
    const isRequired = required.includes(key);
    if (!Object.hasOwn(body, key)) {
      if (isRequired) fields[key] = key === 'issueDate' ? inputError.issueDate
        : key === 'customerName' ? inputError.customerName : inputError.title;
      continue;
    }

    if (key === 'issueDate') {
      const date = parseIssueDate(body[key]);
      if (date === undefined) fields.issueDate = inputError.issueDate;
      else values.issueDate = date;
      continue;
    }
    if (key === 'title') {
      const title = parseTitle(body[key]);
      if (title === undefined) fields.title = inputError.title;
      else values.title = title;
    } else {
      const customerName = parseCustomerName(body[key]);
      if (customerName === undefined) fields.customerName = inputError.customerName;
      else values.customerName = customerName;
    }
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

function parseLineFields(body: unknown, required: readonly string[] = []): { fields: Fields; values?: ParsedLineValues } {
  const fields = createFields();
  if (!isRecord(body)) {
    fields.body = 'Send a line item object.';
    return { fields };
  }

  const allowed = ['description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints', 'position'];
  rejectUnknownFields(body, allowed, fields);
  if (required.length === 0 && Object.keys(body).length === 0) {
    fields.body = 'Update at least one line item field.';
  }

  const values: ParsedLineValues = {};
  for (const key of allowed) {
    const isRequired = required.includes(key);
    if (!Object.hasOwn(body, key)) {
      if (isRequired) fields[key] = key === 'quantity' ? inputError.quantity : inputError.amount;
      continue;
    }

    if (key === 'description') {
      const description = parseDescription(body[key]);
      if (description === undefined) fields.description = inputError.description;
      else values.description = description;
    } else if (key === 'quantity') {
      const quantity = parseQuantity(body[key]);
      if (quantity === undefined) fields.quantity = inputError.quantity;
      else values.quantity = quantity;
    } else if (key === 'unitPriceCents' || key === 'discountCents') {
      const amount = parseAmount(body[key]);
      if (amount === undefined) fields[key] = inputError.amount;
      else values[key] = amount;
    } else if (key === 'taxRateBasisPoints') {
      const taxRate = parseTaxRate(body[key]);
      if (taxRate === undefined) fields.taxRateBasisPoints = inputError.taxRateBasisPoints;
      else values.taxRateBasisPoints = taxRate;
    } else {
      const position = parsePosition(body[key]);
      if (position === undefined) fields.position = inputError.position;
      else values.position = position;
    }
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
  return {
    kind: 'draft', documentId: parent.id,
    lines: lines.map(line => ({ id: line.id, ...databaseLineInput(line) })),
  };
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

export function createDocumentsRouter(clock: Clock): Router {
  const router = Router();

  router.use(requireAuthenticated(clock));

  router.get('/', listDocumentsHandler);

  router.post('/', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
    const parsed = parseFields(request.body, ['title', 'issueDate', 'customerName'], ['title', 'issueDate']);
    if (!parsed.values || parsed.values.title === undefined || parsed.values.issueDate === undefined
      || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }

    const ownerId = response.locals.ownerId;
    const values = parsed.values;
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

  router.get('/:id', async (request, response: AuthenticatedResponse, next) => {
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }
    const ownerId = response.locals.ownerId;
    try {
      const document = await withTenantTransaction(ownerId, async transaction => {
        const [row] = await transaction.select().from(documents)
          .where(eq(documents.id, request.params.id))
          .limit(1);
        return row ? serializeDocument(transaction, row) : undefined;
      }, { consistentRead: true });
      if (!document) {
        sendNotFound(response);
        return;
      }
      response.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
    const parsed = parseFields(request.body, ['title', 'customerName', 'issueDate']);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
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

  router.delete('/:id', async (request, response: AuthenticatedResponse, next) => {
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
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

  router.post('/:id/duplicate', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
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
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
    const issueDate = (body as { issueDate: string }).issueDate;
    try {
      const duplicate = await withTenantTransaction(ownerId, async transaction => {
        const [source] = await transaction.select().from(documents)
          .where(eq(documents.id, request.params.id))
          .for('update')
          .limit(1);
        if (!source) return undefined;

        const inserted = await transaction.execute<{ id: string }>(sql`
          INSERT INTO documents (owner_id, title, customer_name, issue_date)
          VALUES (${ownerId}, ${source.title.trim()}, ${source.customerName.trim()}, ${issueDate})
          RETURNING id
        `);
        const copyId = inserted.rows[0].id;
        await transaction.execute(sql`
          INSERT INTO line_items (
            document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
          )
          SELECT ${copyId}, row_number() OVER (ORDER BY position, id), description, quantity,
            unit_price_cents, discount_cents, tax_rate_basis_points
          FROM line_items WHERE document_id = ${source.id}
        `);
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

  router.post('/:id/finalize', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
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
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
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

        const pricing = calculatePricing(lines.map(databaseLineInput));
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
          const priced = pricing.lines[index];
          if (priced.discountExceedsSubtotal) {
            validationFields[`lineItems[${index}].discountCents`] = 'Discount cannot exceed the line subtotal.';
          }
          if (!priced.withinSafeRange) {
            validationFields[`lineItems[${index}].unitPriceCents`] = 'Line amounts exceed the supported safe integer range.';
          }
          return { id: line.id, amounts: priced.amounts };
        });
        const documentAmounts = pricing.amounts;
        if (!amountsWithinSafeRange(documentAmounts)) {
          validationFields.body = 'Document amounts exceed the supported safe integer range.';
        }
        if (Object.keys(validationFields).length > 0) return { kind: 'invalid' as const, fields: validationFields };

        const finalizedAt = clock.now();
        await writeLineSnapshots(transaction, current.id, snapshots);
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

  router.post('/:id/line-items', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
    const parsed = parseLineFields(request.body, ['quantity', 'unitPriceCents']);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    if (!parseUuid(request.params.id)) {
      sendNotFound(response);
      return;
    }

    const input = completeLineInput(parsed.values);
    const inputErrors = linePricingErrors(input);
    if (Object.keys(inputErrors).length > 0) {
      sendValidation(response, inputErrors);
      return;
    }

    const ownerId = response.locals.ownerId;
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

        const intended: DraftLineInput[] = [...existing];
        intended.splice(requestedPosition - 1, 0, input);
        const pricing = calculatePricing(intended);
        if (!pricing.withinSafeRange) {
          return { kind: 'invalid' as const, fields: { body: 'Document amounts exceed the supported safe integer range.' } as Fields };
        }

        await replaceDraftLines(transaction, locked.documentId, intended);
        const [created] = await transaction.select().from(lineItems)
          .where(and(eq(lineItems.documentId, locked.documentId), eq(lineItems.position, requestedPosition)))
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

  router.patch('/:id/line-items/:lineItemId', json({ limit: '64kb' }), async (request, response: AuthenticatedResponse, next) => {
    const parsed = parseLineFields(request.body);
    if (!parsed.values || Object.keys(parsed.fields).length > 0) {
      sendValidation(response, parsed.fields);
      return;
    }
    const lineItemId = parseUuid(request.params.lineItemId);
    if (!parseUuid(request.params.id) || !lineItemId) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const locked = await lockDraftLines(transaction, request.params.id);
        if (locked.kind !== 'draft') return locked;
        const currentIndex = locked.lines.findIndex(line => line.id === lineItemId);
        if (currentIndex === -1) return { kind: 'line_missing' as const };
        const current = locked.lines[currentIndex];
        const { position: newPosition = currentIndex + 1, ...changes } = parsed.values!;
        const input = { ...current, ...changes };
        const inputErrors = linePricingErrors(input);
        if (newPosition > locked.lines.length) {
          inputErrors.position = 'Position must be between 1 and the current line count.';
        }
        if (newPosition !== currentIndex + 1 && locked.lines.length >= MAX_DATABASE_INTEGER) {
          inputErrors.position = 'This draft cannot contain more line items.';
        }

        const intended = locked.lines.filter(line => line.id !== current.id);
        intended.splice(newPosition - 1, 0, input);
        const pricing = calculatePricing(intended);
        if (!pricing.withinSafeRange) {
          inputErrors.body = 'Document amounts exceed the supported safe integer range.';
        }
        if (Object.keys(inputErrors).length > 0) return { kind: 'invalid' as const, fields: inputErrors };

        await replaceDraftLines(transaction, locked.documentId, intended);
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

  router.delete('/:id/line-items/:lineItemId', async (request, response: AuthenticatedResponse, next) => {
    const lineItemId = parseUuid(request.params.lineItemId);
    if (!parseUuid(request.params.id) || !lineItemId) {
      sendNotFound(response);
      return;
    }

    const ownerId = response.locals.ownerId;
    try {
      const result = await withTenantTransaction(ownerId, async transaction => {
        const locked = await lockDraftLines(transaction, request.params.id);
        if (locked.kind !== 'draft') return locked;
        const current = locked.lines.find(line => line.id === lineItemId);
        if (!current) return { kind: 'line_missing' as const };

        await replaceDraftLines(transaction, locked.documentId, locked.lines.filter(line => line.id !== current.id));
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
