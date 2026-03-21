import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

import {
	decodeTimelineCursor,
	encodeTimelineCursor,
	type TimelineItem,
} from "../../domain/timeline";
import { requireScope } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";
import {
	listAgentTimelineParamsSchema,
	listAgentTimelineQuerySchema,
	listAgentTimelineResponseSchema,
} from "../schemas/timeline";
import { serializeEvent } from "./events";

function serializeTimelineItem(item: TimelineItem) {
	const baseItem = {
		id: item.id,
		groupKey: item.groupKey,
		occurredAt: item.occurredAt.toISOString(),
		startedAt: item.startedAt.toISOString(),
		eventCount: item.eventCount,
		resourceId: item.resourceId,
		provider: item.provider,
		latestEventType: item.latestEventType,
		events: item.events.map(serializeEvent),
	};

	if (item.summary.kind === "email_thread") {
		return {
			...baseItem,
			kind: "email_thread" as const,
			summary: item.summary.value,
		};
	}

	if (item.summary.kind === "card_activity") {
		return {
			...baseItem,
			kind: "card_activity" as const,
			summary: item.summary.value,
		};
	}

	return { ...baseItem, kind: "event" as const, summary: item.summary.value };
}

const timelineRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.get(
		"/agents/:id/timeline",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				params: listAgentTimelineParamsSchema,
				querystring: listAgentTimelineQuerySchema,
				response: {
					200: listAgentTimelineResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const dal = request.dalFactory(request.auth.org_id);
			const existingAgent = await dal.agents.findById(request.params.id);
			if (!existingAgent) {
				return reply.code(404).send({ message: "Agent not found" });
			}

			const decodedCursor = request.query.cursor
				? decodeTimelineCursor(request.query.cursor)
				: null;
			if (request.query.cursor && !decodedCursor) {
				return reply.code(400).send({ message: "Invalid cursor" });
			}

			const pageSize = request.query.limit;
			const items = await dal.events.listTimelineByAgent(request.params.id, {
				since: request.query.since ? new Date(request.query.since) : undefined,
				until: request.query.until ? new Date(request.query.until) : undefined,
				cursor: decodedCursor ?? undefined,
				limit: pageSize + 1,
			});

			const hasMore = items.length > pageSize;
			const pagedItems = hasMore ? items.slice(0, pageSize) : items;
			const nextCursor = hasMore
				? encodeTimelineCursor(pagedItems[pagedItems.length - 1])
				: null;

			return reply.code(200).send({
				items: pagedItems.map(serializeTimelineItem),
				nextCursor,
			});
		},
	);

	done();
};

export default timelineRoutes;
