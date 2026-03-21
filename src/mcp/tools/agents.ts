import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { buildQueryString, injectOrThrow, textResult } from "../errors.js";
import type { McpSessionContext } from "../server.js";
import {
	resolveToolAuthorization,
	withOptionalAuthorizationSchema,
} from "./auth.js";

export function registerAgentTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	server.registerTool(
		"agentinfra.agents.create",
		{
			description:
				"Create a new agent that can be assigned email inboxes, payment cards, and other capabilities.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				name: z.string().min(1).describe("Agent name"),
			}),
		},
		async ({ name, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "POST",
				url: "/agents",
				headers: {
					authorization: authHeader,
					"content-type": "application/json",
				},
				payload: JSON.stringify({ name }),
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.agents.list",
		{
			description:
				"List all agents in your organization, including their assigned resources and status.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				include_archived: z
					.boolean()
					.optional()
					.describe("Include archived agents"),
			}),
		},
		async ({ include_archived, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const qs = buildQueryString({
				includeArchived: include_archived === true ? "true" : undefined,
			});
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents${qs}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.agents.get",
		{
			description:
				"Retrieve details for a specific agent, including its name and current status.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
			}),
		},
		async ({ agent_id, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents/${agent_id}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.agents.update",
		{
			description: "Update an agent's name or archived status.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				name: z.string().min(1).optional().describe("New name"),
				is_archived: z.boolean().optional().describe("Archive or unarchive"),
			}),
		},
		async ({ agent_id, name, is_archived, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const body: Record<string, unknown> = {};
			if (name !== undefined) body.name = name;
			if (is_archived !== undefined) body.isArchived = is_archived;
			const data = await injectOrThrow(fastify, {
				method: "PATCH",
				url: `/agents/${agent_id}`,
				headers: {
					authorization: authHeader,
					"content-type": "application/json",
				},
				payload: JSON.stringify(body),
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.agents.archive",
		{
			description:
				"Archive an agent, removing it from active use while preserving its event history.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
			}),
		},
		async ({ agent_id, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "DELETE",
				url: `/agents/${agent_id}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);
}
