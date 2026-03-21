import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AgentMailError } from "agentmail";
import { STRIPE_API_VERSION } from "../src/adapters/stripe-adapter";
import { buildServer } from "../src/api/server";
import type { WriteEventResult } from "../src/domain/event-writer";
import { mapRestError } from "../src/mcp/errors";
import { buildMcpServer, readPackageVersion } from "../src/mcp/server";
import { resolveAuthContext } from "../src/plugins/auth";
import {
	buildAgentRecord,
	buildCardResourceRecord,
	buildResourceRecord,
	FIXED_TIMESTAMP,
	installAgentMailAdapterMock,
	installAgentsDalMock,
	installAuthApiKey,
	installEventsDalMock,
	installEventWriterMock,
	installResourcesDalMock,
} from "./helpers";

async function buildAuthenticatedMcpSession(
	server: Awaited<ReturnType<typeof buildServer>>,
	options?: { keyType?: "root" | "service" },
) {
	const { authorizationHeader, restore } = await installAuthApiKey(
		server,
		options,
	);
	const auth = await resolveAuthContext(server.systemDal, authorizationHeader);
	assert.ok(auth, "expected auth context to resolve");
	return {
		session: {
			auth,
			authorizationHeader,
		},
		authorizationHeader,
		restore,
	};
}

// ---------------------------------------------------------------------------
// mapRestError tests
// ---------------------------------------------------------------------------

void test("mapRestError maps REST statuses to MCP error codes and prefixes", () => {
	const cases = [
		{
			status: 400,
			message: "bad input",
			code: ErrorCode.InvalidParams,
			prefix: "bad input",
		},
		{
			status: 401,
			message: "no key",
			code: ErrorCode.InvalidRequest,
			prefix: "UNAUTHENTICATED:",
		},
		{
			status: 403,
			message: "denied",
			code: ErrorCode.InvalidRequest,
			prefix: "FORBIDDEN:",
		},
		{
			status: 404,
			message: "gone",
			code: ErrorCode.InvalidRequest,
			prefix: "NOT_FOUND:",
		},
		{
			status: 409,
			message: "duplicate",
			code: ErrorCode.InvalidRequest,
			prefix: "CONFLICT:",
		},
		{
			status: 422,
			message: "rejected",
			code: ErrorCode.InvalidParams,
			prefix: "UNPROCESSABLE_ENTITY:",
		},
		{
			status: 429,
			message: "slow down",
			code: ErrorCode.InternalError,
			prefix: "RATE_LIMITED:",
		},
		{
			status: 500,
			message: "oops",
			code: ErrorCode.InternalError,
			prefix: "INTERNAL:",
		},
		{
			status: 503,
			message: "down",
			code: ErrorCode.InternalError,
			prefix: "UNAVAILABLE:",
		},
	] as const;

	for (const testCase of cases) {
		const err = mapRestError(testCase.status, testCase.message);
		assert.strictEqual(err.code, testCase.code, String(testCase.status));
		assert.ok(err.message.includes(testCase.prefix), String(testCase.status));
		assert.ok(err.message.includes(testCase.message), String(testCase.status));
	}
});

// ---------------------------------------------------------------------------
// Tool registry tests
// ---------------------------------------------------------------------------

