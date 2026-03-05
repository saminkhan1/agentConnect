import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:password@localhost:5432/agentconnect_dev';

// Set up postgres pool
export const pool = new Pool({
  connectionString: databaseUrl,
});

export const db = drizzle({ client: pool, schema });
