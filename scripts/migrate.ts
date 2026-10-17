import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const connectionString = process.env.MIGRATOR_DATABASE_URL
  ?? 'postgres://pricing_migrator:pricing_migrator@127.0.0.1:5432/pricing';
const migrationPool = new Pool({ connectionString });

try {
  await migrate(drizzle(migrationPool), { migrationsFolder: './drizzle' });
  console.log('Migrations applied with pricing_migrator.');
} finally {
  await migrationPool.end();
}