void test("readPackageVersion walks up from a compiled-like directory", () => {
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "agentconnect-version-"),
	);
	const nestedDir = path.join(tempRoot, "dist", "src", "mcp");
	fs.mkdirSync(nestedDir, { recursive: true });
	fs.writeFileSync(
		path.join(tempRoot, "package.json"),
		JSON.stringify({ name: "agentconnect-test", version: "9.9.9" }),
	);

	try {
		assert.strictEqual(readPackageVersion(nestedDir), "9.9.9");
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

void test("buildMcpServer without auth registers only bootstrap tools", async () => {
	const server = await buildServer();
	try {
		const mcp = buildMcpServer(server, {
			auth: null,
			authorizationHeader: null,
		});
		const tools = Object.keys(
			(mcp as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);
		assert.ok(
			tools.includes("agentinfra.orgs.create"),
			"orgs.create should be registered",
		);
		assert.ok(
			tools.includes("agentinfra.api_keys.create_service"),
			"api_keys.create_service should be registered",
		);
		// Agent tools should NOT be registered without auth
		assert.ok(
			!tools.includes("agentinfra.agents.create"),
			"agents.create should NOT be registered",
		);
		assert.ok(
			!tools.includes("agentinfra.email.send"),
			"email.send should NOT be registered",
		);
		assert.ok(
			!tools.includes("agentinfra.payments.issue_card"),
			"payments.issue_card should NOT be registered",
		);
	} finally {
		await server.close();
	}
});

void test("buildMcpServer with stdio auth fallback registers agent tools and honors per-call authorization", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});

	try {
		const mcp = buildMcpServer(server, {
			auth: null,
			authorizationHeader: null,
			allowToolAuthorizationFallback: true,
		});
		const registeredTools = (
			mcp as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (...args: unknown[]) => Promise<unknown> }
				>;
			}
		)._registeredTools;
		assert.ok(
			registeredTools["agentinfra.agents.get"],
			"agents.get should be registered",
		);

		const result = (await registeredTools["agentinfra.agents.get"].handler(
			{ agent_id: "agt_123", authorization: authorizationHeader },
			{} as never,
		)) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0].text) as {
			agent: { id: string };
		};

		assert.strictEqual(parsed.agent.id, "agt_123");
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});

void test("buildMcpServer with root auth registers all tools", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "root",
	});

	// Mock stripeAdapter as present so payment tools are registered
	const originalAdapter = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, session);
		const tools = Object.keys(
			(mcp as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		const expectedTools = [
			"agentinfra.orgs.create",
			"agentinfra.api_keys.create_service",
			"agentinfra.agents.create",
			"agentinfra.agents.list",
			"agentinfra.agents.get",
			"agentinfra.agents.update",
			"agentinfra.agents.archive",
			"agentinfra.resources.create",
			"agentinfra.resources.list",
			"agentinfra.resources.delete",
			"agentinfra.email.send",
			"agentinfra.email.reply",
			"agentinfra.email.get_message",
			"agentinfra.payments.issue_card",
			"agentinfra.payments.create_card_details_session",
			"agentinfra.events.list",
			"agentinfra.timeline.list",
		];

		for (const name of expectedTools) {
			assert.ok(tools.includes(name), `Tool ${name} should be registered`);
		}

		assert.strictEqual(
			tools.length,
			expectedTools.length,
			"Exactly 17 tools should be registered",
		);
	} finally {
		server.stripeAdapter = originalAdapter;
		restore();
		await server.close();
	}
});

void test("buildMcpServer with service auth hides root-only bootstrap tools", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "service",
	});

	// Mock stripeAdapter as present so payment tools are registered
	const originalAdapter = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, session);
		const tools = Object.keys(
			(mcp as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		assert.ok(tools.includes("agentinfra.orgs.create"));
		assert.ok(tools.includes("agentinfra.agents.create"));
		assert.ok(tools.includes("agentinfra.email.get_message"));
		assert.ok(!tools.includes("agentinfra.api_keys.create_service"));
		assert.strictEqual(tools.length, 15);
	} finally {
		server.stripeAdapter = originalAdapter;
		restore();
		await server.close();
	}
});

void test("buildMcpServer with service auth plus stdio fallback hides root-only payment tools", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "service",
	});

	// Mock stripeAdapter as present so payment tools are registered
	const originalAdapter = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, {
			...session,
			allowToolAuthorizationFallback: true,
		});
		const tools = Object.keys(
			(mcp as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		assert.ok(tools.includes("agentinfra.payments.issue_card"));
		assert.ok(
			!tools.includes("agentinfra.payments.create_card_details_session"),
		);
	} finally {
		server.stripeAdapter = originalAdapter;
		restore();
		await server.close();
	}
});

