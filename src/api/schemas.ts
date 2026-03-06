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

export const agentIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const createAgentBodySchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

const includeArchivedQueryValueSchema = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .optional()
  .transform((value) => value === true || value === 'true');

export const listAgentsQuerySchema = z
  .object({
    includeArchived: includeArchivedQueryValueSchema,
  })
  .strict();

export const updateAgentBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.isArchived !== undefined, {
    message: 'At least one field must be provided',
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

export const agentResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  isArchived: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const createAgentResponseSchema = z.object({
  agent: agentResponseSchema,
});

export const listAgentsResponseSchema = z.object({
  agents: z.array(agentResponseSchema),
});

export const errorResponseSchema = z.object({
  message: z.string(),
});
