import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:password@localhost:5432/agentconnect_dev';

function createPool() {
  return new Pool({
    connectionString: databaseUrl,
    // Allows tests/short-lived scripts to exit cleanly without explicit pool shutdown.
    allowExitOnIdle: true,
  });
}

function createDbClient(client: Pool) {
  return drizzle({ client, schema });
}

export let pool = createPool();
export let db = createDbClient(pool);

let isPoolClosed = false;

export function ensureDbIsReady() {
  if (!isPoolClosed) {
    return;
  }

  pool = createPool();
  db = createDbClient(pool);
  isPoolClosed = false;
}

export async function closeDbPool() {
  if (isPoolClosed) {
    return;
  }

  await pool.end();
  isPoolClosed = true;
}
