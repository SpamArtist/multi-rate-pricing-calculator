import { json } from 'express';
import { amountsWithinSafeRange, calculatePricing } from '../../shared/pricing.js';
import type { FieldErrors as Fields } from '../../shared/types/field-errors.js';
import { requireAuthenticated, type AuthenticatedHandler } from '../auth.js';
import type { Clock } from '../clock.js';
import { saveDraft, type DraftSaveInput } from '../draft-save.js';
import {
  fields as createFields, inputError, isRecord, linePricingErrors, parseAmount, parseCustomerName,
  parseDescription, parseIssueDate, parseQuantity, parseTaxRate, parseTitle, parseUuid, rejectUnknownFields,
} from '../document-input.js';

const LINE_FIELDS = ['id', 'description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints'];
const DOCUMENT_FIELDS = ['mutationId', 'documentId', 'title', 'customerName', 'issueDate', 'lineItems'];

function parseDraftSave(body: unknown): { values?: DraftSaveInput; fields: Fields } {
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

  const parsedLines: DraftSaveInput['lineItems'] = [];
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
      const line: DraftSaveInput['lineItems'][number] = {
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

export function draftSaveHandler(clock: Clock): AuthenticatedHandler[] {
  return [requireAuthenticated(clock), json({ limit: '64kb' }), async (request, response, next) => {
    try {
      const ownerId = response.locals.ownerId;
      const parsed = parseDraftSave(request.body);
      if (!parsed.values) {
        response.status(422).json({ error: { code: 'validation_failed', message: 'Check the highlighted fields.', fields: parsed.fields } });
        return;
      }
      const result = await saveDraft(ownerId, parsed.values, clock);

      if (result.kind === 'conflict') {
        response.status(409).json({ error: { code: 'idempotency_conflict', message: 'This save identifier was already used for different changes.' } });
      } else if (result.kind === 'not_found') {
        response.status(404).json({ error: { code: 'not_found', message: 'Document not found.' } });
      } else if (result.kind === 'invalid_state') {
        response.status(409).json({ error: { code: 'invalid_state', message: 'Finalized documents cannot be edited.' } });
      } else {
        response.status(result.kind === 'created' ? 201 : 200).json(result.document);
      }
    } catch (error) {
      next(error);
    }
  }];
}
