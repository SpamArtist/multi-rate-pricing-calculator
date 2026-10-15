import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { json } from 'express';
import { documents, draftSaveMutations, lineItems } from '../db/schema.js';
import { withTenantTransaction } from '../db/client.js';
import { amountsWithinSafeRange, calculatePricing } from '../shared/pricing.js';
import { requireAuthenticated, type AuthenticatedHandler } from './auth.js';
import type { Clock } from './clock.js';
import { serializeDocument } from './document-projection.js';
import {
  fields as createFields, inputError, isRecord, linePricingErrors, parseAmount, parseCustomerName,
  parseDescription, parseIssueDate, parseQuantity, parseTaxRate, parseTitle, parseUuid, rejectUnknownFields,
  type Fields,
} from './document-input.js';

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

const LINE_FIELDS = ['id', 'description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints'];
const DOCUMENT_FIELDS = ['mutationId', 'documentId', 'title', 'customerName', 'issueDate', 'lineItems'];

class MissingDraft extends Error {}
class FinalizedDraft extends Error {}

function parseDraftSave(body: unknown): { values?: DraftSave; fields: Fields } {
  const fields = createFields();
  if (!isRecord(body)) {
    fields.body = 'Send a document object.';
    return { fields };
  }
  rejectUnknownFields(body, DOCUMENT_FIELDS, fields);
  const mutationId = parseUuid(body.mutationId);
  const documentId = body.documentId === undefined ? undefined : parseUuid(body.documentId);
  const title = parseTitle(body.title);
  const customerName = parseCustomerName(body.customerName);
  const issueDate = parseIssueDate(body.issueDate);
  if (mutationId === undefined) {
    fields.mutationId = 'Provide a valid mutation ID.';
  }
  if (body.documentId !== undefined && documentId === undefined) {
    fields.documentId = 'Provide a valid document ID.';
  }
  if (title === undefined) fields.title = inputError.title;
  if (customerName === undefined) fields.customerName = inputError.customerName;
  if (issueDate === undefined) fields.issueDate = inputError.issueDate;
  if (!Array.isArray(body.lineItems)) fields.lineItems = 'Send an ordered list of line items.';
  else if (body.lineItems.length > 2_147_483_647) fields.lineItems = 'This draft contains too many line items.';

  const parsedLines: DraftLine[] = [];
  const parsedLineIndices: number[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(body.lineItems)) {
    for (const [index, value] of body.lineItems.entries()) {
      const path = `lineItems[${index}]`;
      if (!isRecord(value)) {
        fields[path] = 'Send a line item object.';
        continue;
      }
      const lineFields = createFields();
      rejectUnknownFields(value, LINE_FIELDS, lineFields);
      const id = value.id === undefined ? undefined : parseUuid(value.id);
      if (value.id !== undefined) {
        if (id === undefined) lineFields.id = 'Provide a valid line item ID.';
        else if (seenIds.has(id)) lineFields.id = 'Use each saved line item once.';
        else seenIds.add(id);
      }
      const description = parseDescription(value.description);
      const quantity = parseQuantity(value.quantity);
      const unitPriceCents = parseAmount(value.unitPriceCents);
      const discountCents = parseAmount(value.discountCents);
      const taxRateBasisPoints = parseTaxRate(value.taxRateBasisPoints);
      if (description === undefined) lineFields.description = inputError.description;
      if (quantity === undefined) lineFields.quantity = inputError.quantity;
      if (unitPriceCents === undefined) lineFields.unitPriceCents = inputError.amount;
      if (discountCents === undefined) lineFields.discountCents = inputError.amount;
      if (taxRateBasisPoints === undefined) lineFields.taxRateBasisPoints = inputError.taxRateBasisPoints;
      for (const [field, message] of Object.entries(lineFields)) fields[`${path}.${field}`] = message;
      if (Object.keys(lineFields).length > 0 || description === undefined || quantity === undefined
        || unitPriceCents === undefined || discountCents === undefined || taxRateBasisPoints === undefined) continue;
      const line: DraftLine = {
        ...(id === undefined ? {} : { id }),
        description, quantity, unitPriceCents, discountCents, taxRateBasisPoints,
      };
      parsedLines.push(line);
      parsedLineIndices.push(index);
    }
  }
  const pricing = calculatePricing(parsedLines);
  for (const [index] of pricing.lines.entries()) {
    const path = `lineItems[${parsedLineIndices[index]}]`;
    const pricingFields = linePricingErrors(parsedLines[index]);
    for (const [field, message] of Object.entries(pricingFields)) fields[`${path}.${field}`] = message;
  }
  if (Object.keys(fields).length === 0 && !amountsWithinSafeRange(pricing.amounts)) {
    fields.body = 'Document amounts exceed the supported safe integer range.';
  }
  if (Object.keys(fields).length > 0 || mutationId === undefined || title === undefined
    || customerName === undefined || issueDate === undefined) return { fields };
  return {
    fields,
    values: {
      mutationId,
      ...(documentId === undefined ? {} : { documentId }),
      title, customerName, issueDate,
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

export function draftSaveHandler(clock: Clock): AuthenticatedHandler[] {
  return [requireAuthenticated(clock), json({ limit: '64kb' }), async (request, response, next) => {
    try {
      const ownerId = response.locals.ownerId;
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
