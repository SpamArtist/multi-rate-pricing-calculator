import type { DraftLineInput } from '../shared/types/draft-line.js';
import { and, eq, sql } from 'drizzle-orm';
import type { TenantTransaction } from './client.types.js';
import { lineItems } from './schema.js';
import type { ExactAmounts } from '../shared/types/pricing.js';

/** The caller holds the document lock and has validated every supplied line ID. */
export async function replaceDraftLines(
  transaction: TenantTransaction, documentId: string, lines: readonly DraftLineInput[],
): Promise<void> {
  await transaction.execute(sql`SET CONSTRAINTS line_items_document_position_unique DEFERRED`);
  const retainedIds = lines.flatMap(line => line.id ? [line.id] : []);
  await transaction.delete(lineItems).where(and(
    eq(lineItems.documentId, documentId),
    sql`${lineItems.id} != ALL(${sql.param(retainedIds)}::uuid[])`,
  ));

  const positioned = lines.map((line, index) => ({ ...line, position: index + 1 }));
  const retained = positioned.filter(line => line.id !== undefined);
  if (retained.length > 0) {
    await transaction.execute(sql`
      UPDATE line_items AS target SET
        position = input.position, description = input.description, quantity = input.quantity,
        unit_price_cents = input.unit_price_cents, discount_cents = input.discount_cents,
        tax_rate_basis_points = input.tax_rate_basis_points
      FROM unnest(
        ${sql.param(retained.map(line => line.id))}::uuid[],
        ${sql.param(retained.map(line => line.position))}::integer[],
        ${sql.param(retained.map(line => line.description))}::text[],
        ${sql.param(retained.map(line => line.quantity))}::bigint[],
        ${sql.param(retained.map(line => line.unitPriceCents))}::bigint[],
        ${sql.param(retained.map(line => line.discountCents))}::bigint[],
        ${sql.param(retained.map(line => line.taxRateBasisPoints))}::integer[]
      ) AS input (
        id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
      )
      WHERE target.document_id = ${documentId} AND target.id = input.id
        AND (target.position, target.description, target.quantity, target.unit_price_cents,
          target.discount_cents, target.tax_rate_basis_points) IS DISTINCT FROM
          (input.position, input.description, input.quantity, input.unit_price_cents,
          input.discount_cents, input.tax_rate_basis_points)
    `);
  }

  const added = positioned.filter(line => line.id === undefined);
  if (added.length > 0) {
    const values = added.map(line => sql`(
      ${documentId}, ${line.position}, ${line.description}, ${line.quantity},
      ${line.unitPriceCents}, ${line.discountCents}, ${line.taxRateBasisPoints}
    )`);
    await transaction.execute(sql`
      INSERT INTO line_items (
        document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points
      ) VALUES ${sql.join(values, sql`, `)}
    `);
  }
}

/** Freeze server-calculated amounts while the caller holds the document lock. */
export async function writeLineSnapshots(
  transaction: TenantTransaction, documentId: string,
  snapshots: readonly { id: string; amounts: ExactAmounts }[],
): Promise<void> {
  if (snapshots.length === 0) return;
  await transaction.execute(sql`
    UPDATE line_items AS target SET
      finalized_subtotal_cents = snapshot.subtotal_cents,
      finalized_taxable_cents = snapshot.taxable_cents,
      finalized_tax_cents = snapshot.tax_cents,
      finalized_total_cents = snapshot.total_cents
    FROM unnest(
      ${sql.param(snapshots.map(snapshot => snapshot.id))}::uuid[],
      ${sql.param(snapshots.map(snapshot => snapshot.amounts.subtotalCents))}::bigint[],
      ${sql.param(snapshots.map(snapshot => snapshot.amounts.taxableCents))}::bigint[],
      ${sql.param(snapshots.map(snapshot => snapshot.amounts.taxCents))}::bigint[],
      ${sql.param(snapshots.map(snapshot => snapshot.amounts.totalCents))}::bigint[]
    ) AS snapshot (
      id, subtotal_cents, taxable_cents, tax_cents, total_cents
    )
    WHERE target.document_id = ${documentId} AND target.id = snapshot.id
  `);
}
