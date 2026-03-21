import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { injectOrThrow } from "../errors.js";
import type { McpSessionContext } from "../server.js";

type OrgCreateResponse = {
	org: { id: string; name: string };
	apiKey: { key: string };
};
type ApiKeyCreateResponse = { apiKey: { id: string; key: string } };

export function registerBootstrapTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	server.registerTool(
		"agentinfra.orgs.create",
		{
			description:
				"Create a new organization and return a root API key. Use the returned key for all subsequent calls.",
			inputSchema: { name: z.string().min(1).describe("Organization name") },
		},
		async ({ name }) => {
			const data = await injectOrThrow<OrgCreateResponse>(fastify, {
				method: "POST",
				url: "/orgs",
				headers: { "content-type": "application/json" },
				payload: JSON.stringify({ name }),
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Organization "${data.org.name}" created. org_id=${data.org.id}. Root key stored in structuredContent only.`,
					},
				],
				structuredContent: {
					org_id: data.org.id,
					org_name: data.org.name,
					root_key: data.apiKey.key,
				},
			};
		},
	);

	if (!session.auth || session.auth.key_type === "root") {
		server.registerTool(
			"agentinfra.api_keys.create_service",
			{
				description:
					"Create a service API key for an organization. Requires root-key auth. " +
					"If the MCP connection is already authenticated with a root key, omit the authorization field — " +
					"it will be used automatically. Only pass authorization explicitly when the connection has no auth " +
					"(e.g. immediately after orgs.create). Never store the key in conversation history.",
				inputSchema: {
					org_id: z.string().min(1).describe("Organization ID"),
					authorization: z
						.string()
						.optional()
						.describe(
							"Bearer root API key (Bearer sk_...). Omit if the MCP connection is already authenticated with a root key.",
						),
				},
			},
			async ({ org_id, authorization: inputAuth }) => {
				const auth = session.authorizationHeader ?? inputAuth;
				if (!auth) {
					throw new McpError(
						ErrorCode.InvalidParams,
						"authorization is required when the MCP connection is not authenticated with a root key",
					);
				}
				const data = await injectOrThrow<ApiKeyCreateResponse>(fastify, {
					method: "POST",
					url: `/orgs/${org_id}/api-keys`,
					headers: { authorization: auth, "content-type": "application/json" },
					payload: JSON.stringify({}),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Service key created: id=${data.apiKey.id}. Key stored in structuredContent only.`,
						},
					],
					structuredContent: {
						key_id: data.apiKey.id,
						service_key: data.apiKey.key,
					},
				};
			},
		);
	}
}
