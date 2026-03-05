import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

function resolveDatabaseUrl(): string {
  const configuredUrl = process.env.DATABASE_URL;
  if (configuredUrl && configuredUrl.trim().length > 0) {
    return configuredUrl;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL must be set in production');
  }

  return 'postgresql://localhost:5432/agentconnect_dev';
}

function createPool() {
  return new Pool({
    connectionString: resolveDatabaseUrl(),
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
