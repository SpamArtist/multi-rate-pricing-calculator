import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const runtimeConnectionString = process.env.DATABASE_URL
  ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5432/pricing';
const migratorConnectionString = process.env.MIGRATOR_DATABASE_URL
  ?? 'postgres://pricing_migrator:pricing_migrator@127.0.0.1:5432/pricing';

export const testPool = new Pool({ connectionString: runtimeConnectionString, max: 1 });
export const migrationPool = new Pool({ connectionString: migratorConnectionString, max: 1 });

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

export async function createTestOwner(ownerId: string, email: string): Promise<void> {
  await migrationPool.query(
    `INSERT INTO users (id, email_display, email_canonical, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [ownerId, email, email.toLowerCase(), '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash'],
  );
}

export async function deleteTestOwner(ownerId: string): Promise<void> {
  await migrationPool.query('DELETE FROM users WHERE id = $1', [ownerId]);
}

export function testOwnerId(): string {
  return randomUUID();
}
