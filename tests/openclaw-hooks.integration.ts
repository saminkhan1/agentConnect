import assert from "node:assert";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import { eq } from "drizzle-orm";

import { buildServer } from "../src/api/server";
import { db } from "../src/db";
import {
	agents,
	apiKeys,
	events,
	orgs,
	webhookDeliveries,
	webhookSubscriptions,
} from "../src/db/schema";
import { generateApiKeyMaterial } from "../src/domain/api-keys";
import {
	buildOutboundWebhookSignature,
	OutboundWebhookService,
	OutboundWebhookWorker,
} from "../src/domain/outbound-webhooks";

type AppServer = Awaited<ReturnType<typeof buildServer>>;
type HookRequest = {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	rawBody: string;
	body: unknown;
};
type HookResponse = {
	statusCode: number;
	body?: Record<string, unknown> | string;
	headers?: Record<string, string>;
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

function createHookServer() {
	const requests: HookRequest[] = [];
	const queuedResponses: HookResponse[] = [];
	const server = http.createServer((request, response) => {
		void (async () => {
			const chunks: string[] = [];
			request.setEncoding("utf8");
			for await (const chunk of request) {
				if (typeof chunk === "string") {
					chunks.push(chunk);
				}
			}

			const rawBody = chunks.join("");
			let body: unknown = rawBody;
			try {
				body = JSON.parse(rawBody);
			} catch {
				body = rawBody;
			}

			requests.push({
				method: request.method ?? "GET",
				url: request.url ?? "/",
				headers: request.headers,
				rawBody,
				body,
			});

			const nextResponse: HookResponse = queuedResponses.shift() ?? {
				statusCode: 200,
				body: { ok: true },
			};
			response.statusCode = nextResponse.statusCode;
			const responseHeaders = nextResponse.headers ?? {};
			for (const [name, value] of Object.entries(responseHeaders)) {
				response.setHeader(name, value);
			}
			if (!response.hasHeader("content-type")) {
				response.setHeader("content-type", "application/json");
			}
			response.end(
				typeof nextResponse.body === "string"
					? nextResponse.body
					: JSON.stringify(nextResponse.body ?? { ok: true }),
			);
		})();
	});

	return {
		requests,
		enqueueResponse(response: HookResponse) {
			queuedResponses.push(response);
		},
		async listen() {
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve);
			});

			const address = server.address();
			assert.ok(
				address && typeof address !== "string",
				"expected hook server TCP address",
			);
			return `http://127.0.0.1:${String(address.port)}`;
		},
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
			});
		},
	};
}

async function createOrgWithRootKey(server: AppServer, orgId: string) {
	const rootKey = await generateApiKeyMaterial();
	await server.systemDal.createOrgWithApiKey({
		org: {
			id: orgId,
			name: `OpenClaw Test Org ${orgId}`,
		},
		apiKey: {
			id: rootKey.id,
			keyType: "root",
			keyHash: rootKey.keyHash,
			isRevoked: false,
		},
	});

	return `Bearer ${rootKey.plaintextKey}`;
}

async function createAgent(orgId: string, agentId: string) {
	await db.insert(agents).values({
		id: agentId,
		orgId,
		name: `Agent ${agentId}`,
		isArchived: false,
		createdAt: new Date(),
	});
}

async function cleanupOrg(orgId: string) {
	await db
		.delete(webhookSubscriptions)
		.where(eq(webhookSubscriptions.orgId, orgId));
	await db.delete(events).where(eq(events.orgId, orgId));
	await db.delete(agents).where(eq(agents.orgId, orgId));
	await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
	await db.delete(orgs).where(eq(orgs.id, orgId));
}

async function forceDeliveryDue(
	subscriptionId: string,
	options?: { nextAttemptAt?: Date; updatedAt?: Date },
) {
	await db
		.update(webhookDeliveries)
		.set({
			nextAttemptAt: options?.nextAttemptAt ?? new Date(Date.now() - 1_000),
			lockedAt: null,
			updatedAt: options?.updatedAt ?? new Date(),
		})
		.where(eq(webhookDeliveries.subscriptionId, subscriptionId));
}

async function getDeliveryRow(subscriptionId: string) {
	const rows = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.subscriptionId, subscriptionId))
		.limit(1);
	return rows[0] ?? null;
}

