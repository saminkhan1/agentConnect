import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";

import { and, eq, or } from "drizzle-orm";

import { buildServer } from "../src/api/server";
import { db } from "../src/db";
import { agents, apiKeys, events, orgs } from "../src/db/schema";
import { generateApiKeyMaterial } from "../src/domain/api-keys";
import {
	EventBatchTooLargeError,
	MAX_INGEST_BATCH_SIZE,
} from "../src/domain/event-writer";
import { EVENT_TYPES } from "../src/domain/events";

async function cleanupOrg(orgId: string): Promise<void> {
	await db.delete(events).where(eq(events.orgId, orgId));
	await db.delete(agents).where(eq(agents.orgId, orgId));
	await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
	await db.delete(orgs).where(eq(orgs.id, orgId));
}

function sortEventsDescending<T extends { id: string; occurredAt: Date }>(
	items: T[],
): T[] {
	return [...items].sort((left, right) => {
		const occurredAtDiff =
			right.occurredAt.getTime() - left.occurredAt.getTime();
		if (occurredAtDiff !== 0) {
			return occurredAtDiff;
		}

		return right.id.localeCompare(left.id);
	});
}

void test("integration: EventWriter idempotency and events query pagination work end-to-end", async () => {
	const server = await buildServer();
	const orgId = `org_evt_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Events Integration Org",
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
			headers: {
				authorization,
			},
			payload: {
				name: "Events Integration Agent",
			},
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		const firstProviderWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: "provider_evt_1",
			eventType: EVENT_TYPES.EMAIL_SENT,
			occurredAt: "2026-03-05T09:00:00.000Z",
			data: {
				message_id: "msg_provider_1",
				thread_id: "thread_provider_1",
			},
		});
		const duplicateProviderWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: "provider_evt_1",
			eventType: EVENT_TYPES.EMAIL_SENT,
			occurredAt: "2026-03-05T10:00:00.000Z",
			data: {
				message_id: "msg_provider_changed",
			},
		});

		assert.strictEqual(firstProviderWrite.wasCreated, true);
		assert.strictEqual(duplicateProviderWrite.wasCreated, false);
		assert.strictEqual(
			duplicateProviderWrite.event.id,
			firstProviderWrite.event.id,
		);
		assert.deepStrictEqual(
			duplicateProviderWrite.event.data,
			firstProviderWrite.event.data,
		);

		const providerWithBackfilledIdempotencyWrite =
			await server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				providerEventId: "provider_evt_1",
				idempotencyKey: "idem_provider_1",
				eventType: EVENT_TYPES.EMAIL_SENT,
				occurredAt: "2026-03-05T10:15:00.000Z",
				data: {
					message_id: "msg_provider_retry",
				},
			});
		const idempotencyOnlyRetry = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			idempotencyKey: "idem_provider_1",
			eventType: EVENT_TYPES.EMAIL_SENT,
			occurredAt: "2026-03-05T10:20:00.000Z",
			data: {
				message_id: "msg_provider_retry_2",
			},
		});

		assert.strictEqual(
			providerWithBackfilledIdempotencyWrite.wasCreated,
			false,
		);
		assert.strictEqual(
			providerWithBackfilledIdempotencyWrite.event.id,
			firstProviderWrite.event.id,
		);
		assert.strictEqual(
			providerWithBackfilledIdempotencyWrite.event.idempotencyKey,
			"idem_provider_1",
		);

		assert.strictEqual(idempotencyOnlyRetry.wasCreated, false);
		assert.strictEqual(
			idempotencyOnlyRetry.event.id,
			firstProviderWrite.event.id,
		);
		assert.strictEqual(
			idempotencyOnlyRetry.event.providerEventId,
			"provider_evt_1",
		);
		assert.strictEqual(
			idempotencyOnlyRetry.event.idempotencyKey,
			"idem_provider_1",
		);

		const firstIdempotentWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: "provider_evt_2",
			idempotencyKey: "idem_1",
			eventType: EVENT_TYPES.EMAIL_RECEIVED,
			occurredAt: "2026-03-05T10:30:00.000Z",
			data: {
				message_id: "msg_idem_1",
			},
		});
		const duplicateIdempotentWrite = await server.eventWriter.writeEvent({
			orgId,
			agentId,
			provider: "agentmail",
			providerEventId: "provider_evt_3",
			idempotencyKey: "idem_1",
			eventType: EVENT_TYPES.EMAIL_RECEIVED,
			occurredAt: "2026-03-05T10:45:00.000Z",
			data: {
				message_id: "msg_idem_changed",
			},
		});

		assert.strictEqual(firstIdempotentWrite.wasCreated, true);
		assert.strictEqual(duplicateIdempotentWrite.wasCreated, false);
		assert.strictEqual(
			duplicateIdempotentWrite.event.id,
			firstIdempotentWrite.event.id,
		);
		assert.strictEqual(
			duplicateIdempotentWrite.event.providerEventId,
			"provider_evt_2",
		);

		const deliveredEvents = await Promise.all([
			server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				providerEventId: "provider_evt_4",
				eventType: EVENT_TYPES.EMAIL_DELIVERED,
				occurredAt: "2026-03-05T12:00:00.000Z",
				data: {
					message_id: "msg_delivered_1",
					thread_id: "thread_delivered",
				},
			}),
			server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				providerEventId: "provider_evt_5",
				eventType: EVENT_TYPES.EMAIL_DELIVERED,
				occurredAt: "2026-03-05T12:00:00.000Z",
				data: {
					message_id: "msg_delivered_2",
					thread_id: "thread_delivered",
				},
			}),
			server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				providerEventId: "provider_evt_6",
				eventType: EVENT_TYPES.EMAIL_DELIVERED,
				occurredAt: "2026-03-05T11:00:00.000Z",
				data: {
					message_id: "msg_delivered_3",
					thread_id: "thread_delivered",
				},
			}),
		]);

		const expectedOrder = sortEventsDescending(
			deliveredEvents.map((result) => result.event),
		);

		const firstPageResponse = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/events?type=email.delivered&since=2026-03-05T11:00:00.000Z&until=2026-03-05T12:00:00.000Z&limit=2`,
			headers: {
				authorization,
			},
		});
		assert.strictEqual(firstPageResponse.statusCode, 200);
		const firstPagePayload = JSON.parse(firstPageResponse.payload) as {
			events: Array<{ id: string }>;
			nextCursor: string | null;
		};
		assert.deepStrictEqual(
			firstPagePayload.events.map((event) => event.id),
			expectedOrder.slice(0, 2).map((event) => event.id),
		);
		assert.ok(firstPagePayload.nextCursor);
		const nextCursor = firstPagePayload.nextCursor;
		if (!nextCursor) {
			throw new Error("Expected nextCursor for paginated events response");
		}

		const secondPageResponse = await server.inject({
			method: "GET",
			url: `/agents/${agentId}/events?type=email.delivered&since=2026-03-05T11:00:00.000Z&until=2026-03-05T12:00:00.000Z&limit=2&cursor=${encodeURIComponent(nextCursor)}`,
			headers: {
				authorization,
			},
		});
		assert.strictEqual(secondPageResponse.statusCode, 200);
		const secondPagePayload = JSON.parse(secondPageResponse.payload) as {
			events: Array<{ id: string }>;
			nextCursor: string | null;
		};
		assert.deepStrictEqual(
			secondPagePayload.events.map((event) => event.id),
			expectedOrder.slice(2).map((event) => event.id),
		);
		assert.strictEqual(secondPagePayload.nextCursor, null);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});

