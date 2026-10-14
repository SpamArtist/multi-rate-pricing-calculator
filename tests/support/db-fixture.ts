import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5432/pricing';

export const testPool = new Pool({ connectionString, max: 4 });

export async function withOwner<T>(ownerId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function testOwnerId(): string {
  return randomUUID();
}
