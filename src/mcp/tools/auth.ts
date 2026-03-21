import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { McpSessionContext } from "../server.js";

export const toolAuthorizationSchema = z
	.string()
	.optional()
	.describe(
		"Bearer API key (Bearer sk_...). Required when the MCP connection is not already authenticated.",
	);

export function withOptionalAuthorizationSchema<
	T extends Record<string, z.ZodType>,
>(
	_session: McpSessionContext,
	schema: T,
): T & { authorization: typeof toolAuthorizationSchema } {
	return {
		...schema,
		authorization: toolAuthorizationSchema,
	};
}

export function resolveToolAuthorization(
	session: McpSessionContext,
	inputAuthorization?: string,
) {
	const auth = session.authorizationHeader ?? inputAuthorization;
	if (!auth) {
		throw new McpError(
			ErrorCode.InvalidParams,
			"authorization is required when the MCP connection is not already authenticated",
		);
	}

	return auth;
}
