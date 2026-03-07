import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

import { resolveDatabaseUrl } from '../config';

function resolveMigrationsFolder() {
  const candidates = [
    path.join(__dirname, 'migrations'),
    path.resolve(__dirname, '../../src/db/migrations'),
    path.resolve(process.cwd(), 'src/db/migrations'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate migrations folder from ${__dirname}`);
}

async function main() {
  console.log('Running migrations...');
  const pool = new Pool({
    connectionString: resolveDatabaseUrl(process.env),
    max: 1, // Only one connection needed for migrations
  });

  const db = drizzle(pool);

  const migrationsFolder = resolveMigrationsFolder();

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
