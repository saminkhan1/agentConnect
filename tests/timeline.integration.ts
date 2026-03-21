import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";

import { buildServer } from "../src/api/server";
import { db } from "../src/db";
import { agents, apiKeys, events, orgs } from "../src/db/schema";
import { generateApiKeyMaterial } from "../src/domain/api-keys";
import { EVENT_TYPES } from "../src/domain/events";

async function cleanupOrg(orgId: string): Promise<void> {
	await db.delete(events).where(eq(events.orgId, orgId));
	await db.delete(agents).where(eq(agents.orgId, orgId));
	await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
	await db.delete(orgs).where(eq(orgs.id, orgId));
}

void test("integration: derived timeline groups items and paginates without splitting them", async () => {
	const server = await buildServer();
	const orgId = `org_timeline_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;
	const otherOrgId = `org_timeline_other_${crypto.randomUUID()}`;
	const otherRootKey = await generateApiKeyMaterial();
	const otherAuthorization = `Bearer ${otherRootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Timeline Integration Org",
			},
			apiKey: {
				id: rootKey.id,
				keyType: "root",
				keyHash: rootKey.keyHash,
			},
		});
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: otherOrgId,
				name: "Timeline Other Org",
			},
			apiKey: {
				id: otherRootKey.id,
				keyType: "root",
				keyHash: otherRootKey.keyHash,
			},
		});

		const createAgentResponse = await server.inject({
			method: "POST",
			url: "/agents",
			headers: { authorization },
			payload: { name: "Timeline Agent" },
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			resourceId: "res_email_1",
			providerEventId: "evt_timeline_email_1",
			eventType: EVENT_TYPES.EMAIL_RECEIVED,
			occurredAt: "2026-03-06T12:00:00.000Z",
			data: {
				message_id: "msg_thread_1",
				thread_id: "thread_email_1",
				subject: "Timeline thread",
				from: "sender@example.com",
				to: ["agent@example.com"],
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			resourceId: "res_email_1",
			providerEventId: "evt_timeline_email_2",
			eventType: EVENT_TYPES.EMAIL_DELIVERED,
			occurredAt: "2026-03-06T11:00:00.000Z",
			data: {
				message_id: "msg_thread_1_delivery",
				thread_id: "thread_email_1",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			resourceId: "res_card_1",
			providerEventId: "evt_timeline_card_1",
			eventType: EVENT_TYPES.PAYMENT_CARD_AUTHORIZED,
			occurredAt: "2026-03-06T10:30:00.000Z",
			data: {
				authorization_id: "iauth_timeline_1",
				amount: 5000,
				currency: "USD",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			resourceId: "res_card_1",
			providerEventId: "evt_timeline_card_2",
			eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
			occurredAt: "2026-03-06T10:00:00.000Z",
			data: {
				authorization_id: "iauth_timeline_1",
				transaction_id: "ipi_timeline_1",
				amount: 5000,
				currency: "USD",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			resourceId: "res_card_issued",
			providerEventId: "evt_timeline_card_issued",
			eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
			occurredAt: "2026-03-06T09:00:00.000Z",
			data: {
				card_id: "ic_timeline_1",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			resourceId: "res_email_2",
			providerEventId: "evt_timeline_email_3",
			eventType: EVENT_TYPES.EMAIL_SENT,
			occurredAt: "2026-03-06T08:00:00.000Z",
			data: {
				message_id: "msg_unthreaded_1",
				from: "agent@example.com",
				to: ["user@example.com"],
				subject: "Standalone email",
			},
		});

		const firstPageResponse = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/timeline?limit=2`,
			headers: { authorization },
		});
		assert.strictEqual(firstPageResponse.statusCode, 200);
		const firstPagePayload = JSON.parse(firstPageResponse.payload) as {
			items: Array<{
				id: string;
				kind: string;
				groupKey: string;
				latestEventType: string;
				events: Array<{ eventType: string }>;
			}>;
			nextCursor: string | null;
		};

		assert.strictEqual(firstPagePayload.items.length, 2);
		assert.strictEqual(firstPagePayload.items[0].kind, "email_thread");
		assert.strictEqual(firstPagePayload.items[0].groupKey, "thread_email_1");
		assert.deepStrictEqual(
			firstPagePayload.items[0].events.map((event) => event.eventType),
			[EVENT_TYPES.EMAIL_RECEIVED, EVENT_TYPES.EMAIL_DELIVERED],
		);
		assert.strictEqual(firstPagePayload.items[1].kind, "card_activity");
		assert.strictEqual(firstPagePayload.items[1].groupKey, "iauth_timeline_1");
		assert.deepStrictEqual(
			firstPagePayload.items[1].events.map((event) => event.eventType),
			[EVENT_TYPES.PAYMENT_CARD_AUTHORIZED, EVENT_TYPES.PAYMENT_CARD_SETTLED],
		);
		assert.ok(firstPagePayload.nextCursor);

		const nextCursor = firstPagePayload.nextCursor;
		if (!nextCursor) {
			throw new Error("Expected nextCursor for the first timeline page");
		}

		const secondPageResponse = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/timeline?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
			headers: { authorization },
		});
		assert.strictEqual(secondPageResponse.statusCode, 200);
		const secondPagePayload = JSON.parse(secondPageResponse.payload) as {
			items: Array<{
				kind: string;
				latestEventType: string;
				groupKey: string;
				events: Array<{ eventType: string }>;
			}>;
			nextCursor: string | null;
		};

		assert.strictEqual(secondPagePayload.items.length, 2);
		assert.deepStrictEqual(
			secondPagePayload.items.map((item) => item.latestEventType),
			[EVENT_TYPES.PAYMENT_CARD_ISSUED, EVENT_TYPES.EMAIL_SENT],
		);
		assert.ok(secondPagePayload.items.every((item) => item.kind === "event"));
		assert.ok(
			secondPagePayload.items.every(
				(item) =>
					item.groupKey !== "thread_email_1" &&
					item.groupKey !== "iauth_timeline_1",
			),
		);
		assert.strictEqual(secondPagePayload.nextCursor, null);

		const crossOrgResponse = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/timeline`,
			headers: { authorization: otherAuthorization },
		});
		assert.strictEqual(crossOrgResponse.statusCode, 404);
	} finally {
		await cleanupOrg(orgId);
		await cleanupOrg(otherOrgId);
		await server.close();
	}
});

