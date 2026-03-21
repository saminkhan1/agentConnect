import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";

import type { McpSessionContext } from "../server.js";
import { registerAgentTools } from "./agents.js";
import { registerBootstrapTools } from "./bootstrap.js";
import { registerEmailTools } from "./email.js";
import { registerEventTools } from "./events.js";
import { registerPaymentTools } from "./payments.js";
import { registerResourceTools } from "./resources.js";

export function registerTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	// Bootstrap tools are always available (no auth required — they are used to bootstrap auth)
	registerBootstrapTools(server, fastify, session);

	if (session.authorizationHeader || session.allowToolAuthorizationFallback) {
		registerAgentTools(server, fastify, session);
		registerResourceTools(server, fastify, session);
		registerEmailTools(server, fastify, session);
		if (fastify.stripeAdapter) {
			registerPaymentTools(server, fastify, session);
		}
		registerEventTools(server, fastify, session);
	}
}