void test("integration: outbound webhooks deliver OpenClaw agent hook payloads with Bearer auth and signatures", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_agent_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_agent_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/oc/hooks/agent/`,
				event_types: ["email.received"],
				delivery_mode: "openclaw_hook_agent",
				static_headers: {
					Authorization: "Bearer oc_agent_token",
				},
				delivery_config: {
					name: "AgentConnect Hook",
					agent_id: "assistant_ops",
					session_key_prefix: "agentconnect_evt_",
				},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
			signingSecret: string;
		} = createSubscriptionResponse.json();

		const writeResult = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.received",
			occurredAt: "2026-03-12T12:00:00.000Z",
			data: {
				message_id: "msg_agent_1",
				thread_id: "thread_agent_1",
				from: "customer@example.com",
			},
		});
		assert.strictEqual(writeResult.wasCreated, true);

		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
		assert.strictEqual(hookServer.requests.length, 1);

		const request = hookServer.requests[0];
		assert.strictEqual(request.url, "/oc/hooks/agent/");
		assert.strictEqual(request.headers.authorization, "Bearer oc_agent_token");

		const timestampHeader = request.headers["x-agentconnect-timestamp"];
		const signatureTimestamp = Array.isArray(timestampHeader)
			? timestampHeader[0]
			: timestampHeader;
		assert.ok(signatureTimestamp, "expected x-agentconnect-timestamp header");
		assert.strictEqual(
			request.headers["x-agentconnect-signature"],
			`sha256=${buildOutboundWebhookSignature(
				createSubscriptionPayload.signingSecret,
				signatureTimestamp,
				request.rawBody,
			)}`,
		);

		const body = request.body as {
			message: string;
			name: string;
			agentId: string;
			sessionKey: string;
		};
		assert.strictEqual(body.name, "AgentConnect Hook");
		assert.strictEqual(body.agentId, "assistant_ops");
		assert.strictEqual(
			body.sessionKey,
			`agentconnect_evt_${writeResult.event.id}`,
		);

		const envelope = JSON.parse(body.message) as {
			source: string;
			delivery_mode: string;
			subscription_id: string;
			event: { id: string; event_type: string };
		};
		assert.strictEqual(envelope.source, "agentconnect");
		assert.strictEqual(envelope.delivery_mode, "openclaw_hook_agent");
		assert.strictEqual(
			envelope.subscription_id,
			createSubscriptionPayload.subscription.id,
		);
		assert.strictEqual(envelope.event.id, writeResult.event.id);
		assert.strictEqual(envelope.event.event_type, "email.received");

		const deliveriesResponse = await server.inject({
			method: "GET",
			url: `/webhook-subscriptions/${createSubscriptionPayload.subscription.id}/deliveries`,
			headers: {
				authorization,
			},
		});

		assert.strictEqual(deliveriesResponse.statusCode, 200);
		const deliveriesPayload: {
			deliveries: Array<{
				attemptCount: number;
				lastStatus: string;
				lastRequestHeaders: Record<string, string>;
				deliveredAt: string | null;
			}>;
		} = deliveriesResponse.json();
		assert.strictEqual(deliveriesPayload.deliveries.length, 1);
		assert.strictEqual(deliveriesPayload.deliveries[0].attemptCount, 1);
		assert.strictEqual(deliveriesPayload.deliveries[0].lastStatus, "delivered");
		assert.strictEqual(
			deliveriesPayload.deliveries[0].lastRequestHeaders.authorization,
			"Bearer ***",
		);
		assert.ok(deliveriesPayload.deliveries[0].deliveredAt);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks reject hostnames that resolve to private addresses", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const server = await buildServer();
	const orgId = `org_openclaw_ssrf_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		server.outboundWebhookService = new OutboundWebhookService({
			allowlistedHosts: [],
			nodeEnv: "production",
			resolveHostname: () =>
				Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
		});

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: "https://hooks.example.com/hooks/agent",
				event_types: ["email.received"],
				delivery_mode: "openclaw_hook_agent",
				static_headers: {
					Authorization: "Bearer oc_ssrf_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 400);
		assert.match(
			createSubscriptionResponse.json<{ message: string }>().message,
			/must not resolve to private or local addresses/i,
		);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks deliver OpenClaw wake payloads with x-openclaw-token and dedupe repeated events", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_wake_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_wake_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/oc/hooks/wake`,
				event_types: ["payment.card.settled"],
				delivery_mode: "openclaw_hook_wake",
				static_headers: {
					"x-openclaw-token": "oc_wake_token",
				},
				delivery_config: {
					mode: "next-heartbeat",
				},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		const providerEventId = `evt_${crypto.randomUUID()}`;
		const firstWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			providerEventId,
			eventType: "payment.card.settled",
			occurredAt: "2026-03-12T12:05:00.000Z",
			data: {
				transaction_id: "ipi_settle_1",
				authorization_id: "iauth_settle_1",
				amount: 400,
				currency: "USD",
			},
		});
		const secondWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			providerEventId,
			eventType: "payment.card.settled",
			occurredAt: "2026-03-12T12:05:00.000Z",
			data: {
				transaction_id: "ipi_settle_1",
				authorization_id: "iauth_settle_1",
				amount: 400,
				currency: "USD",
			},
		});

		assert.strictEqual(firstWrite.wasCreated, true);
		assert.strictEqual(secondWrite.wasCreated, false);

		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 0);
		assert.strictEqual(hookServer.requests.length, 1);

		const request = hookServer.requests[0];
		assert.strictEqual(request.url, "/oc/hooks/wake");
		assert.strictEqual(request.headers["x-openclaw-token"], "oc_wake_token");

		const body = request.body as {
			text: string;
			mode: string;
		};
		assert.strictEqual(body.mode, "next-heartbeat");
		const envelope = JSON.parse(body.text) as {
			delivery_mode: string;
			event: { id: string; event_type: string };
		};
		assert.strictEqual(envelope.delivery_mode, "openclaw_hook_wake");
		assert.strictEqual(envelope.event.id, firstWrite.event.id);
		assert.strictEqual(envelope.event.event_type, "payment.card.settled");

		const deliveriesResponse = await server.inject({
			method: "GET",
			url: `/webhook-subscriptions/${createSubscriptionPayload.subscription.id}/deliveries`,
			headers: {
				authorization,
			},
		});

		assert.strictEqual(deliveriesResponse.statusCode, 200);
		const deliveriesPayload: {
			deliveries: Array<{ id: string }>;
		} = deliveriesResponse.json();
		assert.strictEqual(deliveriesPayload.deliveries.length, 1);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhook worker ignores stale deliveries after subscription deletion", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_stale_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_stale_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/hooks/agent`,
				event_types: ["email.received"],
				delivery_mode: "openclaw_hook_agent",
				static_headers: {
					Authorization: "Bearer oc_stale_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.received",
			occurredAt: "2026-03-12T12:20:00.000Z",
			data: {
				message_id: "msg_stale_1",
				thread_id: "thread_stale_1",
				from: "customer@example.com",
			},
		});

		const delivery = await getDeliveryRow(
			createSubscriptionPayload.subscription.id,
		);
		assert.ok(delivery, "expected delivery row");

		await db
			.delete(webhookSubscriptions)
			.where(
				eq(webhookSubscriptions.id, createSubscriptionPayload.subscription.id),
			);

		const worker = server.outboundWebhookWorker as unknown as {
			processDelivery: (
				deliveryRow: NonNullable<Awaited<ReturnType<typeof getDeliveryRow>>>,
			) => Promise<void>;
		};
		await assert.doesNotReject(async () => worker.processDelivery(delivery));
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks honor Retry-After delta seconds for 429 responses", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_retry_after_delta_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_retry_after_delta_${crypto.randomUUID()}`;
	const fixedNow = new Date("2026-03-12T12:25:00.000Z");

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);
		server.outboundWebhookWorker = new OutboundWebhookWorker({
			now: () => fixedNow,
			random: () => 0,
			nodeEnv: "test",
		});

		hookServer.enqueueResponse({
			statusCode: 429,
			headers: {
				"retry-after": "120",
			},
			body: { error: "rate_limited" },
		});

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/oc/hooks/agent`,
				event_types: ["email.delivered"],
				delivery_mode: "openclaw_hook_agent",
				static_headers: {
					Authorization: "Bearer oc_retry_after_delta_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.delivered",
			occurredAt: "2026-03-12T12:25:00.000Z",
			data: {
				message_id: "msg_retry_after_delta_1",
				thread_id: "thread_retry_after_delta_1",
			},
		});

		await forceDeliveryDue(createSubscriptionPayload.subscription.id, {
			nextAttemptAt: new Date(fixedNow.getTime() - 1_000),
			updatedAt: fixedNow,
		});
		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
		const delivery = await getDeliveryRow(
			createSubscriptionPayload.subscription.id,
		);
		assert.ok(delivery, "expected delivery row");
		assert.strictEqual(delivery.lastStatus, "retry_scheduled");
		assert.strictEqual(delivery.attemptCount, 1);
		assert.strictEqual(
			delivery.nextAttemptAt.toISOString(),
			new Date(fixedNow.getTime() + 120_000).toISOString(),
		);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks honor Retry-After HTTP dates for 429 responses", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_retry_after_date_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_retry_after_date_${crypto.randomUUID()}`;
	const fixedNow = new Date("2026-03-12T12:30:00.000Z");
	const retryAt = new Date(fixedNow.getTime() + 45_000);

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);
		server.outboundWebhookWorker = new OutboundWebhookWorker({
			now: () => fixedNow,
			random: () => 0,
			nodeEnv: "test",
		});

		hookServer.enqueueResponse({
			statusCode: 429,
			headers: {
				"retry-after": retryAt.toUTCString(),
			},
			body: { error: "rate_limited" },
		});

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/oc/hooks/wake`,
				event_types: ["email.bounced"],
				delivery_mode: "openclaw_hook_wake",
				static_headers: {
					"x-openclaw-token": "oc_retry_after_date_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.bounced",
			occurredAt: "2026-03-12T12:30:00.000Z",
			data: {
				message_id: "msg_retry_after_date_1",
				thread_id: "thread_retry_after_date_1",
				reason: "temporary failure",
			},
		});

		await forceDeliveryDue(createSubscriptionPayload.subscription.id, {
			nextAttemptAt: new Date(fixedNow.getTime() - 1_000),
			updatedAt: fixedNow,
		});
		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
		const delivery = await getDeliveryRow(
			createSubscriptionPayload.subscription.id,
		);
		assert.ok(delivery, "expected delivery row");
		assert.strictEqual(delivery.lastStatus, "retry_scheduled");
		assert.strictEqual(delivery.attemptCount, 1);
		assert.strictEqual(
			delivery.nextAttemptAt.toISOString(),
			retryAt.toISOString(),
		);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks retry 401, 429, and 5xx responses before succeeding", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_retry_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_retry_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);

		hookServer.enqueueResponse({
			statusCode: 401,
			body: { error: "unauthorized" },
		});
		hookServer.enqueueResponse({
			statusCode: 429,
			body: { error: "rate_limited" },
		});
		hookServer.enqueueResponse({
			statusCode: 503,
			body: { error: "unavailable" },
		});
		hookServer.enqueueResponse({ statusCode: 200, body: { ok: true } });

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/hooks/agent`,
				event_types: ["email.delivered"],
				delivery_mode: "openclaw_hook_agent",
				static_headers: {
					authorization: "Bearer oc_retry_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.delivered",
			occurredAt: "2026-03-12T12:10:00.000Z",
			data: {
				message_id: "msg_retry_1",
				thread_id: "thread_retry_1",
			},
		});

		for (let attempt = 1; attempt <= 4; attempt += 1) {
			assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
			const delivery = await getDeliveryRow(
				createSubscriptionPayload.subscription.id,
			);
			assert.ok(delivery, "expected delivery row");
			assert.strictEqual(delivery.attemptCount, attempt);

			if (attempt < 4) {
				assert.strictEqual(delivery.lastStatus, "retry_scheduled");
				await forceDeliveryDue(createSubscriptionPayload.subscription.id);
			} else {
				assert.strictEqual(delivery.lastStatus, "delivered");
			}
		}

		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 0);
		assert.strictEqual(hookServer.requests.length, 4);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});

