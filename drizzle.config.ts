import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';
dotenv.config();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/agentconnect_dev',
  },
});
