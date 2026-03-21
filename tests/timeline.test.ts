import assert from "node:assert";
import test from "node:test";

import { z } from "zod";
import {
	listAgentTimelineResponseSchema,
	timelineItemResponseSchema,
} from "../src/api/schemas/timeline";
import { buildServer } from "../src/api/server";
import { EVENT_TYPES } from "../src/domain/events";
import { buildTimelineItem } from "../src/domain/timeline";
import {
	buildAgentRecord,
	buildEventRecord,
	installAgentsDalMock,
	installAuthApiKey,
	installEventsDalMock,
} from "./helpers";

const errorResponseSchema = z.object({
	message: z.string(),
});

void test("buildTimelineItem creates an email_thread summary with de-duped recipients", () => {
	const newerEvent = buildEventRecord({
		id: "22222222-2222-4222-8222-222222222222",
		occurredAt: new Date("2026-03-03T12:00:00.000Z"),
		data: {
			message_id: "msg_2",
			thread_id: "thread_1",
			subject: "Thread subject",
			from: "newer@example.com",
			to: ["agent@example.com", "ops@example.com"],
		},
	});
	const olderEvent = buildEventRecord({
		occurredAt: new Date("2026-03-03T11:00:00.000Z"),
		providerEventId: "evt_provider_2",
		data: {
			message_id: "msg_1",
			thread_id: "thread_1",
			to: ["agent@example.com", "team@example.com"],
		},
	});

	const item = buildTimelineItem("email_thread", "thread_1", [
		olderEvent,
		newerEvent,
	]);
	assert.strictEqual(item.kind, "email_thread");
	assert.strictEqual(item.summary.kind, "email_thread");
	assert.strictEqual(item.summary.value.threadId, "thread_1");
	assert.strictEqual(item.summary.value.subject, "Thread subject");
	assert.strictEqual(item.summary.value.from, "newer@example.com");
	assert.deepStrictEqual(item.summary.value.to, [
		"agent@example.com",
		"ops@example.com",
		"team@example.com",
	]);
	assert.deepStrictEqual(
		item.events.map((event) => event.id),
		[newerEvent.id, olderEvent.id],
	);
});

void test("buildTimelineItem creates a card_activity summary from auth plus settle events", () => {
	const authorizationEvent = buildEventRecord({
		id: "33333333-3333-4333-8333-333333333333",
		provider: "stripe",
		resourceId: "res_card_123",
		eventType: EVENT_TYPES.PAYMENT_CARD_AUTHORIZED,
		occurredAt: new Date("2026-03-03T10:00:00.000Z"),
		data: {
			authorization_id: "iauth_1",
			amount: 5000,
			currency: "USD",
		},
	});
	const settlementEvent = buildEventRecord({
		id: "44444444-4444-4444-8444-444444444444",
		provider: "stripe",
		resourceId: "res_card_123",
		eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
		occurredAt: new Date("2026-03-03T11:00:00.000Z"),
		data: {
			authorization_id: "iauth_1",
			transaction_id: "ipi_1",
			amount: 5000,
			currency: "USD",
		},
	});

	const item = buildTimelineItem("card_activity", "iauth_1", [
		authorizationEvent,
		settlementEvent,
	]);
	assert.strictEqual(item.kind, "card_activity");
	assert.strictEqual(item.summary.kind, "card_activity");
	assert.strictEqual(item.summary.value.authorizationId, "iauth_1");
	assert.strictEqual(item.summary.value.transactionId, "ipi_1");
	assert.strictEqual(item.summary.value.amount, 5000);
	assert.strictEqual(item.summary.value.currency, "USD");
	assert.strictEqual(item.latestEventType, EVENT_TYPES.PAYMENT_CARD_SETTLED);
});

void test("buildTimelineItem creates a singleton event summary", () => {
	const issuedEvent = buildEventRecord({
		id: "55555555-5555-4555-8555-555555555555",
		provider: "stripe",
		resourceId: "res_card_issued",
		eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
		data: { card_id: "ic_123" },
	});

	const item = buildTimelineItem("event", issuedEvent.id, [issuedEvent]);
	assert.strictEqual(item.kind, "event");
	assert.strictEqual(item.summary.kind, "event");
	assert.strictEqual(
		item.summary.value.eventType,
		EVENT_TYPES.PAYMENT_CARD_ISSUED,
	);
	timelineItemResponseSchema.parse({
		id: item.id,
		kind: item.kind,
		groupKey: item.groupKey,
		occurredAt: item.occurredAt.toISOString(),
		startedAt: item.startedAt.toISOString(),
		eventCount: item.eventCount,
		resourceId: item.resourceId,
		provider: item.provider,
		latestEventType: item.latestEventType,
		summary: item.summary.value,
		events: item.events.map((event) => ({
			id: event.id,
			orgId: event.orgId,
			agentId: event.agentId,
			resourceId: event.resourceId,
			provider: event.provider,
			providerEventId: event.providerEventId,
			eventType: event.eventType,
			occurredAt: event.occurredAt.toISOString(),
			idempotencyKey: event.idempotencyKey,
			data: event.data,
			ingestedAt: event.ingestedAt.toISOString(),
		})),
	});
});

