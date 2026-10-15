import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { json, type Request, type RequestHandler } from 'express';
import { documents, draftSaveMutations, lineItems } from '../db/schema.js';
import { withTenantTransaction, type AuthenticatedOwnerId } from '../db/client.js';
import { isCalendarDate } from '../shared/document-validation.js';
import { amountsWithinSafeRange, calculateDocumentAmounts, calculateLineAmounts } from '../shared/pricing.js';
import { authenticatedOwnerId } from './auth.js';
import type { Clock } from './clock.js';
import { serializeDocument } from './documents.js';

type Fields = Record<string, string>;
type DraftLine = {
  id?: string;
  description: string;
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
};
type DraftSave = {
  mutationId: string;
  documentId?: string;
  title: string;
  customerName: string;
  issueDate: string;
  lineItems: DraftLine[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINE_FIELDS = ['id', 'description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints'];
const DOCUMENT_FIELDS = ['mutationId', 'documentId', 'title', 'customerName', 'issueDate', 'lineItems'];

class MissingDraft extends Error {}
class FinalizedDraft extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDraftSave(body: unknown): { values?: DraftSave; fields: Fields } {
  const fields: Fields = {};
  if (!record(body)) return { fields: { body: 'Send a document object.' } };
  for (const key of Object.keys(body)) {
    if (!DOCUMENT_FIELDS.includes(key)) fields[key] = 'This field is not allowed.';
  }
  if (typeof body.mutationId !== 'string' || !UUID.test(body.mutationId)) {
    fields.mutationId = 'Provide a valid mutation ID.';
  }
  if (body.documentId !== undefined && (typeof body.documentId !== 'string' || !UUID.test(body.documentId))) {
    fields.documentId = 'Provide a valid document ID.';
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') fields.title = 'Enter a document name.';
  if (typeof body.customerName !== 'string') fields.customerName = 'Enter a customer name.';
  if (!isCalendarDate(body.issueDate)) fields.issueDate = 'Enter a valid calendar date.';
  if (!Array.isArray(body.lineItems)) fields.lineItems = 'Send an ordered list of line items.';
  else if (body.lineItems.length > 2_147_483_647) fields.lineItems = 'This draft contains too many line items.';

  const parsedLines: DraftLine[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(body.lineItems)) {
    for (const [index, value] of body.lineItems.entries()) {
      const path = `lineItems[${index}]`;
      if (!record(value)) {
        fields[path] = 'Send a line item object.';
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!LINE_FIELDS.includes(key)) fields[`${path}.${key}`] = 'This field is not allowed.';
      }
      if (value.id !== undefined) {
        if (typeof value.id !== 'string' || !UUID.test(value.id)) fields[`${path}.id`] = 'Provide a valid line item ID.';
        else if (seenIds.has(value.id.toLowerCase())) fields[`${path}.id`] = 'Use each saved line item once.';
        else seenIds.add(value.id.toLowerCase());
      }
      if (typeof value.description !== 'string') fields[`${path}.description`] = 'Enter a line description.';
      if (typeof value.quantity !== 'number' || !Number.isSafeInteger(value.quantity) || value.quantity < 1) {
        fields[`${path}.quantity`] = 'Enter a positive whole quantity.';
      }
      if (typeof value.unitPriceCents !== 'number' || !Number.isSafeInteger(value.unitPriceCents) || value.unitPriceCents < 0) {
        fields[`${path}.unitPriceCents`] = 'Enter a nonnegative whole amount in cents.';
      }
      if (typeof value.discountCents !== 'number' || !Number.isSafeInteger(value.discountCents) || value.discountCents < 0) {
        fields[`${path}.discountCents`] = 'Enter a nonnegative whole amount in cents.';
      }
      if (typeof value.taxRateBasisPoints !== 'number' || !Number.isSafeInteger(value.taxRateBasisPoints)
        || value.taxRateBasisPoints < 0 || value.taxRateBasisPoints > 10_000) {
        fields[`${path}.taxRateBasisPoints`] = 'Enter a whole tax rate from 0 to 10000 basis points.';
      }
      if (Object.keys(fields).some(field => field.startsWith(path))) continue;
      const line: DraftLine = {
        ...(value.id === undefined ? {} : { id: (value.id as string).toLowerCase() }),
        description: (value.description as string).trim(),
        quantity: BigInt(value.quantity as number),
        unitPriceCents: BigInt(value.unitPriceCents as number),
        discountCents: BigInt(value.discountCents as number),
        taxRateBasisPoints: value.taxRateBasisPoints as number,
      };
      const amounts = calculateLineAmounts(line);
      if (line.discountCents > amounts.subtotalCents) {
        fields[`${path}.discountCents`] = 'Discount cannot exceed the line subtotal.';
      }
      if (!amountsWithinSafeRange(amounts)) {
        fields[`${path}.body`] = 'Line amounts exceed the supported safe integer range.';
      }
      parsedLines.push(line);
    }
  }
  if (Object.keys(fields).length === 0 && !amountsWithinSafeRange(calculateDocumentAmounts(parsedLines))) {
    fields.body = 'Document amounts exceed the supported safe integer range.';
  }
  if (Object.keys(fields).length > 0) return { fields };
  return {
    fields,
    values: {
      mutationId: (body.mutationId as string).toLowerCase(),
      ...(body.documentId === undefined ? {} : { documentId: (body.documentId as string).toLowerCase() }),
      title: (body.title as string).trim(),
      customerName: (body.customerName as string).trim(),
      issueDate: body.issueDate as string,
      lineItems: parsedLines,
    },
  };
}

function requestHash(values: DraftSave): string {
  return createHash('sha256').update(JSON.stringify({
    documentId: values.documentId ?? null,
    title: values.title,
    customerName: values.customerName,
    issueDate: values.issueDate,
    lineItems: values.lineItems.map(line => ({
      id: line.id ?? null,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPriceCents: line.unitPriceCents.toString(),
      discountCents: line.discountCents.toString(),
      taxRateBasisPoints: line.taxRateBasisPoints,
    })),
  })).digest('hex');
}

export function draftSaveHandler(clock: Clock): RequestHandler[] {
  return [async (request, response, next) => {
    try {
      const ownerId = await authenticatedOwnerId(request, clock);
      if (!ownerId) {
        response.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } });
        return;
      }
      (request as Request & { authenticatedOwnerId?: AuthenticatedOwnerId }).authenticatedOwnerId = ownerId;
      next();
    } catch (error) {
      next(error);
    }
  }, json({ limit: '64kb' }), async (request, response, next) => {
    try {
      const ownerId = (request as Request & { authenticatedOwnerId?: AuthenticatedOwnerId }).authenticatedOwnerId!;
      const parsed = parseDraftSave(request.body);
      if (!parsed.values) {
        response.status(422).json({ error: { code: 'validation_failed', message: 'Check the highlighted fields.', fields: parsed.fields } });
        return;
      }
      const values = parsed.values;
      const hash = requestHash(values);
      const result = await withTenantTransaction(ownerId, async transaction => {
        const insertedMutation = await transaction.execute<{ mutation_id: string }>(sql`
          INSERT INTO draft_save_mutations (owner_id, mutation_id, request_hash)
          VALUES (${ownerId}, ${values.mutationId}, ${hash})
          ON CONFLICT (owner_id, mutation_id) DO NOTHING
          RETURNING mutation_id
        `);
        if (insertedMutation.rows.length === 0) {
          const [previous] = await transaction.select().from(draftSaveMutations)
            .where(and(eq(draftSaveMutations.ownerId, ownerId), eq(draftSaveMutations.mutationId, values.mutationId)))
            .limit(1);
          if (!previous || !previous.response) throw new Error('Committed draft save is missing its response.');
          return previous.requestHash === hash
            ? { kind: 'replayed' as const, document: previous.response }
            : { kind: 'conflict' as const };
        }

        let row: typeof documents.$inferSelect;
        if (values.documentId) {
          const [existing] = await transaction.select().from(documents)
            .where(eq(documents.id, values.documentId)).for('update').limit(1);
          if (!existing) throw new MissingDraft();
          if (existing.status !== 'draft') throw new FinalizedDraft();
          row = existing;
        } else {
          const createdId = await transaction.execute<{ id: string }>(sql`
            INSERT INTO documents (owner_id, title, customer_name, issue_date)
            VALUES (${ownerId}, ${values.title}, ${values.customerName}, ${values.issueDate})
            RETURNING id
          `);
          const [created] = await transaction.select().from(documents)
            .where(eq(documents.id, createdId.rows[0].id)).limit(1);
          row = created;
        }

        const existingLines = await transaction.select().from(lineItems)
          .where(eq(lineItems.documentId, row.id)).orderBy(asc(lineItems.position));
        const existingIds = new Set(existingLines.map(line => line.id));
        if (values.lineItems.some(line => line.id && !existingIds.has(line.id))) throw new MissingDraft();

        // Position uniqueness is deferred only inside this transaction. The final ordered set is contiguous.
        await transaction.execute(sql`SET CONSTRAINTS line_items_document_position_unique DEFERRED`);
        const requestedIds = new Set(values.lineItems.map(line => line.id).filter((id): id is string => id !== undefined));
        for (const line of existingLines) {
          if (!requestedIds.has(line.id)) await transaction.delete(lineItems).where(eq(lineItems.id, line.id));
        }
        for (const [index, line] of values.lineItems.entries()) {
          const input = {
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            discountCents: line.discountCents,
            taxRateBasisPoints: line.taxRateBasisPoints,
            position: index + 1,
          };
          if (line.id) {
            await transaction.update(lineItems).set(input)
              .where(and(eq(lineItems.id, line.id), eq(lineItems.documentId, row.id)));
          } else {
            await transaction.execute(sql`
              INSERT INTO line_items (
                document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
              ) VALUES (
                ${row.id}, ${input.position}, ${input.description}, ${input.quantity}, ${input.unitPriceCents},
                ${input.discountCents}, ${input.taxRateBasisPoints}
              )
            `);
          }
        }
        await transaction.update(documents).set({
          title: values.title, customerName: values.customerName, issueDate: values.issueDate, updatedAt: clock.now(),
        }).where(eq(documents.id, row.id));
        const [updated] = await transaction.select().from(documents).where(eq(documents.id, row.id)).limit(1);
        const document = await serializeDocument(transaction, updated);
        await transaction.update(draftSaveMutations).set({ response: document })
          .where(and(eq(draftSaveMutations.ownerId, ownerId), eq(draftSaveMutations.mutationId, values.mutationId)));
        return { kind: values.documentId ? 'updated' as const : 'created' as const, document };
      });

      if (result.kind === 'conflict') {
        response.status(409).json({ error: { code: 'idempotency_conflict', message: 'This save identifier was already used for different changes.' } });
      } else {
        response.status(result.kind === 'created' ? 201 : 200).json(result.document);
      }
    } catch (error) {
      if (error instanceof MissingDraft) {
        response.status(404).json({ error: { code: 'not_found', message: 'Document not found.' } });
      } else if (error instanceof FinalizedDraft) {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be edited.' } });
      } else next(error);
    }
  }];
}
