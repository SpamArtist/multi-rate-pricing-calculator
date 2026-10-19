import type { TenantOperation, TenantTransactionOptions } from './client.types.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { documents, draftSaveMutations, lineItems, sessions, users } from './schema.js';

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5432/pricing';
const pool = new Pool({ connectionString });
export const schema = { users, sessions, documents, lineItems, draftSaveMutations };
export const db = drizzle(pool, { schema });

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Run tenant repository work only after binding authenticated identity to this transaction. */
export async function withTenantTransaction<T>(
  ownerId: AuthenticatedOwnerId,
  operation: TenantOperation<T>,
  options?: TenantTransactionOptions,
): Promise<T> {
  if (!uuidPattern.test(ownerId)) throw new TypeError('Authenticated owner ID must be a UUID.');

  return db.transaction(async transaction => {
    options?.observer?.onEntry();
    options?.observer?.onBindStart();
    try {
      await transaction.execute(sql`select set_config('app.user_id', ${ownerId}, true)`);
      options?.observer?.onBindEnd();
    } catch (error) {
      options?.observer?.onBindEnd(error);
      throw error;
    }
    try {
      return await operation(transaction);
    } finally {
      options?.observer?.onCallbackEnd();
    }
  }, options?.consistentRead ? { isolationLevel: 'repeatable read' } : undefined);
}

export async function checkDatabase(): Promise<void> {
  await pool.query('select 1');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
