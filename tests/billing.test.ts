import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServer } from "../src/api/server";
import { getPlanLimits } from "../src/domain/billing-limits";
import {
	buildAgentRecord,
	FIXED_TIMESTAMP,
	installAgentsDalMock,
	installAuthApiKey,
} from "./helpers";

// --- Plan limits config ---

void test("getPlanLimits returns correct limits for each tier", () => {
	const starter = getPlanLimits("starter");
	assert.equal(starter.maxAgents, 1);
	assert.equal(starter.maxInboxes, 1);
	assert.equal(starter.maxEmailsPerMonth, 1_000);
	assert.equal(starter.maxCardsPerMonth, 5);

	const personal = getPlanLimits("personal");
	assert.equal(personal.maxAgents, 1);
	assert.equal(personal.maxEmailsPerMonth, 2_000);
	assert.equal(personal.maxCardsPerMonth, 15);

	const power = getPlanLimits("power");
	assert.equal(power.maxAgents, 3);
	assert.equal(power.maxInboxes, 3);
	assert.equal(power.maxEmailsPerMonth, 5_000);
	assert.equal(power.maxCardsPerMonth, 50);
});

// --- Signup secret gate ---

void test("POST /orgs returns 403 when SIGNUP_SECRET is set but not provided", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();
		try {
			const response = await server.inject({
				method: "POST",
				url: "/orgs",
				payload: { name: "Test Org" },
			});
			assert.equal(response.statusCode, 403);
			const body = response.json();
			assert.equal(body.message, "Invalid signup secret");
		} finally {
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

void test("POST /orgs returns 403 when SIGNUP_SECRET is set but wrong value provided", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();
		try {
			const response = await server.inject({
				method: "POST",
				url: "/orgs",
				headers: { "x-signup-secret": "wrong-secret" },
				payload: { name: "Test Org" },
			});
			assert.equal(response.statusCode, 403);
		} finally {
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

void test("POST /orgs succeeds when correct SIGNUP_SECRET is provided", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();

		const originalCreate = server.systemDal.createOrgWithApiKey.bind(
			server.systemDal,
		);
		server.systemDal.createOrgWithApiKey = (data) => {
			return Promise.resolve({
				org: {
					id: data.org.id,
					name: data.org.name ?? "Test",
					planTier: "starter" as const,
					stripeCustomerId: null,
					stripeSubscriptionId: null,
					subscriptionStatus: "incomplete" as const,
					currentPeriodEnd: null,
					createdAt: FIXED_TIMESTAMP,
				},
				apiKey: {
					id: data.apiKey.id,
					orgId: data.org.id,
					keyType: data.apiKey.keyType,
					keyHash: data.apiKey.keyHash,
					isRevoked: false,
					createdAt: FIXED_TIMESTAMP,
				},
			});
		};

		try {
			const response = await server.inject({
				method: "POST",
				url: "/orgs",
				headers: { "x-signup-secret": "test-beta-secret" },
				payload: { name: "Test Org" },
			});
			assert.equal(response.statusCode, 201);
			const body = response.json();
			assert.ok(body.org.id.startsWith("org_"));
			assert.ok(body.apiKey.key.startsWith("sk_"));
		} finally {
			server.systemDal.createOrgWithApiKey = originalCreate;
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

// --- Subscription enforcement ---

void test("Subscription enforcement returns 402 when subscription is inactive and SIGNUP_SECRET is set", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();
		const { authorizationHeader, restore: restoreAuth } =
			await installAuthApiKey(server);

		const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
		server.systemDal.getOrg = (id) =>
			Promise.resolve({
				id,
				name: "Test Org",
				planTier: "starter" as const,
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				subscriptionStatus: "canceled" as const,
				currentPeriodEnd: null,
				createdAt: FIXED_TIMESTAMP,
			});

		const restoreAgents = installAgentsDalMock({
			findById: () => Promise.resolve(buildAgentRecord()),
		});

		try {
			const response = await server.inject({
				method: "GET",
				url: "/agents/agt_123",
				headers: { authorization: authorizationHeader },
			});
			assert.equal(response.statusCode, 402);
			const body = response.json();
			assert.ok(body.message.includes("Active subscription required"));
		} finally {
			restoreAuth();
			restoreAgents();
			server.systemDal.getOrg = originalGetOrg;
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

void test("Subscription enforcement allows requests when subscription is active and SIGNUP_SECRET is set", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();
		const { authorizationHeader, restore: restoreAuth } =
			await installAuthApiKey(server);

		const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
		server.systemDal.getOrg = (id) =>
			Promise.resolve({
				id,
				name: "Test Org",
				planTier: "starter" as const,
				stripeCustomerId: "cus_test",
				stripeSubscriptionId: "sub_test",
				subscriptionStatus: "active" as const,
				currentPeriodEnd: new Date("2026-04-01"),
				createdAt: FIXED_TIMESTAMP,
			});

		const restoreAgents = installAgentsDalMock({
			findById: () => Promise.resolve(buildAgentRecord()),
		});

		try {
			const response = await server.inject({
				method: "GET",
				url: "/agents/agt_123",
				headers: { authorization: authorizationHeader },
			});
			// Active subscription: should pass through to route (200), not 402
			assert.equal(response.statusCode, 200);
		} finally {
			restoreAuth();
			restoreAgents();
			server.systemDal.getOrg = originalGetOrg;
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

void test("Subscription enforcement skips billing routes", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	process.env.SIGNUP_SECRET = "test-beta-secret";

	try {
		const server = await buildServer();
		const { authorizationHeader, restore: restoreAuth } =
			await installAuthApiKey(server);

		const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
		server.systemDal.getOrg = (id) =>
			Promise.resolve({
				id,
				name: "Test Org",
				planTier: "starter" as const,
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				subscriptionStatus: "incomplete" as const,
				currentPeriodEnd: null,
				createdAt: FIXED_TIMESTAMP,
			});

		try {
			// Billing endpoints should not be blocked by subscription check.
			// billingService is not configured so it returns 500, not 402.
			const response = await server.inject({
				method: "POST",
				url: "/billing/checkout",
				headers: { authorization: authorizationHeader },
				payload: {
					plan_tier: "starter",
					success_url: "https://example.com/success",
					cancel_url: "https://example.com/cancel",
				},
			});
			assert.notEqual(response.statusCode, 402);
		} finally {
			restoreAuth();
			server.systemDal.getOrg = originalGetOrg;
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});

void test("Billing checkout rejects service keys", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/billing/checkout",
			headers: { authorization: authorizationHeader },
			payload: {
				plan_tier: "starter",
				success_url: "https://example.com/success",
				cancel_url: "https://example.com/cancel",
			},
		});

		assert.equal(response.statusCode, 403);
		assert.equal(response.json<{ message: string }>().message, "Forbidden");
	} finally {
		restore();
		await server.close();
	}
});

void test("Billing portal rejects service keys", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/billing/portal",
			headers: { authorization: authorizationHeader },
			payload: {
				return_url: "https://example.com/account",
			},
		});

		assert.equal(response.statusCode, 403);
		assert.equal(response.json<{ message: string }>().message, "Forbidden");
	} finally {
		restore();
		await server.close();
	}
});

void test("Subscription enforcement does not activate when SIGNUP_SECRET is not set", async () => {
	const originalEnv = process.env.SIGNUP_SECRET;
	delete process.env.SIGNUP_SECRET;

	try {
		const server = await buildServer();
		const { authorizationHeader, restore: restoreAuth } =
			await installAuthApiKey(server);

		const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
		server.systemDal.getOrg = (id) =>
			Promise.resolve({
				id,
				name: "Test Org",
				planTier: "starter" as const,
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				subscriptionStatus: "incomplete" as const,
				currentPeriodEnd: null,
				createdAt: FIXED_TIMESTAMP,
			});

		try {
			// Use health endpoint through auth — the point is subscription check doesn't block
			// Since we can't easily mock GET /agents (needs findMany), use a GET /agents/:id
			// which only needs findById and returns 404 (not 402).
			const restoreAgents = installAgentsDalMock({
				findById: () => Promise.resolve(null),
			});

			const response = await server.inject({
				method: "GET",
				url: "/agents/agt_nonexistent",
				headers: { authorization: authorizationHeader },
			});
			// Without SIGNUP_SECRET, subscription enforcement is off — should get 404 (not found), not 402
			assert.equal(response.statusCode, 404);
			restoreAgents();
		} finally {
			restoreAuth();
			server.systemDal.getOrg = originalGetOrg;
			await server.close();
		}
	} finally {
		if (originalEnv === undefined) {
			delete process.env.SIGNUP_SECRET;
		} else {
			process.env.SIGNUP_SECRET = originalEnv;
		}
	}
});
