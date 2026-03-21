import { z } from "zod";
import { eventTypeSchema } from "../../domain/events";
import { eventResponseSchema } from "./events";

export const listAgentTimelineParamsSchema = z.object({
	id: z.string().trim().min(1),
});

export const listAgentTimelineQuerySchema = z
	.object({
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

const timelineItemBaseSchema = z.object({
	id: z.string().min(1),
	groupKey: z.string().min(1),
	occurredAt: z.iso.datetime(),
	startedAt: z.iso.datetime(),
	eventCount: z.number().int().positive(),
	resourceId: z.string().nullable(),
	provider: z.string(),
	latestEventType: eventTypeSchema,
	events: z.array(eventResponseSchema),
});

export const emailThreadTimelineItemSchema = timelineItemBaseSchema.extend({
	kind: z.literal("email_thread"),
	summary: z.object({
		threadId: z.string().min(1),
		subject: z.string().nullable(),
		from: z.string().nullable(),
		to: z.array(z.string()),
	}),
});

export const cardActivityTimelineItemSchema = timelineItemBaseSchema.extend({
	kind: z.literal("card_activity"),
	summary: z.object({
		authorizationId: z.string().nullable(),
		transactionId: z.string().nullable(),
		amount: z.number().nullable(),
		currency: z.string().nullable(),
	}),
});

export const eventTimelineItemSchema = timelineItemBaseSchema.extend({
	kind: z.literal("event"),
	summary: z.object({
		eventType: eventTypeSchema,
	}),
});

export const timelineItemResponseSchema = z.discriminatedUnion("kind", [
	emailThreadTimelineItemSchema,
	cardActivityTimelineItemSchema,
	eventTimelineItemSchema,
]);

export const listAgentTimelineResponseSchema = z.object({
	items: z.array(timelineItemResponseSchema),
	nextCursor: z.string().nullable(),
});
