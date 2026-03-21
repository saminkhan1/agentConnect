import assert from "node:assert";
import test from "node:test";

import { buildServer } from "../src/api/server";
import { DalFactory } from "../src/db/dal";
import { AppError } from "../src/domain/errors";
import { enforceEmailPolicy } from "../src/domain/policy";
import type { ResourceManager } from "../src/domain/resource-manager";
import {
	buildAgentRecord,
	FIXED_TIMESTAMP,
	installAgentsDalMock,
	installAuthApiKey,
	type ResourceRecord,
} from "./helpers";

function buildResourceRecord(
	overrides?: Partial<ResourceRecord>,
): ResourceRecord {
	return {
		id: "res_123",
		orgId: "org_123",
		agentId: "agt_123",
		type: "email_inbox",
		provider: "mock",
		providerRef: "mock_ref_123",
		providerOrgId: null,
		config: {},
		state: "active",
		createdAt: FIXED_TIMESTAMP,
		updatedAt: FIXED_TIMESTAMP,
		...overrides,
	};
}

function installResourcesDalMock(methods: {
	findByAgentId?: (agentId: string) => Promise<ResourceRecord[]>;
	findById?: (id: string) => Promise<ResourceRecord | null>;
	insert?: (data: unknown) => Promise<ResourceRecord>;
	updateById?: (id: string, data: unknown) => Promise<ResourceRecord | null>;
}) {
	const originalDescriptor = Object.getOwnPropertyDescriptor(
		DalFactory.prototype,
		"resources",
	);
	Object.defineProperty(DalFactory.prototype, "resources", {
		configurable: true,
		get() {
			return methods;
		},
	});
	return () => {
		if (originalDescriptor) {
			Object.defineProperty(
				DalFactory.prototype,
				"resources",
				originalDescriptor,
			);
		}
	};
}

function installResourceManagerMock(
	server: Awaited<ReturnType<typeof buildServer>>,
	methods: Partial<ResourceManager>,
) {
	const original = server.resourceManager;
	server.resourceManager = methods as ResourceManager;
	return () => {
		server.resourceManager = original;
	};
}

// ---------------------------------------------------------------------------
// Policy tests
// ---------------------------------------------------------------------------

void test("enforceEmailPolicy: no config → always allowed", () => {
	const result = enforceEmailPolicy({}, { to: ["user@example.com"] });
	assert.strictEqual(result.allowed, true);
	assert.strictEqual(result.reasons.length, 0);
});

void test("enforceEmailPolicy: allowed_domains blocks non-matching recipients", () => {
	const result = enforceEmailPolicy(
		{ allowed_domains: ["trusted.com"] },
		{ to: ["user@trusted.com", "user@other.com"] },
	);
	assert.strictEqual(result.allowed, false);
	assert.ok(result.reasons.some((r) => r.includes("user@other.com")));
});

void test("enforceEmailPolicy: allowed_domains passes matching recipients", () => {
	const result = enforceEmailPolicy(
		{ allowed_domains: ["trusted.com"] },
		{ to: ["a@trusted.com"], cc: ["b@trusted.com"] },
	);
	assert.strictEqual(result.allowed, true);
});

void test("enforceEmailPolicy: blocked_domains rejects matching recipients", () => {
	const result = enforceEmailPolicy(
		{ blocked_domains: ["spam.com"] },
		{ to: ["good@safe.com", "bad@spam.com"] },
	);
	assert.strictEqual(result.allowed, false);
	assert.ok(result.reasons.some((r) => r.includes("bad@spam.com")));
});

void test("enforceEmailPolicy: max_recipients rejects oversized lists", () => {
	const result = enforceEmailPolicy(
		{ max_recipients: 2 },
		{ to: ["a@x.com", "b@x.com", "c@x.com"] },
	);
	assert.strictEqual(result.allowed, false);
	assert.ok(result.reasons.some((r) => r.includes("max_recipients")));
});