void test("integration: outbound webhooks record stable 400 payload failures without retrying forever", {
	concurrency: false,
}, async () => {
	const restoreEnv = setEnv({ NODE_ENV: "test" });
	const hookServer = createHookServer();
	const hookBaseUrl = await hookServer.listen();
	const server = await buildServer();
	const orgId = `org_openclaw_fail_${crypto.randomUUID()}`;
	const agentId = `agt_openclaw_fail_${crypto.randomUUID()}`;

	try {
		const authorization = await createOrgWithRootKey(server, orgId);
		await createAgent(orgId, agentId);

		hookServer.enqueueResponse({
			statusCode: 400,
			body: { error: "bad_payload" },
		});

		const createSubscriptionResponse = await server.inject({
			method: "POST",
			url: "/webhook-subscriptions",
			headers: {
				authorization,
			},
			payload: {
				url: `${hookBaseUrl}/hooks/wake`,
				event_types: ["email.bounced"],
				delivery_mode: "openclaw_hook_wake",
				static_headers: {
					"x-openclaw-token": "oc_fail_token",
				},
				delivery_config: {},
			},
		});

		assert.strictEqual(createSubscriptionResponse.statusCode, 201);
		const createSubscriptionPayload: {
			subscription: { id: string };
		} = createSubscriptionResponse.json();

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: `evt_${crypto.randomUUID()}`,
			eventType: "email.bounced",
			occurredAt: "2026-03-12T12:15:00.000Z",
			data: {
				message_id: "msg_fail_1",
				thread_id: "thread_fail_1",
				reason: "mailbox unavailable",
			},
		});

		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 1);
		assert.strictEqual(await server.outboundWebhookWorker.drainOnce(), 0);

		const delivery = await getDeliveryRow(
			createSubscriptionPayload.subscription.id,
		);
		assert.ok(delivery, "expected delivery row");
		assert.strictEqual(delivery.attemptCount, 1);
		assert.strictEqual(delivery.lastStatus, "failed");
		assert.strictEqual(delivery.lastResponseStatusCode, 400);
		assert.strictEqual(hookServer.requests.length, 1);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
		await hookServer.close();
		restoreEnv();
	}
});
