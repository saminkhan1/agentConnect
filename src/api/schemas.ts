import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { agents, apiKeys, orgs } from '../db/schema';

// Generate Zod schemas directly from the Drizzle ORM schema
// This ensures that any change in the DB tables automatically propagates to API validation!

export const insertOrgSchema = createInsertSchema(orgs);
export const selectOrgSchema = createSelectSchema(orgs);

export const insertApiKeySchema = createInsertSchema(apiKeys);
export const selectApiKeySchema = createSelectSchema(apiKeys);

export const insertAgentSchema = createInsertSchema(agents, {
  orgId: z.string().optional(), // Orgs might be injected via auth/DAL context rather than strictly user body
});
export const selectAgentSchema = createSelectSchema(agents);

export const createOrgBodySchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

export const createApiKeyParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const apiKeyTypeSchema = z.enum(['root', 'service']);

const apiKeyResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  keyType: apiKeyTypeSchema,
  key: z.string(),
  createdAt: z.iso.datetime(),
});

export const createOrgResponseSchema = z.object({
  org: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  }),
  apiKey: apiKeyResponseSchema.extend({
    keyType: z.literal('root'),
  }),
});

export const createServiceApiKeyResponseSchema = z.object({
  apiKey: apiKeyResponseSchema.extend({
    keyType: z.literal('service'),
  }),
});

export const errorResponseSchema = z.object({
  message: z.string(),
});
