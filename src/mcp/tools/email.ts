import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { injectOrThrow, textResult } from "../errors.js";
import type { McpSessionContext } from "../server.js";
import {
	resolveToolAuthorization,
	withOptionalAuthorizationSchema,
} from "./auth.js";

export function registerEmailTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	const replyToSchema = z.union([z.email(), z.array(z.email()).min(1)]);

	server.registerTool(
		"agentinfra.email.send",
		{
			description:
				"Send an email from an agent's provisioned inbox. The agent must have an active email_inbox resource.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				to: z.array(z.email()).min(1).describe("Recipient email addresses"),
				subject: z.string().min(1).describe("Email subject"),
				text: z.string().describe("Plain text body"),
				html: z.string().optional().describe("HTML body"),
				cc: z.array(z.email()).optional().describe("CC recipients"),
				bcc: z.array(z.email()).optional().describe("BCC recipients"),
				reply_to: replyToSchema
					.optional()
					.describe("Reply-to address or addresses"),
				idempotency_key: z
					.string()
					.min(1)
					.describe("Required idempotency key for safe retries"),
			}),
		},
		async ({
			agent_id,
			to,
			subject,
			text,
			html,
			cc,
			bcc,
			reply_to,
			idempotency_key,
			authorization,
		}) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const body: Record<string, unknown> = {
				to,
				subject,
				text,
				idempotency_key,
			};
			if (html !== undefined) body.html = html;
			if (cc !== undefined) body.cc = cc;
			if (bcc !== undefined) body.bcc = bcc;
			if (reply_to !== undefined) body.reply_to = reply_to;

			const data = await injectOrThrow(fastify, {
				method: "POST",
				url: `/agents/${agent_id}/actions/send_email`,
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
		"agentinfra.email.reply",
		{
			description:
				"Reply to a received email, preserving the original thread. Use the message_id from an email.received event.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				message_id: z.string().min(1).describe("ID of the message to reply to"),
				text: z.string().describe("Plain text reply body"),
				html: z.string().optional().describe("HTML reply body"),
				cc: z.array(z.email()).optional().describe("CC recipients"),
				bcc: z.array(z.email()).optional().describe("BCC recipients"),
				reply_to: replyToSchema
					.optional()
					.describe("Reply-to address or addresses"),
				idempotency_key: z
					.string()
					.min(1)
					.describe("Required idempotency key for safe retries"),
			}),
		},
		async ({
			agent_id,
			message_id,
			text,
			html,
			cc,
			bcc,
			reply_to,
			idempotency_key,
			authorization,
		}) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const body: Record<string, unknown> = {
				message_id,
				text,
				idempotency_key,
			};
			if (html !== undefined) body.html = html;
			if (cc !== undefined) body.cc = cc;
			if (bcc !== undefined) body.bcc = bcc;
			if (reply_to !== undefined) body.reply_to = reply_to;

			const data = await injectOrThrow(fastify, {
				method: "POST",
				url: `/agents/${agent_id}/actions/reply_email`,
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
		"agentinfra.email.get_message",
		{
			description:
				"Retrieve the full content of an email message, including subject, body, headers, and attachments.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				message_id: z.string().min(1).describe("Message ID"),
			}),
		},
		async ({ agent_id, message_id, authorization }) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const data = await injectOrThrow(fastify, {
				method: "GET",
				url: `/agents/${agent_id}/messages/${message_id}`,
				headers: { authorization: authHeader },
			});
			return textResult(data);
		},
	);
}
