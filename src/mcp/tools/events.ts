import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { buildQueryString, injectOrThrow, textResult } from "../errors.js";
import type { McpSessionContext } from "../server.js";
import {
	resolveToolAuthorization,
	withOptionalAuthorizationSchema,
} from "./auth.js";

export function registerEventTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	server.registerTool(
		"agentinfra.events.list",
		{
			description:
				"List events for an agent across all capabilities — email activity, card transactions, and more. Filter by type or time range.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				type: z.string().optional().describe("Filter by event type"),
				since: z.string().optional().describe("ISO 8601 start time"),
				until: z.string().optional().describe("ISO 8601 end time"),
				cursor: z.string().optional().describe("Pagination cursor"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Page size (default 20)"),
			}),
		},
		async ({ agent_id, type, since, until, cursor, limit, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const qs = buildQueryString({ type, since, until, cursor, limit });
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents/${agent_id}/events${qs}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.timeline.list",
		{
			description:
				"View an agent's activity timeline with events grouped into threads and transaction clusters. Provides a unified view across email and payment activity.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				since: z.string().optional().describe("ISO 8601 start time"),
				until: z.string().optional().describe("ISO 8601 end time"),
				cursor: z.string().optional().describe("Pagination cursor"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Page size (default 20)"),
			}),
		},
		async ({ agent_id, since, until, cursor, limit, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const qs = buildQueryString({ since, until, cursor, limit });
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents/${agent_id}/timeline${qs}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);
}
