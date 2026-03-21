import assert from "node:assert";
import test from "node:test";
import { z } from "zod";

import { buildServer } from "../src/api/server";
import {
	EVENT_TYPES,
	eventTypeSchema,
	validateEventData,
} from "../src/domain/events";
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

const listEventsResponseSchema = z.object({
	events: z.array(
		z.object({
			id: z.uuid(),
			orgId: z.string(),
			agentId: z.string(),
			resourceId: z.string().nullable(),
			provider: z.string(),
			providerEventId: z.string().nullable(),
			eventType: eventTypeSchema,
			occurredAt: z.iso.datetime(),
			idempotencyKey: z.string().nullable(),
			data: z.record(z.string(), z.unknown()),
			ingestedAt: z.iso.datetime(),
		}),
	),
	nextCursor: z.string().nullable(),
});

void test("event registry accepts canonical email payloads with extra provider metadata", () => {
	const parsedPayload = validateEventData(EVENT_TYPES.EMAIL_SENT, {
		message_id: "msg_123",
		thread_id: "thr_123",
		provider_message_state: "queued",
	});

	assert.strictEqual(parsedPayload.message_id, "msg_123");
	assert.strictEqual(parsedPayload.provider_message_state, "queued");
});

void test("event registry rejects unsupported event types", () => {
	const result = eventTypeSchema.safeParse("email.unknown");

	assert.strictEqual(result.success, false);
});

void test("event registry enforces required canonical card fields", () => {
	assert.throws(() => {
		validateEventData(EVENT_TYPES.PAYMENT_CARD_SETTLED, {
			amount: 12,
			currency: "USD",
		});
	});
});

void test("event registry accepts signed settlement amounts for card refunds", () => {
	const parsedPayload = validateEventData(EVENT_TYPES.PAYMENT_CARD_SETTLED, {
		transaction_id: "ipi_refund_001",
		authorization_id: "iauth_001",
		amount: -12,
		currency: "USD",
		transaction_type: "refund",
	});

	assert.strictEqual(parsedPayload.amount, -12);
	assert.strictEqual(parsedPayload.transaction_type, "refund");
});

void test("GET /agents/:id/events returns 404 when the scoped agent does not exist", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_missing/events",
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

void test("GET /agents/:id/events returns 400 for an invalid cursor after agent lookup", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(buildAgentRecord()),
	});
	const restoreEventsDal = installEventsDalMock({
		listByAgent: () => Promise.resolve([]),
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/events?cursor=not-a-valid-cursor",
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
		restoreEventsDal();
		await server.close();
	}
});

void test("GET /agents/:id/events returns 400 when cursor id is not a UUID", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(buildAgentRecord()),
	});
	const restoreEventsDal = installEventsDalMock({
		listByAgent: () => Promise.resolve([]),
	});
	const malformedCursor = Buffer.from(
		JSON.stringify({
			occurredAt: "2026-03-05T00:00:00.000Z",
			id: "not-a-uuid",
		}),
	).toString("base64url");

	try {
		const response = await server.inject({
			method: "GET",
			url: `/agents/agt_123/events?cursor=${encodeURIComponent(malformedCursor)}`,
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
		restoreEventsDal();
		await server.close();
	}
});

void test("GET /agents/:id/events rejects impossible ISO datetimes", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/events?since=2026-02-30T00:00:00.000Z",
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

void test("GET /agents/:id/events applies filters and returns an opaque nextCursor", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const capturedCalls: Array<{
		agentId: string;
		options: {
			eventType?: string;
			since?: Date;
			until?: Date;
			cursor?: { occurredAt: Date; id: string };
			limit: number;
		};
	}> = [];
	const firstEvent = buildEventRecord({
		id: "11111111-1111-4111-8111-111111111111",
		occurredAt: new Date("2026-03-02T12:00:00.000Z"),
	});
	const secondEvent = buildEventRecord({
		id: "22222222-2222-4222-8222-222222222222",
		occurredAt: new Date("2026-03-02T11:00:00.000Z"),
		providerEventId: "evt_provider_2",
	});
	const restoreAgentsDal = installAgentsDalMock({
		findById: () => Promise.resolve(buildAgentRecord()),
	});
	const restoreEventsDal = installEventsDalMock({
		listByAgent: (agentId, options) => {
			capturedCalls.push({ agentId, options });
			return Promise.resolve([firstEvent, secondEvent]);
		},
	});

	try {
		const response = await server.inject({
			method: "GET",
			url: "/agents/agt_123/events?type=email.delivered&since=2026-03-01T00:00:00.000Z&until=2026-03-03T00:00:00.000Z&limit=1",
			headers: {
				authorization: authorizationHeader,
			},
		});

		assert.strictEqual(response.statusCode, 200);
		const payload = listEventsResponseSchema.parse(
			JSON.parse(response.payload),
		);
		assert.strictEqual(payload.events.length, 1);
		assert.strictEqual(payload.events[0].id, firstEvent.id);
		assert.ok(payload.nextCursor);

		assert.strictEqual(capturedCalls.length, 1);
		assert.strictEqual(capturedCalls[0].agentId, "agt_123");
		assert.strictEqual(
			capturedCalls[0].options.eventType,
			EVENT_TYPES.EMAIL_DELIVERED,
		);
		assert.strictEqual(capturedCalls[0].options.limit, 2);
		assert.strictEqual(
			capturedCalls[0].options.since?.toISOString(),
			"2026-03-01T00:00:00.000Z",
		);
		assert.strictEqual(
			capturedCalls[0].options.until?.toISOString(),
			"2026-03-03T00:00:00.000Z",
		);
	} finally {
		restore();
		restoreAgentsDal();
		restoreEventsDal();
		await server.close();
	}
});
