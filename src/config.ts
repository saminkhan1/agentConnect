import { z } from 'zod';

export const DEFAULT_DATABASE_URL =
  'postgresql://postgres:password@localhost:5432/agentconnect_dev';

const nodeEnvSchema = z.enum(['development', 'test', 'production']);

const hostSchema = z.string().trim().min(1);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const postgresUrlSchema = z
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must use postgres:// or postgresql://',
  });

const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.optional().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),
  HOST: hostSchema.optional().default('0.0.0.0'),
  LOG_LEVEL: logLevelSchema.optional().default('info'),
});

const dbEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.optional().default('development'),
  DATABASE_URL: z.string().trim().optional(),
});

export type ServerConfig = z.infer<typeof serverEnvSchema>;

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return serverEnvSchema.parse(env);
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsedEnv = dbEnvSchema.parse(env);

  if (parsedEnv.DATABASE_URL && parsedEnv.DATABASE_URL.length > 0) {
    return postgresUrlSchema.parse(parsedEnv.DATABASE_URL);
  }

  if (parsedEnv.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL must be set in production');
  }

  return DEFAULT_DATABASE_URL;
}
