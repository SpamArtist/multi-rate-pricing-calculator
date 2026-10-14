import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { documents } from './schema.js';

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://pricing_runtime:pricing_runtime@127.0.0.1:5432/pricing';

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema: { documents } });

export async function checkDatabase(): Promise<void> {
  await db.execute(sql`select 1`);
}