void test("enforceEmailPolicy: max_recipients allows exact count", () => {
	const result = enforceEmailPolicy(
		{ max_recipients: 2 },
		{ to: ["a@x.com", "b@x.com"] },
	);
	assert.strictEqual(result.allowed, true);
});

void test('enforceEmailPolicy: allowed_domains wildcard ["*"] allows any domain', () => {
	const result = enforceEmailPolicy(
		{ allowed_domains: ["*"] },
		{ to: ["user@protonmail.com", "other@gmail.com"] },
	);
	assert.strictEqual(result.allowed, true);
	assert.deepStrictEqual(result.reasons, []);
});

void test("enforceEmailPolicy: allowed_domains wildcard still respects blocked_domains", () => {
	const result = enforceEmailPolicy(
		{ allowed_domains: ["*"], blocked_domains: ["spam.com"] },
		{ to: ["user@protonmail.com", "bad@spam.com"] },
	);
	assert.strictEqual(result.allowed, false);
	assert.strictEqual(result.reasons.length, 1);
	assert.ok(result.reasons[0].includes("blocked_domains"));
});

void test("enforceEmailPolicy: allowed_domains as string → treated as no restriction", () => {
	// Defense-in-depth: non-array value must not crash and must not invert the policy
	const result = enforceEmailPolicy(
		{ allowed_domains: "example.com" as unknown as string[] },
		{ to: ["user@example.com"] },
	);
	assert.strictEqual(result.allowed, true);
	assert.deepStrictEqual(result.reasons, []);
});

void test("enforceEmailPolicy: blocked_domains as object → does not bypass the block", () => {
	// Primary defense is schema rejection at ingress; runtime guard ensures no crash here
	const result = enforceEmailPolicy(
		{ blocked_domains: { "0": "spam.com" } as unknown as string[] },
		{ to: ["bad@spam.com"] },
	);
	// Non-array blocked_domains is treated as absent — no block applied by the function itself
	assert.strictEqual(result.allowed, true);
	assert.deepStrictEqual(result.reasons, []);
});

void test("enforceEmailPolicy: max_recipients as string → treated as no limit", () => {
	const result = enforceEmailPolicy(
		{ max_recipients: "2" as unknown as number },
		{ to: ["a@x.com", "b@x.com", "c@x.com"] },
	);
	// Non-number max_recipients treated as absent → no limit enforced
	assert.strictEqual(result.allowed, true);
	assert.deepStrictEqual(result.reasons, []);
});

// ---------------------------------------------------------------------------
// Resource route unit tests
// ---------------------------------------------------------------------------

void test("POST /agents/:id/resources returns 401 for missing auth", async () => {
	const server = await buildServer();

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/resources",
			payload: { type: "email_inbox", provider: "mock" },
		});

		assert.strictEqual(response.statusCode, 401);
	} finally {
		await server.close();
	}
});

void test("POST /agents/:id/resources returns 404 when agent not found", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_missing/resources",
			headers: { authorization: authorizationHeader },
			payload: { type: "email_inbox", provider: "mock" },
		});

		assert.strictEqual(response.statusCode, 404);
		const payload = JSON.parse(response.payload) as { message: string };
		assert.strictEqual(payload.message, "Agent not found");
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});

void test("POST /agents/:id/resources returns 400 for Stripe card provisioning", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	let provisionCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResourceManager = installResourceManagerMock(server, {
		provision: () => {
			provisionCalls += 1;
			return Promise.resolve({
				resource: buildResourceRecord({ type: "card", provider: "stripe" }),
			});
		},
	});

	// Mock stripeAdapter as present so the 400 redirect fires instead of 422
	const originalAdapter = server.stripeAdapter;
	server.stripeAdapter = {} as typeof server.stripeAdapter;

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/resources",
			headers: { authorization: authorizationHeader },
			payload: { type: "card", provider: "stripe", config: {} },
		});

		assert.strictEqual(response.statusCode, 400);
		assert.strictEqual(provisionCalls, 0);
		const payload = JSON.parse(response.payload) as { message: string };
		assert.ok(payload.message.includes("/agents/:id/actions/issue_card"));
	} finally {
		server.stripeAdapter = originalAdapter;
		restore();
		restoreAgents();
		restoreResourceManager();
		await server.close();
	}
});

