import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
import {
	buildCardResourceRecord,
	buildEventRecord,
	FIXED_TIMESTAMP,
	installAgentMailAdapterMock,
	installEventWriterMock,
	installResourceManagerMock,
	installStripeAdapterMock,
} from "./helpers";

type AppServer = Awaited<ReturnType<typeof buildServer>>;
type ToolTextResult = {
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

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

function normalizeHermesToolName(serverName: string, toolName: string) {
	const normalize = (value: string) =>
		value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return `mcp_${normalize(serverName)}_${normalize(toolName)}`;
}

function getHttpPort(server: AppServer) {
	const address = server.server.address();
	assert.ok(
		address && typeof address !== "string",
		"expected a TCP server address",
	);
	return address.port;
}

function requireServer(server: AppServer | null): AppServer {
	assert.ok(server, "expected MCP test server to be available");
	return server;
}

void test("integration: Hermes-style HTTP MCP bootstrap, scoped discovery, tool dispatch, and reconnect recovery", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({
		NODE_ENV: "test",
		MCP_HTTP_ENABLED: "true",
	});

	let orgId: string | null = null;
	let server: AppServer | null = null;
	let anonTransport: StreamableHTTPClientTransport | null = null;
	let rootTransport: StreamableHTTPClientTransport | null = null;
	let serviceTransport: StreamableHTTPClientTransport | null = null;

	try {
		server = await buildServer();
		await server.listen({ port: 0, host: "127.0.0.1" });
		const port = getHttpPort(requireServer(server));
		const mcpUrl = new URL(`http://127.0.0.1:${String(port)}/mcp`);

		const adapterCalls: Array<{
			action: string;
			payload: Record<string, unknown>;
		}> = [];
		installAgentMailAdapterMock(requireServer(server), {
			performAction: (_resource, action, payload) => {
				adapterCalls.push({ action, payload });

				if (action === "send_email") {
					return Promise.resolve({
						message_id: "msg_hermes_send",
						thread_id: "thread_hermes",
					});
				}

				if (action === "reply_email") {
					return Promise.resolve({
						message_id: "msg_hermes_reply",
						thread_id: "thread_hermes",
					});
				}

				if (action === "get_message") {
					return Promise.resolve({
						message_id: payload.message_id,
						thread_id: "thread_hermes",
						from: "customer@example.com",
						reply_to: ["customer@example.com"],
						to: ["agent.hermes@example.com"],
						subject: "Original thread",
					});
				}

				throw new Error(`Unexpected AgentMail action: ${action}`);
			},
		});

		const anonymousClient = new Client({
			name: "hermes-anon",
			version: "0.0.0",
		});
		anonTransport = new StreamableHTTPClientTransport(mcpUrl);
		await anonymousClient.connect(anonTransport);

		const anonymousTools = await anonymousClient.listTools();
		const anonymousToolNames = anonymousTools.tools.map((tool) => tool.name);
		assert.deepStrictEqual(anonymousToolNames.sort(), [
			"agentinfra.api_keys.create_service",
			"agentinfra.orgs.create",
		]);

		const orgCreateResult = (await anonymousClient.callTool({
			name: "agentinfra.orgs.create",
			arguments: { name: "Hermes MCP Integration Org" },
		})) as ToolTextResult;
		const orgBootstrap = orgCreateResult.structuredContent as {
			org_id: string;
			root_key: string;
		};
		orgId = orgBootstrap.org_id;

		const serviceKeyResult = (await anonymousClient.callTool({
			name: "agentinfra.api_keys.create_service",
			arguments: {
				org_id: orgBootstrap.org_id,
				authorization: `Bearer ${orgBootstrap.root_key}`,
			},
		})) as ToolTextResult;
		const serviceBootstrap = serviceKeyResult.structuredContent as {
			service_key: string;
		};

		const rootClient = new Client({ name: "hermes-root", version: "0.0.0" });
		rootTransport = new StreamableHTTPClientTransport(mcpUrl, {
			requestInit: {
				headers: {
					Authorization: `Bearer ${orgBootstrap.root_key}`,
				},
			},
		});
		await rootClient.connect(rootTransport);

		const rootTools = await rootClient.listTools();
		const rootToolNames = rootTools.tools.map((tool) => tool.name);
		assert.ok(rootToolNames.includes("agentinfra.api_keys.create_service"));
		assert.ok(
			rootToolNames.includes("agentinfra.payments.create_card_details_session"),
		);
		assert.strictEqual(
			new Set(
				rootToolNames.map((toolName) =>
					normalizeHermesToolName("agentconnect", toolName),
				),
			).size,
			rootToolNames.length,
		);
		assert.ok(
			rootToolNames
				.map((toolName) => normalizeHermesToolName("agentconnect", toolName))
				.includes("mcp_agentconnect_agentinfra_agents_create"),
		);

		const serviceClient = new Client({
			name: "hermes-service",
			version: "0.0.0",
		});
		serviceTransport = new StreamableHTTPClientTransport(mcpUrl, {
			requestInit: {
				headers: {
					Authorization: `Bearer ${serviceBootstrap.service_key}`,
				},
			},
		});
		await serviceClient.connect(serviceTransport);
		assert.strictEqual(serviceClient.getServerVersion()?.name, "agentinfra");

		const serviceTools = await serviceClient.listTools();
		const serviceToolNames = serviceTools.tools.map((tool) => tool.name);
		assert.ok(serviceToolNames.includes("agentinfra.agents.create"));
		assert.ok(serviceToolNames.includes("agentinfra.email.send"));
		assert.ok(serviceToolNames.includes("agentinfra.payments.issue_card"));
		assert.ok(!serviceToolNames.includes("agentinfra.api_keys.create_service"));
		assert.ok(
			!serviceToolNames.includes(
				"agentinfra.payments.create_card_details_session",
			),
		);

		const createAgentResult = (await serviceClient.callTool({
			name: "agentinfra.agents.create",
			arguments: { name: "Hermes Agent" },
		})) as ToolTextResult;
		const createdAgent = parseJsonToolText(createAgentResult) as {
			agent: { id: string; orgId: string; name: string };
		};
		assert.strictEqual(createdAgent.agent.orgId, orgBootstrap.org_id);
		assert.strictEqual(createdAgent.agent.name, "Hermes Agent");

		const createMockResourceResult = (await serviceClient.callTool({
			name: "agentinfra.resources.create",
			arguments: {
				agent_id: createdAgent.agent.id,
				type: "email_inbox",
				provider: "mock",
				config: {},
			},
		})) as ToolTextResult;
		const createdMockResource = parseJsonToolText(createMockResourceResult) as {
			resource: { id: string; provider: string; state: string };
		};
		assert.strictEqual(createdMockResource.resource.provider, "mock");
		assert.strictEqual(createdMockResource.resource.state, "active");

		await db.insert(resources).values({
			id: `res_${crypto.randomUUID()}`,
			orgId: orgBootstrap.org_id,
			agentId: createdAgent.agent.id,
			type: "email_inbox",
			provider: "agentmail",
			providerRef: "agent.hermes@example.com",
			providerOrgId: "pod_test",
			config: { email_address: "agent.hermes@example.com" },
			state: "active",
			createdAt: FIXED_TIMESTAMP,
			updatedAt: FIXED_TIMESTAMP,
		});

		const sendEmailResult = (await serviceClient.callTool({
			name: "agentinfra.email.send",
			arguments: {
				agent_id: createdAgent.agent.id,
				to: ["customer@example.com"],
				subject: "Hermes hello",
				text: "Hello from MCP",
				idempotency_key: `idem_send_${crypto.randomUUID()}`,
			},
		})) as ToolTextResult;
		const sentEmail = parseJsonToolText(sendEmailResult) as {
			event: { eventType: string; data: { thread_id: string } };
		};
		assert.strictEqual(sentEmail.event.eventType, "email.sent");
		assert.strictEqual(sentEmail.event.data.thread_id, "thread_hermes");

		const replyEmailResult = (await serviceClient.callTool({
			name: "agentinfra.email.reply",
			arguments: {
				agent_id: createdAgent.agent.id,
				message_id: "msg_original",
				text: "Reply from MCP",
				idempotency_key: `idem_reply_${crypto.randomUUID()}`,
			},
		})) as ToolTextResult;
		const repliedEmail = parseJsonToolText(replyEmailResult) as {
			event: { eventType: string; data: { thread_id: string } };
		};
		assert.strictEqual(repliedEmail.event.eventType, "email.sent");
		assert.strictEqual(repliedEmail.event.data.thread_id, "thread_hermes");

		assert.deepStrictEqual(
			adapterCalls.map((call) => call.action),
			["send_email", "get_message", "reply_email"],
		);

		const eventsResult = (await serviceClient.callTool({
			name: "agentinfra.events.list",
			arguments: {
				agent_id: createdAgent.agent.id,
				limit: 10,
			},
		})) as ToolTextResult;
		const listedEvents = parseJsonToolText(eventsResult) as {
			events: Array<{ eventType: string; data: { thread_id?: string } }>;
			nextCursor: string | null;
		};
		assert.ok(listedEvents.events.length >= 2);
		assert.ok(
			listedEvents.events.every((event) => event.eventType === "email.sent"),
		);
		assert.ok(
			listedEvents.events.some(
				(event) => event.data.thread_id === "thread_hermes",
			),
			"expected the emitted email events to retain thread IDs",
		);
		assert.strictEqual(listedEvents.nextCursor, null);

		const timelineResult = (await serviceClient.callTool({
			name: "agentinfra.timeline.list",
			arguments: {
				agent_id: createdAgent.agent.id,
				limit: 10,
			},
		})) as ToolTextResult;
		const timeline = parseJsonToolText(timelineResult) as {
			items: Array<{
				kind: string;
				eventCount: number;
				summary: { threadId?: string };
			}>;
			nextCursor: string | null;
		};
		assert.ok(
			timeline.items.some(
				(item) =>
					item.kind === "email_thread" &&
					item.summary.threadId === "thread_hermes" &&
					item.eventCount >= 2,
			),
		);
		assert.strictEqual(timeline.nextCursor, null);

		const missingAgentResult = (await serviceClient.callTool({
			name: "agentinfra.agents.get",
			arguments: { agent_id: "agt_missing" },
		})) as ToolTextResult;
		assert.strictEqual(missingAgentResult.isError, true);
		assert.match(
			missingAgentResult.content[0].text,
			/NOT_FOUND: Agent not found/,
		);

		const restoreResourceManager = installResourceManagerMock(
			requireServer(server),
			{
				provision: () => {
					return Promise.resolve({
						resource: buildCardResourceRecord({
							id: `res_card_${crypto.randomUUID()}`,
							orgId: orgBootstrap.org_id,
							agentId: createdAgent.agent.id,
							config: {
								cardholder_id: "ich_test",
								last4: "4242",
								exp_month: 12,
								exp_year: 2027,
								currency: "usd",
							},
						}),
					});
				},
			},
		);
		const restoreStripe = installStripeAdapterMock(requireServer(server), {});
		const restoreEventWriter = installEventWriterMock(requireServer(server), {
			writeEvent: () => {
				const fakeCardResource = buildCardResourceRecord({
					id: "res_card_hermes",
					orgId: orgBootstrap.org_id,
					agentId: createdAgent.agent.id,
					config: {
						cardholder_id: "ich_test",
						last4: "4242",
						exp_month: 12,
						exp_year: 2027,
						currency: "usd",
					},
				});
				return Promise.resolve({
					wasCreated: true,
					event: buildEventRecord({
						orgId: orgBootstrap.org_id,
						agentId: createdAgent.agent.id,
						resourceId: fakeCardResource.id,
						provider: "stripe",
						eventType: "payment.card.issued",
						data: {
							card_id: fakeCardResource.providerRef ?? fakeCardResource.id,
						},
					}),
				});
			},
		});

		try {
			const issueCardResult = (await serviceClient.callTool({
				name: "agentinfra.payments.issue_card",
				arguments: {
					agent_id: createdAgent.agent.id,
					cardholder_name: "Hermes Agent",
					billing_address: {
						line1: "123 Main St",
						city: "New York",
						postal_code: "10001",
						country: "US",
					},
					currency: "usd",
				},
			})) as ToolTextResult;
			const cardContent = issueCardResult.structuredContent as {
				card: { last4: string; currency: string };
			};
			assert.strictEqual(cardContent.card.last4, "4242");
			assert.strictEqual(cardContent.card.currency, "usd");
		} finally {
			restoreEventWriter();
			restoreStripe();
			restoreResourceManager();
		}

		await anonTransport.close();
		anonTransport = null;
		await rootTransport.close();
		rootTransport = null;
		await serviceTransport.close();
		serviceTransport = null;

		const reconnectedClient = new Client({
			name: "hermes-service-reconnected",
			version: "0.0.0",
		});
		serviceTransport = new StreamableHTTPClientTransport(mcpUrl, {
			requestInit: {
				headers: {
					Authorization: `Bearer ${serviceBootstrap.service_key}`,
				},
			},
		});
		await reconnectedClient.connect(serviceTransport);

		const afterRestartResult = (await reconnectedClient.callTool({
			name: "agentinfra.agents.list",
			arguments: {},
		})) as ToolTextResult;
		const afterRestart = parseJsonToolText(afterRestartResult) as {
			agents: Array<{ id: string }>;
		};
		assert.ok(
			afterRestart.agents.some((agent) => agent.id === createdAgent.agent.id),
		);
	} finally {
		await anonTransport?.close().catch(() => {});
		await rootTransport?.close().catch(() => {});
		await serviceTransport?.close().catch(() => {});
		if (orgId) {
			await cleanupOrg(orgId);
		}
		await server?.close().catch(() => {});
		restoreEnv();
	}
});
