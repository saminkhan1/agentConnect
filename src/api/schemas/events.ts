import { z } from "zod";

import { eventTypeSchema } from "../../domain/events";

export const listAgentEventsParamsSchema = z.object({
	id: z.string().trim().min(1),
});

export const listAgentEventsQuerySchema = z
	.object({
		type: eventTypeSchema.optional(),
		since: z.iso.datetime({ offset: true }).optional(),
		until: z.iso.datetime({ offset: true }).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict()
	.refine(
		(data) => {
			if (!data.since || !data.until) {
				return true;
			}

			return new Date(data.since).getTime() <= new Date(data.until).getTime();
		},
		{
			message: "`since` must be before or equal to `until`",
			path: ["since"],
		},
	);

export const eventResponseSchema = z.object({
	id: z.uuid(),
	orgId: z.string(),
	agentId: z.string(),
	resourceId: z.string().nullable(),
	provider: z.string(),
	providerEventId: z.string().nullable(),
	eventType: eventTypeSchema,
	occurredAt: z.iso.datetime(),
	idempotencyKey: z.string().nullable(),
	data: z.record(z.string(), z.unknown()),
	ingestedAt: z.iso.datetime(),
});

export const listAgentEventsResponseSchema = z.object({
	events: z.array(eventResponseSchema),
	nextCursor: z.string().nullable(),
});
