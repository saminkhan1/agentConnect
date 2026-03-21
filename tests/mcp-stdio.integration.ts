import assert from "node:assert";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";

import { buildServer } from "../src/api/server";
import { db } from "../src/db";
import {
	agents,
	apiKeys,
	events,
	orgs,
	outboundActions,
	resources,
} from "../src/db/schema";

type ToolTextResult = {
	content: Array<{ type: string; text: string }>;
};

async function cleanupOrg(orgId: string): Promise<void> {
	await db.delete(outboundActions).where(eq(outboundActions.orgId, orgId));
	await db.delete(events).where(eq(events.orgId, orgId));
	await db.delete(resources).where(eq(resources.orgId, orgId));
	await db.delete(agents).where(eq(agents.orgId, orgId));
	await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
	await db.delete(orgs).where(eq(orgs.id, orgId));
}

function parseJsonToolText(result: ToolTextResult): unknown {
	assert.ok(result.content.length > 0, "expected tool result content");
	return JSON.parse(result.content[0].text) as unknown;
}

void test("integration: stdio MCP entrypoint authenticates with AGENTINFRA_API_KEY and dispatches tools", {
	concurrency: false,
}, async () => {
	const server = await buildServer();
	let orgId: string | null = null;
	let transport: StdioClientTransport | null = null;

	try {
		const createOrgResponse = await server.inject({
			method: "POST",
			url: "/orgs",
			payload: { name: "Stdio MCP Integration Org" },
		});
		assert.strictEqual(createOrgResponse.statusCode, 201);

		const createOrgPayload = createOrgResponse.json<{
			org: { id: string };
			apiKey: { key: string };
		}>();
		orgId = createOrgPayload.org.id;

		transport = new StdioClientTransport({
			command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
			args: ["exec", "tsx", "src/mcp-stdio.ts"],
			cwd: process.cwd(),
			env: {
				NODE_ENV: "test",
				AGENTINFRA_API_KEY: createOrgPayload.apiKey.key,
				...(process.env.DATABASE_URL
					? { DATABASE_URL: process.env.DATABASE_URL }
					: {}),
			},
			stderr: "pipe",
		});

		const client = new Client({
			name: "stdio-integration-client",
			version: "0.0.0",
		});
		await client.connect(transport);

		const tools = await client.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);
		assert.ok(toolNames.includes("agentinfra.agents.create"));
		assert.ok(
			toolNames.includes("agentinfra.payments.create_card_details_session"),
		);

		const createAgentResult = (await client.callTool({
			name: "agentinfra.agents.create",
			arguments: { name: "Stdio Agent" },
		})) as ToolTextResult;
		const createdAgent = parseJsonToolText(createAgentResult) as {
			agent: { id: string; name: string };
		};
		assert.strictEqual(createdAgent.agent.name, "Stdio Agent");

		const listAgentsResult = (await client.callTool({
			name: "agentinfra.agents.list",
			arguments: {},
		})) as ToolTextResult;
		const listedAgents = parseJsonToolText(listAgentsResult) as {
			agents: Array<{ id: string }>;
		};
		assert.ok(
			listedAgents.agents.some((agent) => agent.id === createdAgent.agent.id),
		);
	} finally {
		await transport?.close().catch(() => {});
		if (orgId) {
			await cleanupOrg(orgId);
		}
		await server.close();
	}
});