void test("buildMcpServer omits payment tools when Stripe adapter is not configured", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "root",
	});

	const originalAdapter = server.stripeAdapter;
	server.stripeAdapter = undefined;

	try {
		const mcp = buildMcpServer(server, {
			...session,
			allowToolAuthorizationFallback: true,
		});
		const tools = Object.keys(
			(mcp as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		assert.ok(!tools.includes("agentinfra.payments.issue_card"));
		assert.ok(
			!tools.includes("agentinfra.payments.create_card_details_session"),
		);
		// Other tools should still be present
		assert.ok(tools.includes("agentinfra.agents.create"));
		assert.ok(tools.includes("agentinfra.email.send"));
	} finally {
		server.stripeAdapter = originalAdapter;
		restore();
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// payments tool tests
// ---------------------------------------------------------------------------

void test("agentinfra.payments.issue_card returns only safe card metadata", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});

	const fakeEvent = {
		id: "33333333-3333-4333-8333-333333333333",
		orgId: "org_123",
		agentId: "agt_123",
		resourceId: "res_card_123",
		provider: "stripe",
		providerEventId: null,
		eventType: "payment.card.issued" as const,
		occurredAt: FIXED_TIMESTAMP,
		idempotencyKey: null,
		data: { card_id: "ic_test123" },
		ingestedAt: FIXED_TIMESTAMP,
	};

	const fakeResource = {
		id: "res_card_123",
		orgId: "org_123",
		agentId: "agt_123",
		type: "card" as const,
		provider: "stripe",
		providerRef: "ic_test123",
		providerOrgId: null,
		config: {
			cardholder_id: "ich_test",
			last4: "4242",
			exp_month: 12,
			exp_year: 2027,
			currency: "usd",
		},
		state: "active" as const,
		createdAt: FIXED_TIMESTAMP,
		updatedAt: FIXED_TIMESTAMP,
	};

	// Mock resourceManager
	const originalRM = server.resourceManager;
	server.resourceManager = {
		provision: () => Promise.resolve({ resource: fakeResource }),
	} as unknown as typeof server.resourceManager;

	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () =>
			Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult),
	});

	// Need stripeAdapter to be present
	const originalStripe = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, session);
		const registeredTools = (
			mcp as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (...args: unknown[]) => Promise<unknown> }
				>;
			}
		)._registeredTools;
		const issueTool = registeredTools["agentinfra.payments.issue_card"];
		assert.ok(issueTool, "issue_card tool should be registered");

		const result = (await issueTool.handler(
			{
				agent_id: "agt_123",
				cardholder_name: "Agent Tester",
				billing_address: {
					line1: "123 Market St",
					city: "San Francisco",
					postal_code: "94105",
					country: "US",
				},
				currency: "usd",
				spending_limits: [{ amount: 5000, interval: "per_authorization" }],
			},
			{} as never,
		)) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: { card: { last4: string; currency: string } };
		};

		const textContent = result.content[0].text;
		assert.ok(textContent.includes('"last4": "4242"'));
		assert.ok(!textContent.includes("number"));
		assert.ok(!textContent.includes("cvc"));
		assert.strictEqual(result.structuredContent.card.last4, "4242");
		assert.strictEqual(result.structuredContent.card.currency, "usd");
	} finally {
		server.resourceManager = originalRM;
		server.stripeAdapter = originalStripe;
		restore();
		restoreAgents();
		restoreWriter();
		await server.close();
	}
});

