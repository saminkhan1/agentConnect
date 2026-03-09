import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { buildServer } from '../src/api/server';
import { DalFactory, systemDal } from '../src/db/dal';
import type { EventWriter, WriteEventResult } from '../src/domain/event-writer';
import type { AgentMailAdapter } from '../src/adapters/agentmail-adapter';
import type { ParsedWebhookEvent } from '../src/adapters/provider-adapter';
import {
  FIXED_TIMESTAMP,
  ResourceRecord,
  buildAgentRecord,
  installAgentsDalMock,
  installAuthApiKey,
} from './helpers';

const WEBHOOK_SECRET = 'whsec_dGVzdHNlY3JldHZhbHVlZm9ydGVzdHM='; // base64 of "testsecretvaluefortests"

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildResourceRecord(overrides?: Partial<ResourceRecord>): ResourceRecord {
  return {
    id: 'res_123',
    orgId: 'org_123',
    agentId: 'agt_123',
    type: 'email_inbox',
    provider: 'agentmail',
    providerRef: 'agent@agentmail.to',
    providerOrgId: 'pod_test',
    config: {},
    state: 'active',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

function buildFakeEventRecord(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    orgId: 'org_123',
    agentId: 'agt_123',
    resourceId: 'res_123',
    provider: 'agentmail',
    providerEventId: null,
    eventType: 'email.sent' as const,
    occurredAt: FIXED_TIMESTAMP,
    idempotencyKey: null,
    data: { message_id: '', from: 'agent@agentmail.to', to: ['user@example.com'], subject: 'Hi' },
    ingestedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

type EventRecord = ReturnType<typeof buildFakeEventRecord>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function installResourcesDalMock(methods: {
  findActiveByAgentIdAndType?: (
    agentId: string,
    type: string,
    provider: string,
  ) => Promise<ResourceRecord | null>;
  findByAgentId?: (agentId: string) => Promise<ResourceRecord[]>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'resources');
  Object.defineProperty(DalFactory.prototype, 'resources', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'resources', originalDescriptor);
    }
  };
}

function installEventsDalMock(methods: {
  findByIdempotencyKey?: (idempotencyKey: string) => Promise<EventRecord | null>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'events');
  Object.defineProperty(DalFactory.prototype, 'events', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'events', originalDescriptor);
    }
  };
}

function installAgentMailAdapterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<AgentMailAdapter>,
) {
  const original = server.agentMailAdapter;
  server.agentMailAdapter = methods as AgentMailAdapter;
  return () => {
    server.agentMailAdapter = original;
  };
}

function installEventWriterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<EventWriter>,
) {
  const original = server.eventWriter;
  server.eventWriter = methods as EventWriter;
  // Also update webhook processor's internal reference
  server.webhookProcessor = new (server.webhookProcessor.constructor as new (
    ew: EventWriter,
  ) => typeof server.webhookProcessor)(server.eventWriter);
  return () => {
    server.eventWriter = original;
  };
}

