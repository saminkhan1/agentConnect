import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { agents, apiKeys,orgs } from '../db/schema';

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