void test("agentinfra.payments.issue_card returns a pending result for in-progress replays", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const pendingResource = buildCardResourceRecord({
		id: "res_card_pending",
		state: "provisioning",
		config: {
			cardholder_name: "Agent Tester",
			billing_address: {
				line1: "123 Market St",
				city: "San Francisco",
				postal_code: "94105",
				country: "US",
			},
			currency: "usd",
			spending_limits: [{ amount: 5000, interval: "per_authorization" }],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreEvents = installEventsDalMock({
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreResources = installResourcesDalMock({
		findById: () => Promise.resolve(null),
	});

	const originalRM = server.resourceManager;
	server.resourceManager = {
		provision: () =>
			Promise.resolve({ resource: pendingResource, reusedExisting: true }),
	} as unknown as typeof server.resourceManager;

	const originalStripe = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, session);
		const registeredTools = (
			mcp as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (...args: unknown[]) => Promise<unknown> }
				>;
			}
		)._registeredTools;
		const issueTool = registeredTools["agentinfra.payments.issue_card"];
		assert.ok(issueTool, "issue_card tool should be registered");

		const result = (await issueTool.handler(
			{
				agent_id: "agt_123",
				cardholder_name: "Agent Tester",
				billing_address: {
					line1: "123 Market St",
					city: "San Francisco",
					postal_code: "94105",
					country: "US",
				},
				currency: "usd",
				spending_limits: [{ amount: 5000, interval: "per_authorization" }],
				idempotency_key: "idem_pending",
			},
			{} as never,
		)) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: { status: string; message: string };
		};

		assert.deepStrictEqual(
			JSON.parse(result.content[0].text),
			result.structuredContent,
		);
		assert.strictEqual(result.structuredContent.status, "pending");
		assert.match(result.structuredContent.message, /in progress/i);
	} finally {
		server.resourceManager = originalRM;
		server.stripeAdapter = originalStripe;
		restore();
		restoreAgents();
		restoreEvents();
		restoreResources();
		await server.close();
	}
});