void test("integration: batch ingestion dedupes and accepts nullable optional fields", async () => {
	const server = await buildServer();
	const orgId = `org_evt_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Batch Events Integration Org",
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
			headers: {
				authorization,
			},
			payload: {
				name: "Batch Events Integration Agent",
			},
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		const ingestedEvents = await server.eventWriter.ingestProviderEvents(
			"agentmail",
			[
				{
					orgId,
					agentId,
					resourceId: null,
					providerEventId: null,
					idempotencyKey: "batch_idem_1",
					eventType: EVENT_TYPES.EMAIL_RECEIVED,
					occurredAt: "2026-03-05T13:00:00.000Z",
					data: {
						message_id: "msg_batch_1",
					},
				},
				{
					orgId,
					agentId,
					resourceId: null,
					providerEventId: null,
					idempotencyKey: "batch_idem_1",
					eventType: EVENT_TYPES.EMAIL_RECEIVED,
					occurredAt: "2026-03-05T13:05:00.000Z",
					data: {
						message_id: "msg_batch_2",
					},
				},
			],
		);

		assert.strictEqual(ingestedEvents.length, 2);
		assert.strictEqual(ingestedEvents[0].wasCreated, true);
		assert.strictEqual(ingestedEvents[1].wasCreated, false);
		assert.strictEqual(ingestedEvents[1].event.id, ingestedEvents[0].event.id);
		assert.strictEqual(ingestedEvents[0].event.resourceId, null);
		assert.strictEqual(ingestedEvents[0].event.providerEventId, null);
		assert.strictEqual(ingestedEvents[0].event.idempotencyKey, "batch_idem_1");

		const storedEvents = await db
			.select()
			.from(events)
			.where(eq(events.orgId, orgId));
		assert.strictEqual(storedEvents.length, 1);
		assert.strictEqual(storedEvents[0].resourceId, null);
		assert.strictEqual(storedEvents[0].providerEventId, null);
		assert.strictEqual(storedEvents[0].idempotencyKey, "batch_idem_1");
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});

void test("integration: split dedupe key races converge to a single canonical row", async () => {
	const server = await buildServer();
	const orgId = `org_evt_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Split Dedupe Race Org",
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
			headers: {
				authorization,
			},
			payload: {
				name: "Split Dedupe Race Agent",
			},
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		for (let index = 0; index < 12; index += 1) {
			const indexText = String(index);
			const providerEventId = `race_provider_evt_${indexText}`;
			const idempotencyKey = `race_idem_${indexText}`;

			await server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				idempotencyKey,
				eventType: EVENT_TYPES.EMAIL_SENT,
				occurredAt: "2026-03-06T09:00:00.000Z",
				data: {
					message_id: `seed_${indexText}`,
				},
			});

			const [providerAndIdempotencyWrite, providerOnlyWrite] =
				await Promise.all([
					server.eventWriter.writeEvent({
						orgId,
						agentId,
						provider: "agentmail",
						providerEventId,
						idempotencyKey,
						eventType: EVENT_TYPES.EMAIL_SENT,
						occurredAt: "2026-03-06T10:00:00.000Z",
						data: {
							message_id: `provider_and_idempotency_${indexText}`,
						},
					}),
					server.eventWriter.writeEvent({
						orgId,
						agentId,
						provider: "agentmail",
						providerEventId,
						eventType: EVENT_TYPES.EMAIL_SENT,
						occurredAt: "2026-03-06T11:00:00.000Z",
						data: {
							message_id: `provider_only_${indexText}`,
						},
					}),
				]);

			const matchedRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.orgId, orgId),
						or(
							eq(events.providerEventId, providerEventId),
							eq(events.idempotencyKey, idempotencyKey),
						),
					),
				);

			assert.strictEqual(matchedRows.length, 1);
			assert.strictEqual(matchedRows[0].providerEventId, providerEventId);
			assert.strictEqual(matchedRows[0].idempotencyKey, idempotencyKey);

			const followUpProviderWrite = await server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				providerEventId,
				eventType: EVENT_TYPES.EMAIL_SENT,
				data: {
					message_id: `follow_up_provider_${indexText}`,
				},
			});
			const followUpIdempotencyWrite = await server.eventWriter.writeEvent({
				orgId,
				agentId,
				provider: "agentmail",
				idempotencyKey,
				eventType: EVENT_TYPES.EMAIL_SENT,
				data: {
					message_id: `follow_up_idempotency_${indexText}`,
				},
			});

			assert.strictEqual(
				providerAndIdempotencyWrite.event.id,
				matchedRows[0].id,
			);
			assert.strictEqual(providerOnlyWrite.event.orgId, orgId);
			assert.strictEqual(followUpProviderWrite.event.id, matchedRows[0].id);
			assert.strictEqual(followUpIdempotencyWrite.event.id, matchedRows[0].id);
			assert.strictEqual(followUpProviderWrite.wasCreated, false);
			assert.strictEqual(followUpIdempotencyWrite.wasCreated, false);
		}
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});

