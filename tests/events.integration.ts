import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { buildServer } from '../src/api/server';
import { db } from '../src/db';
import { agents, apiKeys, events, orgs } from '../src/db/schema';
import { EVENT_TYPES } from '../src/domain/events';
import { generateApiKeyMaterial } from '../src/domain/api-keys';

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
}

function sortEventsDescending<T extends { id: string; occurredAt: Date }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const occurredAtDiff = right.occurredAt.getTime() - left.occurredAt.getTime();
    if (occurredAtDiff !== 0) {
      return occurredAtDiff;
    }

    return right.id.localeCompare(left.id);
  });
}

void test('integration: EventWriter idempotency and events query pagination work end-to-end', async () => {
  const server = await buildServer();
  const orgId = `org_evt_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: {
        id: orgId,
        name: 'Events Integration Org',
      },
      apiKey: {
        id: rootKey.id,
        keyType: 'root',
        keyHash: rootKey.keyHash,
      },
    });

    const createAgentResponse = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: {
        authorization,
      },
      payload: {
        name: 'Events Integration Agent',
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
      provider: 'agentmail',
      providerEventId: 'provider_evt_1',
      eventType: EVENT_TYPES.EMAIL_SENT,
      occurredAt: '2026-03-05T09:00:00.000Z',
      data: {
        message_id: 'msg_provider_1',
        thread_id: 'thread_provider_1',
      },
    });
    const duplicateProviderWrite = await server.eventWriter.writeEvent({
      orgId,
      agentId,
      provider: 'agentmail',
      providerEventId: 'provider_evt_1',
      eventType: EVENT_TYPES.EMAIL_SENT,
      occurredAt: '2026-03-05T10:00:00.000Z',
      data: {
        message_id: 'msg_provider_changed',
      },
    });

    assert.strictEqual(firstProviderWrite.wasCreated, true);
    assert.strictEqual(duplicateProviderWrite.wasCreated, false);
    assert.strictEqual(duplicateProviderWrite.event.id, firstProviderWrite.event.id);
    assert.deepStrictEqual(duplicateProviderWrite.event.data, firstProviderWrite.event.data);

    const firstIdempotentWrite = await server.eventWriter.writeEvent({
      orgId,
      agentId,
      provider: 'agentmail',
      providerEventId: 'provider_evt_2',
      idempotencyKey: 'idem_1',
      eventType: EVENT_TYPES.EMAIL_RECEIVED,
      occurredAt: '2026-03-05T10:30:00.000Z',
      data: {
        message_id: 'msg_idem_1',
      },
    });
    const duplicateIdempotentWrite = await server.eventWriter.writeEvent({
      orgId,
      agentId,
      provider: 'agentmail',
      providerEventId: 'provider_evt_3',
      idempotencyKey: 'idem_1',
      eventType: EVENT_TYPES.EMAIL_RECEIVED,
      occurredAt: '2026-03-05T10:45:00.000Z',
      data: {
        message_id: 'msg_idem_changed',
      },
    });

    assert.strictEqual(firstIdempotentWrite.wasCreated, true);
    assert.strictEqual(duplicateIdempotentWrite.wasCreated, false);
    assert.strictEqual(duplicateIdempotentWrite.event.id, firstIdempotentWrite.event.id);
    assert.strictEqual(duplicateIdempotentWrite.event.providerEventId, 'provider_evt_2');

    const deliveredEvents = await Promise.all([
      server.eventWriter.writeEvent({
        orgId,
        agentId,
        provider: 'agentmail',
        providerEventId: 'provider_evt_4',
        eventType: EVENT_TYPES.EMAIL_DELIVERED,
        occurredAt: '2026-03-05T12:00:00.000Z',
        data: {
          message_id: 'msg_delivered_1',
          thread_id: 'thread_delivered',
        },
      }),
      server.eventWriter.writeEvent({
        orgId,
        agentId,
        provider: 'agentmail',
        providerEventId: 'provider_evt_5',
        eventType: EVENT_TYPES.EMAIL_DELIVERED,
        occurredAt: '2026-03-05T12:00:00.000Z',
        data: {
          message_id: 'msg_delivered_2',
          thread_id: 'thread_delivered',
        },
      }),
      server.eventWriter.writeEvent({
        orgId,
        agentId,
        provider: 'agentmail',
        providerEventId: 'provider_evt_6',
        eventType: EVENT_TYPES.EMAIL_DELIVERED,
        occurredAt: '2026-03-05T11:00:00.000Z',
        data: {
          message_id: 'msg_delivered_3',
          thread_id: 'thread_delivered',
        },
      }),
    ]);

    const expectedOrder = sortEventsDescending(deliveredEvents.map((result) => result.event));

    const firstPageResponse = await server.inject({
      method: 'GET',
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
      throw new Error('Expected nextCursor for paginated events response');
    }

    const secondPageResponse = await server.inject({
      method: 'GET',
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

void test('integration: batch ingestion dedupes and accepts nullable optional fields', async () => {
  const server = await buildServer();
  const orgId = `org_evt_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: {
        id: orgId,
        name: 'Batch Events Integration Org',
      },
      apiKey: {
        id: rootKey.id,
        keyType: 'root',
        keyHash: rootKey.keyHash,
      },
    });

    const createAgentResponse = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: {
        authorization,
      },
      payload: {
        name: 'Batch Events Integration Agent',
      },
    });
    assert.strictEqual(createAgentResponse.statusCode, 201);
    const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
      agent: { id: string };
    };
    const agentId = createAgentPayload.agent.id;

    const ingestedEvents = await server.ingestProviderEvents('agentmail', [
      {
        orgId,
        agentId,
        resourceId: null,
        providerEventId: null,
        idempotencyKey: 'batch_idem_1',
        eventType: EVENT_TYPES.EMAIL_RECEIVED,
        occurredAt: '2026-03-05T13:00:00.000Z',
        data: {
          message_id: 'msg_batch_1',
        },
      },
      {
        orgId,
        agentId,
        resourceId: null,
        providerEventId: null,
        idempotencyKey: 'batch_idem_1',
        eventType: EVENT_TYPES.EMAIL_RECEIVED,
        occurredAt: '2026-03-05T13:05:00.000Z',
        data: {
          message_id: 'msg_batch_2',
        },
      },
    ]);

    assert.strictEqual(ingestedEvents.length, 2);
    assert.strictEqual(ingestedEvents[0].wasCreated, true);
    assert.strictEqual(ingestedEvents[1].wasCreated, false);
    assert.strictEqual(ingestedEvents[1].event.id, ingestedEvents[0].event.id);
    assert.strictEqual(ingestedEvents[0].event.resourceId, null);
    assert.strictEqual(ingestedEvents[0].event.providerEventId, null);
    assert.strictEqual(ingestedEvents[0].event.idempotencyKey, 'batch_idem_1');

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].resourceId, null);
    assert.strictEqual(storedEvents[0].providerEventId, null);
    assert.strictEqual(storedEvents[0].idempotencyKey, 'batch_idem_1');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});
