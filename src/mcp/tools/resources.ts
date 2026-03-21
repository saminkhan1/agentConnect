import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { injectOrThrow, textResult } from "../errors.js";
import type { McpSessionContext } from "../server.js";
import {
	resolveToolAuthorization,
	withOptionalAuthorizationSchema,
} from "./auth.js";

export function registerResourceTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	server.registerTool(
		"agentinfra.resources.create",
		{
			description:
				"Provision a new capability for an agent, such as an email inbox or other resource type. Each resource connects the agent to a real-world service.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				type: z.string().min(1).describe('Resource type, e.g. "email_inbox"'),
				provider: z.string().min(1).describe('Provider name, e.g. "agentmail"'),
				config: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Provider-specific configuration"),
			}),
		},
		async ({ agent_id, type, provider, config, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "POST",
				url: `/agents/${agent_id}/resources`,
				headers: {
					authorization: authHeader,
					"content-type": "application/json",
				},
				payload: JSON.stringify({ type, provider, config: config ?? {} }),
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.resources.list",
		{
			description:
				"List all active resources for an agent, including email inboxes, payment cards, and other provisioned capabilities.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
			}),
		},
		async ({ agent_id, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents/${agent_id}/resources`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);

	server.registerTool(
		"agentinfra.resources.delete",
		{
			description:
				"Deprovision a resource, removing the agent's access to the associated capability (e.g., email inbox or card).",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				resource_id: z.string().min(1).describe("Resource ID"),
			}),
		},
		async ({ agent_id, resource_id, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "DELETE",
				url: `/agents/${agent_id}/resources/${resource_id}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);
}
