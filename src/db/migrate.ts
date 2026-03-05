import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:password@localhost:5432/agentconnect_dev';

async function main() {
  console.log('Running migrations...');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1, // Only one connection needed for migrations
  });

  const db = drizzle(pool);

  // This will run migrations on the database
  // Skipping fetching schema path if compiled
  const migrationsFolder = path.join(__dirname, 'migrations');

  try {
    await migrate(db, { migrationsFolder });
    console.log('Migrations complete!');
  } catch (error) {
    console.error('Migration failed!', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