void test("agentinfra.payments.create_card_details_session returns the ephemeral key to callers", async () => {
	const server = await buildServer();
	const { session, restore } = await buildAuthenticatedMcpSession(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findById: () =>
			Promise.resolve(
				buildCardResourceRecord({
					id: "res_card_123",
					agentId: "agt_123",
				}),
			),
	});

	const originalStripe = server.stripeAdapter;
	server.stripeAdapter = {
		createCardDetailsSession: () =>
			Promise.resolve({
				cardId: "ic_test123",
				ephemeralKeySecret: "ephkey_test_secret",
				expiresAt: 1_800_000_000,
				livemode: false,
				apiVersion: STRIPE_API_VERSION,
			}),
	} as unknown as typeof server.stripeAdapter;

	try {
		const mcp = buildMcpServer(server, session);
		const registeredTools = (
			mcp as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (...args: unknown[]) => Promise<unknown> }
				>;
			}
		)._registeredTools;
		const detailsTool =
			registeredTools["agentinfra.payments.create_card_details_session"];
		assert.ok(
			detailsTool,
			"create_card_details_session tool should be registered",
		);

		const result = (await detailsTool.handler(
			{
				agent_id: "agt_123",
				resource_id: "res_card_123",
				nonce: "nonce_123",
			},
			{} as never,
		)) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: {
				session: { ephemeral_key_secret?: string; card_id: string };
			};
		};

		const textContent = result.content[0].text;
		assert.ok(textContent.includes('"card_id": "ic_test123"'));
		// ephemeral_key_secret must NOT appear in text content (leak risk)
		assert.ok(
			!textContent.includes("ephemeral_key_secret"),
			"ephemeral_key_secret must be stripped from text content",
		);
		// ephemeral_key_secret must be present in structuredContent for Stripe.js Issuing Elements
		assert.strictEqual(result.structuredContent.session.card_id, "ic_test123");
		assert.strictEqual(
			result.structuredContent.session.ephemeral_key_secret,
			"ephkey_test_secret",
		);
	} finally {
		server.stripeAdapter = originalStripe;
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// orgs.create returns keys in structuredContent
// ---------------------------------------------------------------------------

void test("agentinfra.orgs.create returns root_key in structuredContent", async () => {
	const server = await buildServer();

	const fakeOrg = { id: "org_fake", name: "Test Org" };
	const fakeApiKey = {
		id: "key_fake",
		orgId: "org_fake",
		keyType: "root",
		key: "sk_fake.secret",
		createdAt: FIXED_TIMESTAMP.toISOString(),
	};

	// Mock createOrgWithApiKey
	const originalCreate = server.systemDal.createOrgWithApiKey.bind(
		server.systemDal,
	);
	server.systemDal.createOrgWithApiKey = () =>
		Promise.resolve({
			org: {
				id: fakeOrg.id,
				name: fakeOrg.name,
				planTier: "starter" as const,
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				subscriptionStatus: "incomplete" as const,
				currentPeriodEnd: null,
				createdAt: FIXED_TIMESTAMP,
			},
			apiKey: {
				id: fakeApiKey.id,
				orgId: fakeOrg.id,
				keyType: "root" as const,
				keyHash: "hash",
				isRevoked: false,
				createdAt: FIXED_TIMESTAMP,
			},
		});

	// generateApiKeyMaterial is called inside the route handler; we can't easily mock it
	// Instead let's just test that the tool calls POST /orgs and the result has structuredContent
	// by intercepting server.inject. We'll override systemDal's createOrgWithApiKey.

	try {
		const mcp = buildMcpServer(server, {
			auth: null,
			authorizationHeader: null,
		}); // no auth — bootstrap only
		const registeredTools = (
			mcp as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (...args: unknown[]) => Promise<unknown> }
				>;
			}
		)._registeredTools;
		const createOrgTool = registeredTools["agentinfra.orgs.create"];
		assert.ok(createOrgTool, "orgs.create should be registered");

		const result = (await createOrgTool.handler(
			{ name: "Test Org" },
			{} as never,
		)) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: { org_id: string; root_key: string };
		};

		assert.ok(result.structuredContent, "structuredContent should be present");
		assert.ok(
			typeof result.structuredContent.root_key === "string",
			"root_key should be in structuredContent",
		);
		assert.ok(
			typeof result.structuredContent.org_id === "string",
			"org_id should be in structuredContent",
		);

		// Text content should NOT contain the key
		const textContent = result.content[0].text;
		assert.ok(
			!textContent.includes(result.structuredContent.root_key),
			"key must not be in text content",
		);
	} finally {
		server.systemDal.createOrgWithApiKey = originalCreate;
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// GET /messages route tests
// ---------------------------------------------------------------------------

void test("GET /agents/:id/messages/:messageId returns the provider message payload", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			assert.strictEqual(action, "get_message");
			assert.strictEqual(payload.message_id, "msg_001");
			return Promise.resolve({
				message_id: "msg_001",
				thread_id: "thread_001",
				from: "sender@example.com",
				labels: ["received"],
				timestamp: FIXED_TIMESTAMP.toISOString(),
				to: ["agent@mail.example.com"],
				cc: ["cc@example.com"],
				bcc: ["bcc@example.com"],
				reply_to: ["Sender <sender@example.com>"],
				subject: "Original subject",
				preview: "Original preview",
				text: "Original text",
				html: "<p>Original text</p>",
				headers: { "In-Reply-To": "msg_parent_001" },
				in_reply_to: "msg_parent_001",
				references: ["msg_parent_001"],
				size: 1024,
				created_at: FIXED_TIMESTAMP.toISOString(),
				updated_at: FIXED_TIMESTAMP.toISOString(),
			});
		},
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/messages/msg_001",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 200);
		assert.deepStrictEqual(response.json(), {
			message_id: "msg_001",
			thread_id: "thread_001",
			from: "sender@example.com",
			labels: ["received"],
			timestamp: FIXED_TIMESTAMP.toISOString(),
			to: ["agent@mail.example.com"],
			cc: ["cc@example.com"],
			bcc: ["bcc@example.com"],
			reply_to: ["Sender <sender@example.com>"],
			subject: "Original subject",
			preview: "Original preview",
			text: "Original text",
			html: "<p>Original text</p>",
			headers: { "In-Reply-To": "msg_parent_001" },
			in_reply_to: "msg_parent_001",
			references: ["msg_parent_001"],
			size: 1024,
			created_at: FIXED_TIMESTAMP.toISOString(),
			updated_at: FIXED_TIMESTAMP.toISOString(),
		});
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});

void test("GET /agents/:id/messages/:messageId returns provider 404s directly", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () =>
			Promise.reject(
				new AgentMailError({
					message: "NotFoundError",
					statusCode: 404,
					body: { message: "Message not found" },
				}),
			),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/messages/msg_missing",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 404);
		assert.deepStrictEqual(response.json(), { message: "Message not found" });
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});
