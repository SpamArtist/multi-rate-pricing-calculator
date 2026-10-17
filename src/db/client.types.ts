import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { schema } from './client.js';

export type TenantTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type TenantOperation<T> = (transaction: TenantTransaction) => Promise<T>;

export type TenantTransactionOptions = { consistentRead?: boolean };
