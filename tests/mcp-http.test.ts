import assert from "node:assert";
import test from "node:test";

import { buildServer } from "../src/api/server";
import { getServerConfig } from "../src/config";
import { installAuthApiKey } from "./helpers";

function setEnv(overrides: Record<string, string | undefined>) {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) {
			Reflect.deleteProperty(process.env, key);
		} else {
			process.env[key] = value;
		}
	}

	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
	};
}

async function listMcpTools(
	server: Awaited<ReturnType<typeof buildServer>>,
	headers?: Record<string, string>,
) {
	const response = await server.inject({
		method: "POST",
		url: "/mcp",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			...headers,
		},
		payload: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {},
		},
	});

	return {
		response,
		toolNames: extractToolNames(response.payload),
	};
}

function extractToolNames(payload: string) {
	const message = extractJsonRpcMessage(payload);
	const tools =
		typeof message === "object" && message !== null
			? ((message as { result?: { tools?: Array<{ name?: unknown }> } }).result
					?.tools ?? [])
			: [];

	return tools.flatMap((tool) =>
		typeof tool.name === "string" ? [tool.name] : [],
	);
}

function extractJsonRpcMessage(payload: string) {
	const trimmed = payload.trim();
	if (trimmed.startsWith("{")) {
		return JSON.parse(trimmed) as unknown;
	}

	const dataBlocks = payload.split("\n\n").flatMap((block) => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n");
		return data.length > 0 ? [data] : [];
	});

	if (dataBlocks.length === 0) {
		throw new Error(`No JSON-RPC payload found: ${payload}`);
	}

	return JSON.parse(dataBlocks[dataBlocks.length - 1]) as unknown;
}

void test("getServerConfig parses MCP_HTTP_ENABLED string flags explicitly", () => {
	assert.strictEqual(
		getServerConfig({ MCP_HTTP_ENABLED: "false" } as NodeJS.ProcessEnv)
			.MCP_HTTP_ENABLED,
		false,
	);
	assert.strictEqual(
		getServerConfig({ MCP_HTTP_ENABLED: "0" } as NodeJS.ProcessEnv)
			.MCP_HTTP_ENABLED,
		false,
	);
	assert.strictEqual(
		getServerConfig({ MCP_HTTP_ENABLED: "true" } as NodeJS.ProcessEnv)
			.MCP_HTTP_ENABLED,
		true,
	);
});

void test("OPTIONS /mcp returns CORS preflight headers for allowed origins", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({
		MCP_HTTP_ENABLED: "true",
		MCP_ALLOWED_ORIGINS: "https://app.example.com",
	});
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "OPTIONS",
			url: "/mcp",
			headers: {
				origin: "https://app.example.com",
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization,content-type",
			},
		});

		assert.strictEqual(response.statusCode, 204);
		assert.strictEqual(
			response.headers["access-control-allow-origin"],
			"https://app.example.com",
		);
		assert.strictEqual(
			response.headers["access-control-allow-methods"],
			"GET, POST, DELETE, OPTIONS",
		);
		assert.strictEqual(
			response.headers["access-control-allow-headers"],
			"authorization,content-type",
		);
		assert.ok((response.headers.vary ?? "").includes("Origin"));
	} finally {
		restoreEnv();
		await server.close();
	}
});

void test("/mcp returns 405 with explicit method handling for unsupported HTTP methods", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ MCP_HTTP_ENABLED: "true" });

	try {
		for (const method of ["GET", "DELETE"] as const) {
			const server = await buildServer();

			try {
				const response = await server.inject({
					method,
					url: "/mcp",
				});

				assert.strictEqual(response.statusCode, 405, method);
				assert.strictEqual(response.headers.allow, "POST, OPTIONS", method);
				assert.deepStrictEqual(
					response.json(),
					{ message: "Method Not Allowed" },
					method,
				);
			} finally {
				await server.close();
			}
		}
	} finally {
		restoreEnv();
	}
});

void test("POST /mcp includes CORS headers for allowed origins", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({
		MCP_HTTP_ENABLED: "true",
		MCP_ALLOWED_ORIGINS: "https://app.example.com",
	});
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/mcp",
			headers: {
				origin: "https://app.example.com",
				"content-type": "application/json",
			},
			payload: {},
		});

		assert.notStrictEqual(response.statusCode, 403);
		assert.strictEqual(
			response.headers["access-control-allow-origin"],
			"https://app.example.com",
		);
		assert.ok((response.headers.vary ?? "").includes("Origin"));
	} finally {
		restoreEnv();
		await server.close();
	}
});

void test("POST /mcp tools/list returns bootstrap tools when unauthenticated", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ MCP_HTTP_ENABLED: "true" });
	const server = await buildServer();

	try {
		const { response, toolNames } = await listMcpTools(server);
		assert.strictEqual(response.statusCode, 200);
		assert.ok(toolNames.includes("agentinfra.orgs.create"));
		assert.ok(toolNames.includes("agentinfra.api_keys.create_service"));
		assert.ok(!toolNames.includes("agentinfra.agents.create"));
		assert.ok(!toolNames.includes("agentinfra.email.send"));
	} finally {
		restoreEnv();
		await server.close();
	}
});

void test("POST /mcp tools/list hides root-only bootstrap tools for service keys", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ MCP_HTTP_ENABLED: "true" });
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});

	try {
		const { response, toolNames } = await listMcpTools(server, {
			authorization: authorizationHeader,
		});
		assert.strictEqual(response.statusCode, 200);
		assert.ok(toolNames.includes("agentinfra.orgs.create"));
		assert.ok(toolNames.includes("agentinfra.agents.create"));
		assert.ok(toolNames.includes("agentinfra.email.get_message"));
		assert.ok(!toolNames.includes("agentinfra.api_keys.create_service"));
	} finally {
		restore();
		restoreEnv();
		await server.close();
	}
});

void test("POST /mcp tools/list includes root-only bootstrap tools for root keys", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ MCP_HTTP_ENABLED: "true" });
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "root",
	});

	try {
		const { response, toolNames } = await listMcpTools(server, {
			authorization: authorizationHeader,
		});
		assert.strictEqual(response.statusCode, 200);
		assert.ok(toolNames.includes("agentinfra.api_keys.create_service"));
		assert.ok(toolNames.includes("agentinfra.agents.create"));
		assert.ok(toolNames.includes("agentinfra.timeline.list"));
	} finally {
		restore();
		restoreEnv();
		await server.close();
	}
});

void test("POST /mcp rejects malformed authorization headers before tool registration", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ MCP_HTTP_ENABLED: "true" });
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/mcp",
			headers: {
				authorization: "Bearer invalid",
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			payload: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			},
		});

		assert.strictEqual(response.statusCode, 401);
		assert.deepStrictEqual(response.json(), { message: "Unauthorized" });
	} finally {
		restoreEnv();
		await server.close();
	}
});

void test("POST /mcp preserves CORS headers on auth failures for allowed origins", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({
		MCP_HTTP_ENABLED: "true",
		MCP_ALLOWED_ORIGINS: "https://app.example.com",
	});
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/mcp",
			headers: {
				origin: "https://app.example.com",
				authorization: "Bearer invalid",
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			payload: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			},
		});

		assert.strictEqual(response.statusCode, 401);
		assert.strictEqual(
			response.headers["access-control-allow-origin"],
			"https://app.example.com",
		);
		assert.deepStrictEqual(response.json(), { message: "Unauthorized" });
	} finally {
		restoreEnv();
		await server.close();
	}
});
