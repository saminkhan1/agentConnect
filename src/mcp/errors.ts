import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";

export function extractMessage(body: unknown): string {
	if (typeof body === "object" && body !== null) {
		const msg = (body as Record<string, unknown>).message;
		if (typeof msg === "string") return msg;
	}
	return "Unknown error";
}

export function mapRestError(status: number, message: string): McpError {
	if (status === 400) return new McpError(ErrorCode.InvalidParams, message);
	if (status === 422) {
		return new McpError(
			ErrorCode.InvalidParams,
			`UNPROCESSABLE_ENTITY: ${message}`,
		);
	}
	if (status === 401)
		return new McpError(
			ErrorCode.InvalidRequest,
			`UNAUTHENTICATED: ${message}`,
		);
	if (status === 403)
		return new McpError(ErrorCode.InvalidRequest, `FORBIDDEN: ${message}`);
	if (status === 404)
		return new McpError(ErrorCode.InvalidRequest, `NOT_FOUND: ${message}`);
	if (status === 409)
		return new McpError(ErrorCode.InvalidRequest, `CONFLICT: ${message}`);
	if (status === 429)
		return new McpError(ErrorCode.InternalError, `RATE_LIMITED: ${message}`);
	if (status === 503)
		return new McpError(ErrorCode.InternalError, `UNAVAILABLE: ${message}`);
	return new McpError(ErrorCode.InternalError, `INTERNAL: ${message}`);
}

export function buildQueryString(
	fields: Record<string, string | number | undefined>,
) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) params.set(key, String(value));
	}
	return params.size > 0 ? `?${params.toString()}` : "";
}

export function textResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

type InjectOptions = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	url: string;
	headers?: Record<string, string>;
	payload?: string;
};

export async function injectWithStatusOrThrow(
	fastify: FastifyInstance,
	opts: InjectOptions,
): Promise<{ statusCode: number; data: unknown }> {
	const res = await fastify.inject(opts);
	const data = res.json<unknown>();
	if (res.statusCode >= 400) {
		throw mapRestError(res.statusCode, extractMessage(data));
	}

	return { statusCode: res.statusCode, data };
}

/**
 * Inject a request into Fastify, throw an McpError on 4xx/5xx, and return the parsed JSON body.
 */
export async function injectOrThrow<T = unknown>(
	fastify: FastifyInstance,
	opts: InjectOptions,
): Promise<T> {
	const { data } = await injectWithStatusOrThrow(fastify, opts);
	return data as T;
}