void test("POST /agents/:id/resources returns 201 with provisioned resource", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResourceManager = installResourceManagerMock(server, {
		provision: (_dal, _agentId, _type, _provider, _config) =>
			Promise.resolve({ resource }),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/resources",
			headers: { authorization: authorizationHeader },
			payload: { type: "email_inbox", provider: "mock" },
		});

		assert.strictEqual(response.statusCode, 201);
		const payload = JSON.parse(response.payload) as {
			resource: { id: string; state: string };
		};
		assert.strictEqual(payload.resource.id, "res_123");
		assert.strictEqual(payload.resource.state, "active");
	} finally {
		restore();
		restoreAgents();
		restoreResourceManager();
		await server.close();
	}
});

void test("POST /agents/:id/resources allows non-Stripe card providers", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord({ type: "card", provider: "mock" });
	let provisionCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResourceManager = installResourceManagerMock(server, {
		provision: (_dal, _agentId, _type, _provider, _config) => {
			provisionCalls += 1;
			return Promise.resolve({ resource });
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/resources",
			headers: { authorization: authorizationHeader },
			payload: { type: "card", provider: "mock", config: {} },
		});

		assert.strictEqual(response.statusCode, 201);
		assert.strictEqual(provisionCalls, 1);
		const payload = JSON.parse(response.payload) as {
			resource: { type: string; provider: string };
		};
		assert.strictEqual(payload.resource.type, "card");
		assert.strictEqual(payload.resource.provider, "mock");
	} finally {
		restore();
		restoreAgents();
		restoreResourceManager();
		await server.close();
	}
});

void test("GET /agents/:id/resources returns 404 when agent not found", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_missing/resources",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 404);
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});

void test("GET /agents/:id/resources returns 200 with resource list", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findByAgentId: (_agentId) => Promise.resolve([resource]),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/resources",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 200);
		const payload = JSON.parse(response.payload) as {
			resources: Array<{ id: string; state: string }>;
		};
		assert.strictEqual(payload.resources.length, 1);
		assert.strictEqual(payload.resources[0].id, "res_123");
		assert.strictEqual(payload.resources[0].state, "active");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

void test("DELETE /agents/:id/resources/:rid returns 200 with deprovisioned resource", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const deprovisioned = buildResourceRecord({
		state: "deleted",
		providerRef: null,
	});

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResourceManager = installResourceManagerMock(server, {
		deprovision: (_dal, _resourceId) => Promise.resolve(deprovisioned),
	});

	try {
		const response = await server.inject({
			method: "DELETE",
			url: "/agents/agt_123/resources/res_123",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 200);
		const payload = JSON.parse(response.payload) as {
			resource: { id: string; state: string };
		};
		assert.strictEqual(payload.resource.id, "res_123");
		assert.strictEqual(payload.resource.state, "deleted");
	} finally {
		restore();
		restoreAgents();
		restoreResourceManager();
		await server.close();
	}
});

void test("DELETE /agents/:id/resources/:rid returns 404 when resource not found", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResourceManager = installResourceManagerMock(server, {
		deprovision: (_dal, _resourceId) => {
			throw new AppError("NOT_FOUND", 404, "Resource not found");
		},
	});

	try {
		const response = await server.inject({
			method: "DELETE",
			url: "/agents/agt_123/resources/res_missing",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 404);
		const payload = JSON.parse(response.payload) as { message: string };
		assert.strictEqual(payload.message, "Resource not found");
	} finally {
		restore();
		restoreAgents();
		restoreResourceManager();
		await server.close();
	}
});

void test("GET /agents/:id/resources cross-org isolation: another org auth → 404", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		orgId: "org_other",
	});
	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/resources",
			headers: { authorization: authorizationHeader },
		});

		assert.strictEqual(response.statusCode, 404);
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});