void test("GET /agents/:id/timeline returns 404 when the scoped agent does not exist", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_missing/timeline",
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 404);
		const payload = errorResponseSchema.parse(JSON.parse(response.payload));
		assert.strictEqual(payload.message, "Agent not found");
	} finally {
		restore();
		restoreAgentsDal();
		await server.close();
	}
});

void test("GET /agents/:id/timeline returns 400 for an invalid cursor after agent lookup", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(buildAgentRecord()),
	});
	const invalidCursor = Buffer.from(
		JSON.stringify({
			occurredAt: "2026-03-05T00:00:00.000Z",
			id: "invalid-item-id",
		}),
	).toString("base64url");

	try {
		const response = await server.inject({
			method: "GET",
			url: `/agents/agt_123/timeline?cursor=${encodeURIComponent(invalidCursor)}`,
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 400);
		const payload = errorResponseSchema.parse(JSON.parse(response.payload));
		assert.strictEqual(payload.message, "Invalid cursor");
	} finally {
		restore();
		restoreAgentsDal();
		await server.close();
	}
});

void test("GET /agents/:id/timeline rejects impossible ISO datetimes", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/timeline?since=2026-02-30T00:00:00.000Z",
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 400);
		const payload = errorResponseSchema.parse(JSON.parse(response.payload));
		assert.match(payload.message, /Invalid ISO datetime/);
	} finally {
		restore();
		await server.close();
	}
});

void test("GET /agents/:id/timeline rejects `since` values after `until`", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/timeline?since=2026-03-05T00:00:00.000Z&until=2026-03-01T00:00:00.000Z",
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 400);
		const payload = errorResponseSchema.parse(JSON.parse(response.payload));
		assert.match(payload.message, /before or equal to `until`/);
	} finally {
		restore();
		await server.close();
	}
});

void test("GET /agents/:id/timeline returns mixed items and an opaque nextCursor", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(buildAgentRecord()),
	});

	const capturedCalls: Array<{
		agentId: string;
		options: {
			since?: Date;
			until?: Date;
			cursor?: { occurredAt: Date; id: string };
			limit: number;
		};
	}> = [];

	const emailItem = buildTimelineItem("email_thread", "thread_1", [
		buildEventRecord({
			id: "66666666-6666-4666-8666-666666666666",
			occurredAt: new Date("2026-03-04T12:00:00.000Z"),
			data: {
				message_id: "msg_thread_1",
				thread_id: "thread_1",
				subject: "Timeline thread",
				from: "timeline@example.com",
				to: ["agent@example.com"],
			},
		}),
		buildEventRecord({
			id: "77777777-7777-4777-8777-777777777777",
			providerEventId: "evt_provider_7",
			occurredAt: new Date("2026-03-04T11:00:00.000Z"),
			eventType: EVENT_TYPES.EMAIL_DELIVERED,
			data: {
				message_id: "msg_thread_1_delivery",
				thread_id: "thread_1",
			},
		}),
	]);
	const standaloneItem = buildTimelineItem("event", "standalone_1", [
		buildEventRecord({
			id: "88888888-8888-4888-8888-888888888888",
			provider: "stripe",
			resourceId: "res_card_123",
			eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
			occurredAt: new Date("2026-03-04T10:00:00.000Z"),
			data: { card_id: "ic_123" },
		}),
	]);

	const restoreEventsDal = installEventsDalMock({
		listTimelineByAgent: (agentId, options) => {
			capturedCalls.push({ agentId, options });
			return Promise.resolve([emailItem, standaloneItem]);
		},
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/timeline?since=2026-03-01T00:00:00.000Z&until=2026-03-05T00:00:00.000Z&limit=1",
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 200);
		const payload = listAgentTimelineResponseSchema.parse(
			JSON.parse(response.payload),
		);
		assert.strictEqual(payload.items.length, 1);
		assert.strictEqual(payload.items[0].kind, "email_thread");
		assert.ok(payload.nextCursor);

		assert.strictEqual(capturedCalls.length, 1);
		assert.strictEqual(capturedCalls[0].agentId, "agt_123");
		assert.strictEqual(capturedCalls[0].options.limit, 2);
		assert.strictEqual(
			capturedCalls[0].options.since?.toISOString(),
			"2026-03-01T00:00:00.000Z",
		);
		assert.strictEqual(
			capturedCalls[0].options.until?.toISOString(),
			"2026-03-05T00:00:00.000Z",
		);
	} finally {
		restore();
		restoreAgentsDal();
		restoreEventsDal();
		await server.close();
	}
});