// Svix-compatible webhook signature generation
function signTestWebhook(secret: string, msgId: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const toSign = `${msgId}.${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', key).update(toSign).digest('base64');
  return `v1,${sig}`;
}

function buildWebhookHeaders(body: string, secret: string = WEBHOOK_SECRET) {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signTestWebhook(secret, msgId, timestamp, body);
  return {
    'svix-id': msgId,
    'svix-timestamp': timestamp,
    'svix-signature': signature,
    'content-type': 'application/json',
  };
}

function buildWebhookPayload(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    event_type: 'message.received',
    event_id: 'evt_abc123',
    organization_id: 'org_am_123',
    inbox_id: 'agent@agentmail.to',
    message: {
      message_id: 'msg_xyz',
      thread_id: 'thread_1',
      from: 'sender@example.com',
      to: ['agent@agentmail.to'],
      subject: 'Hello',
      timestamp: FIXED_TIMESTAMP.toISOString(),
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// send_email action tests
// ---------------------------------------------------------------------------

void test('POST /agents/:id/actions/send_email returns 404 when agent is archived', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const archivedAgent = buildAgentRecord({ isArchived: true });

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(archivedAgent) });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/send_email',
      headers: { authorization: authorizationHeader },
      payload: { to: ['user@example.com'], subject: 'Hi', text: 'Hello' },
    });

    assert.strictEqual(response.statusCode, 404);
    const body = JSON.parse(response.payload) as { message: string };
    assert.strictEqual(body.message, 'Agent not found');
  } finally {
    restore();
    restoreAgents();
    await server.close();
  }
});

void test('POST /agents/:id/actions/send_email returns 404 when no active agentmail inbox', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(null),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/send_email',
      headers: { authorization: authorizationHeader },
      payload: { to: ['user@example.com'], subject: 'Hi', text: 'Hello' },
    });

    assert.strictEqual(response.statusCode, 404);
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    await server.close();
  }
});

void test('POST /agents/:id/actions/send_email returns 403 when policy blocks recipient', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord({ config: { allowed_domains: ['trusted.com'] } });

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/send_email',
      headers: { authorization: authorizationHeader },
      payload: { to: ['blocked@other.com'], subject: 'Hi', text: 'Hello' },
    });

    assert.strictEqual(response.statusCode, 403);
    const body = JSON.parse(response.payload) as { message: string };
    assert.ok(body.message.includes('blocked@other.com'));
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    await server.close();
  }
});

void test('POST /agents/:id/actions/send_email returns 200 and emits email.sent event', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();
  const fakeEvent = buildFakeEventRecord({ idempotencyKey: 'my-idem-key' });

  const performActionCalls: unknown[] = [];
  const writeEventCalls: unknown[] = [];

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  const restoreEvents = installEventsDalMock({
    findByIdempotencyKey: () => Promise.resolve(null),
  });
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: (_resource, _action, payload) => {
      performActionCalls.push(payload);
      return Promise.resolve({
        message_id: 'msg_sent_123',
        thread_id: 'thread_sent_123',
      });
    },
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({ event: fakeEvent, wasCreated: true } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/send_email',
      headers: { authorization: authorizationHeader },
      payload: {
        to: ['user@example.com'],
        subject: 'Hi',
        text: 'Hello',
        idempotency_key: 'my-idem-key',
      },
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(performActionCalls.length, 1);
    assert.strictEqual(writeEventCalls.length, 1);

    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'email.sent');
    assert.strictEqual(input['idempotencyKey'], 'my-idem-key');
    const data = input['data'] as Record<string, unknown>;
    assert.strictEqual(data['message_id'], 'msg_sent_123');
    assert.strictEqual(data['thread_id'], 'thread_sent_123');
    assert.strictEqual(data['from'], 'agent@agentmail.to');
    assert.deepStrictEqual(data['to'], ['user@example.com']);
    assert.strictEqual(data['subject'], 'Hi');
    assert.strictEqual(typeof data['request_hash'], 'string');

    const payload = JSON.parse(response.payload) as { event: { eventType: string } };
    assert.strictEqual(payload.event.eventType, 'email.sent');
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreEvents();
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Webhook endpoint tests
// ---------------------------------------------------------------------------

void test('POST /webhooks/agentmail returns 401 for missing svix headers', async () => {
  const server = await buildServer();
  const body = buildWebhookPayload();

  const restoreAdapter = installAgentMailAdapterMock(server, {
    verifyWebhook: (_rawBody, _headers) => Promise.resolve(false),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    assert.strictEqual(response.statusCode, 401);
  } finally {
    restoreAdapter();
    await server.close();
  }
});

void test('POST /webhooks/agentmail returns 200 and writes email.received event', async () => {
  const server = await buildServer();
  const bodyStr = buildWebhookPayload();
  const headers = buildWebhookHeaders(bodyStr);
  const resource = buildResourceRecord();

  const writeEventCalls: unknown[] = [];

  // Mock systemDal.findResourceByProviderRef
  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = (_provider, _providerRef) => Promise.resolve(resource);

  const restoreAdapter = installAgentMailAdapterMock(server, {
    verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
    parseWebhook: (_rawBody, _hdrs) =>
      Promise.resolve([
        {
          resourceRef: 'agent@agentmail.to',
          provider: 'agentmail',
          providerEventId: 'evt_abc123',
          eventType: 'email.received',
          occurredAt: FIXED_TIMESTAMP,
          data: {
            message_id: 'msg_xyz',
            thread_id: 'thread_1',
            from: 'sender@example.com',
            to: ['agent@agentmail.to'],
            subject: 'Hello',
          },
        } satisfies ParsedWebhookEvent,
      ]),
  });

  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeEventRecord({ eventType: 'email.received' }),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 1);

    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'email.received');
    assert.strictEqual(input['providerEventId'], 'evt_abc123');

    const data = input['data'] as Record<string, unknown>;
    assert.strictEqual(data['thread_id'], 'thread_1');
    assert.strictEqual(data['from'], 'sender@example.com');
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/agentmail returns 200 for unknown event_type (silently skips)', async () => {
  const server = await buildServer();
  const bodyStr = buildWebhookPayload({ event_type: 'message.unknown_event' });
  const headers = buildWebhookHeaders(bodyStr);

  const writeEventCalls: unknown[] = [];

  const restoreAdapter = installAgentMailAdapterMock(server, {
    verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
    parseWebhook: (_rawBody, _hdrs) => Promise.resolve([]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeEventRecord(),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 0);
  } finally {
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/agentmail deduplication: second call with same event_id → wasCreated false', async () => {
  const server = await buildServer();
  const bodyStr = buildWebhookPayload();
  const headers = buildWebhookHeaders(bodyStr);
  const resource = buildResourceRecord();

  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = (_provider, _providerRef) => Promise.resolve(resource);

  const results = [
    { event: buildFakeEventRecord(), wasCreated: true },
    { event: buildFakeEventRecord(), wasCreated: false },
  ];
  let callCount = 0;

  const restoreAdapter = installAgentMailAdapterMock(server, {
    verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
    parseWebhook: (_rawBody, _hdrs) =>
      Promise.resolve([
        {
          resourceRef: 'agent@agentmail.to',
          provider: 'agentmail',
          providerEventId: 'evt_abc123',
          eventType: 'email.received',
          occurredAt: FIXED_TIMESTAMP,
          data: { message_id: 'msg_xyz' },
        } satisfies ParsedWebhookEvent,
      ]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: () => {
      const result = results[callCount] ?? results[results.length - 1];
      callCount += 1;
      return Promise.resolve(result as WriteEventResult);
    },
  });

  try {
    const r1 = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers,
      payload: bodyStr,
    });
    const r2 = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(r1.statusCode, 200);
    assert.strictEqual(r2.statusCode, 200);
    assert.strictEqual(callCount, 2);
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/agentmail for message.complained writes email.complained event', async () => {
  const server = await buildServer();
  const bodyStr = buildWebhookPayload({ event_type: 'message.complained' });
  const headers = buildWebhookHeaders(bodyStr);
  const resource = buildResourceRecord();

  const writeEventCalls: unknown[] = [];

  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = (_provider, _providerRef) => Promise.resolve(resource);

  const restoreAdapter = installAgentMailAdapterMock(server, {
    verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
    parseWebhook: (_rawBody, _hdrs) =>
      Promise.resolve([
        {
          resourceRef: 'agent@agentmail.to',
          provider: 'agentmail',
          providerEventId: 'evt_complained_1',
          eventType: 'email.complained',
          occurredAt: FIXED_TIMESTAMP,
          data: { message_id: 'msg_xyz' },
        } satisfies ParsedWebhookEvent,
      ]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeEventRecord({ eventType: 'email.complained' }),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/agentmail',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 1);

    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'email.complained');
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});