void test("integration: derived timeline folds send events without an initial thread_id into threaded email items", async () => {
	const server = await buildServer();
	const orgId = `org_timeline_missing_thread_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Timeline Missing Thread Org",
			},
			apiKey: {
				id: rootKey.id,
				keyType: "root",
				keyHash: rootKey.keyHash,
			},
		});

		const createAgentResponse = await server.inject({
			method: "POST",
			url: "/agents",
			headers: { authorization },
			payload: { name: "Timeline Missing Thread Agent" },
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			resourceId: "res_email_missing_thread",
			eventType: EVENT_TYPES.EMAIL_SENT,
			occurredAt: "2026-03-06T10:00:00.000Z",
			data: {
				message_id: "msg_missing_thread_1",
				from: "agent@example.com",
				to: ["user@example.com"],
				subject: "Send without initial thread id",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			resourceId: "res_email_missing_thread",
			providerEventId: "evt_timeline_delivery_missing_thread_1",
			eventType: EVENT_TYPES.EMAIL_DELIVERED,
			occurredAt: "2026-03-06T11:00:00.000Z",
			data: {
				message_id: "msg_missing_thread_1",
				thread_id: "thread_missing_initial_1",
			},
		});

		const response = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/timeline`,
			headers: { authorization },
		});
		assert.strictEqual(response.statusCode, 200);
		const payload = JSON.parse(response.payload) as {
			items: Array<{
				kind: string;
				groupKey: string;
				eventCount: number;
				events: Array<{ eventType: string }>;
			}>;
		};

		assert.strictEqual(payload.items.length, 1);
		assert.strictEqual(payload.items[0].kind, "email_thread");
		assert.strictEqual(payload.items[0].groupKey, "thread_missing_initial_1");
		assert.strictEqual(payload.items[0].eventCount, 2);
		assert.deepStrictEqual(
			payload.items[0].events.map((event) => event.eventType),
			[EVENT_TYPES.EMAIL_DELIVERED, EVENT_TYPES.EMAIL_SENT],
		);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});

void test("integration: derived timeline preserves refund amounts in card activity summaries", async () => {
	const server = await buildServer();
	const orgId = `org_timeline_refund_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Timeline Refund Org",
			},
			apiKey: {
				id: rootKey.id,
				keyType: "root",
				keyHash: rootKey.keyHash,
			},
		});

		const createAgentResponse = await server.inject({
			method: "POST",
			url: "/agents",
			headers: { authorization },
			payload: { name: "Timeline Refund Agent" },
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const agentId = (
			JSON.parse(createAgentResponse.payload) as { agent: { id: string } }
		).agent.id;

		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			resourceId: "res_card_refund",
			providerEventId: "evt_timeline_refund_auth",
			eventType: EVENT_TYPES.PAYMENT_CARD_AUTHORIZED,
			occurredAt: "2026-03-06T10:00:00.000Z",
			data: {
				authorization_id: "iauth_timeline_refund_1",
				amount: 5000,
				currency: "USD",
			},
		});
		await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "stripe",
			resourceId: "res_card_refund",
			providerEventId: "evt_timeline_refund_txn",
			eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
			occurredAt: "2026-03-06T11:00:00.000Z",
			data: {
				authorization_id: "iauth_timeline_refund_1",
				transaction_id: "ipi_timeline_refund_1",
				amount: -2500,
				currency: "USD",
				transaction_type: "refund",
			},
		});

		const response = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/timeline`,
			headers: { authorization },
		});
		assert.strictEqual(response.statusCode, 200);
		const payload = JSON.parse(response.payload) as {
			items: Array<{
				kind: string;
				latestEventType: string;
				summary: {
					authorizationId: string | null;
					transactionId: string | null;
					amount: number | null;
					currency: string | null;
				};
				events: Array<{ eventType: string; data: Record<string, unknown> }>;
			}>;
		};

		assert.strictEqual(payload.items.length, 1);
		assert.strictEqual(payload.items[0].kind, "card_activity");
		assert.strictEqual(
			payload.items[0].latestEventType,
			EVENT_TYPES.PAYMENT_CARD_SETTLED,
		);
		assert.strictEqual(
			payload.items[0].summary.authorizationId,
			"iauth_timeline_refund_1",
		);
		assert.strictEqual(
			payload.items[0].summary.transactionId,
			"ipi_timeline_refund_1",
		);
		assert.strictEqual(payload.items[0].summary.amount, -2500);
		assert.strictEqual(payload.items[0].summary.currency, "USD");
		assert.strictEqual(
			payload.items[0].events[0].eventType,
			EVENT_TYPES.PAYMENT_CARD_SETTLED,
		);
		assert.strictEqual(payload.items[0].events[0].data.amount, -2500);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});
