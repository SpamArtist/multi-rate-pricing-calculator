import type { SummaryQuery } from './reports.types.js';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { Router, type Request, type RequestHandler } from 'express';
import { withTenantTransaction } from '../db/client.js';
import { documents } from '../db/schema.js';
import { isCalendarDate } from '../shared/document-validation.js';
import { MAX_SAFE_AMOUNT } from '../shared/pricing.js';
import type { FieldErrors as Fields } from '../shared/types/field-errors.js';
import { requireAuthenticated } from './auth.js';
import type { AuthenticatedResponse } from './auth.types.js';
import type { Clock } from '../shared/types/clock.js';

function parseSummaryQuery(request: Request): { fields: Fields; values?: SummaryQuery } {
  const fields = Object.create(null) as Fields;
  const params = new URL(request.originalUrl, 'http://localhost').searchParams;

  for (const name of new Set(params.keys())) {
    if (name !== 'start' && name !== 'end') {
      fields[name] = 'This query parameter is not allowed.';
    } else if (params.getAll(name).length !== 1) {
      fields[name] = 'Provide this query parameter once.';
    }
  }

  const value = (name: 'start' | 'end'): string | undefined => (
    params.getAll(name).length === 1 ? params.get(name) ?? undefined : undefined
  );
  const start = value('start');
  const end = value('end');

  if (!isCalendarDate(start)) fields.start ??= 'Enter a valid calendar date.';
  if (!isCalendarDate(end)) fields.end ??= 'Enter a valid calendar date.';
  if (isCalendarDate(start) && isCalendarDate(end) && start > end) {
    fields.end = 'End date must be on or after start date.';
  }

  if (Object.keys(fields).length > 0 || !isCalendarDate(start) || !isCalendarDate(end)) return { fields };
  return { fields, values: { start, end } };
}

function validationError(response: Parameters<RequestHandler>[1], fields: Fields): void {
  response.status(422).json({
    error: {
      code: 'validation_failed',
      message: 'Check the highlighted fields.',
      fields,
    },
  });
}

export function createReportsRouter(clock: Clock): Router {
  const router = Router();

  router.use(requireAuthenticated(clock), (_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/summary', async (request, response: AuthenticatedResponse, next) => {
    const parsed = parseSummaryQuery(request);
    if (!parsed.values) {
      validationError(response, parsed.fields);
      return;
    }

    const { start, end } = parsed.values;
    const ownerId = response.locals.ownerId;
    try {
      const aggregate = await withTenantTransaction(ownerId, async transaction => {
        const [row] = await transaction.select({
          documentCount: sql<string>`COUNT(*)::text`,
          subtotalCents: sql<string>`COALESCE(SUM(${documents.finalizedSubtotalCents}), 0)::text`,
          discountCents: sql<string>`COALESCE(SUM(${documents.finalizedDiscountCents}), 0)::text`,
          taxableCents: sql<string>`COALESCE(SUM(${documents.finalizedTaxableCents}), 0)::text`,
          taxCents: sql<string>`COALESCE(SUM(${documents.finalizedTaxCents}), 0)::text`,
          totalCents: sql<string>`COALESCE(SUM(${documents.finalizedTotalCents}), 0)::text`,
        }).from(documents).where(and(
          eq(documents.ownerId, ownerId),
          eq(documents.status, 'finalized'),
          gte(documents.issueDate, start),
          lte(documents.issueDate, end),
        ));

        return {
          documentCount: BigInt(row?.documentCount ?? '0'),
          amounts: {
            subtotalCents: BigInt(row?.subtotalCents ?? '0'),
            discountCents: BigInt(row?.discountCents ?? '0'),
            taxableCents: BigInt(row?.taxableCents ?? '0'),
            taxCents: BigInt(row?.taxCents ?? '0'),
            totalCents: BigInt(row?.totalCents ?? '0'),
          },
        };
      });

      const aggregateValues = [aggregate.documentCount, ...Object.values(aggregate.amounts)];
      if (aggregateValues.some(value => value < 0n || value > MAX_SAFE_AMOUNT)) {
        validationError(response, {
          start: 'Choose a narrower date range to keep the summary within the supported amount range.',
        });
        return;
      }

      response.status(200).json({
        start,
        end,
        finalizedDocumentCount: Number(aggregate.documentCount),
        amounts: {
          subtotalCents: Number(aggregate.amounts.subtotalCents),
          discountCents: Number(aggregate.amounts.discountCents),
          taxableCents: Number(aggregate.amounts.taxableCents),
          taxCents: Number(aggregate.amounts.taxCents),
          totalCents: Number(aggregate.amounts.totalCents),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
