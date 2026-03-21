import { z } from "zod";

export const createOrgBodySchema = z
	.object({
		name: z.string().trim().min(1),
	})
	.strict();

export const createApiKeyParamsSchema = z.object({
	id: z.string().trim().min(1),
});

const apiKeyResponseSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	keyType: z.enum(["root", "service"]),
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
		keyType: z.literal("root"),
	}),
	nextStep: z
		.object({
			action: z.string(),
			message: z.string(),
		})
		.optional(),
});

export const createServiceApiKeyResponseSchema = z.object({
	apiKey: apiKeyResponseSchema.extend({
		keyType: z.literal("service"),
	}),
});