void test("integration: batch ingestion rejects oversized event arrays", async () => {
	const server = await buildServer();
	const orgId = `org_evt_${crypto.randomUUID()}`;
	const rootKey = await generateApiKeyMaterial();
	const authorization = `Bearer ${rootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: orgId,
				name: "Oversized Batch Org",
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
			headers: {
				authorization,
			},
			payload: {
				name: "Oversized Batch Agent",
			},
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string };
		};
		const agentId = createAgentPayload.agent.id;

		const oversizedItems = Array.from(
			{ length: MAX_INGEST_BATCH_SIZE + 1 },
			(_, index) => {
				const indexText = String(index);
				return {
					orgId,
					agentId,
					providerEventId: `oversized_provider_evt_${indexText}`,
					idempotencyKey: `oversized_idem_${indexText}`,
					eventType: EVENT_TYPES.EMAIL_RECEIVED,
					occurredAt: "2026-03-06T12:00:00.000Z",
					data: {
						message_id: `oversized_${indexText}`,
					},
				};
			},
		);

		await assert.rejects(
			server.eventWriter.ingestProviderEvents("agentmail", oversizedItems),
			(error: unknown) => {
				assert.ok(error instanceof EventBatchTooLargeError);
				assert.strictEqual(error.maxBatchSize, MAX_INGEST_BATCH_SIZE);
				assert.strictEqual(error.batchSize, MAX_INGEST_BATCH_SIZE + 1);
				return true;
			},
		);

		const storedEvents = await db
			.select()
			.from(events)
			.where(eq(events.orgId, orgId));
		assert.strictEqual(storedEvents.length, 0);
	} finally {
		await cleanupOrg(orgId);
		await server.close();
	}
});
