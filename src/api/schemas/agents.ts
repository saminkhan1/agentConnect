import { z } from "zod";

export const agentIdParamsSchema = z.object({
	id: z.string().trim().min(1),
});

export const createAgentBodySchema = z
	.object({
		name: z.string().trim().min(1),
	})
	.strict();

const includeArchivedQueryValueSchema = z
	.union([z.boolean(), z.literal("true"), z.literal("false")])
	.optional()
	.transform((value) => value === true || value === "true");

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
		message: "At least one field must be provided",
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
