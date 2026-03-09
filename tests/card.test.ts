import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { buildServer } from '../src/api/server';
import { DalFactory, systemDal } from '../src/db/dal';
import type { EventWriter, WriteEventResult } from '../src/domain/event-writer';
import { StripeAdapter } from '../src/adapters/stripe-adapter';
import type { ParsedWebhookEvent } from '../src/adapters/provider-adapter';
import { ResourceManager } from '../src/domain/resource-manager';
import {
  FIXED_TIMESTAMP,
  ResourceRecord,
  buildAgentRecord,
  installAgentsDalMock,
  installAuthApiKey,
} from './helpers';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildCardResourceRecord(overrides?: Partial<ResourceRecord>): ResourceRecord {
  return {
    id: 'res_card_123',
    orgId: 'org_123',
    agentId: 'agt_123',
    type: 'card',
    provider: 'stripe',
    providerRef: 'ic_test123',
    providerOrgId: null,
    config: { cardholder_id: 'ich_test', last4: '4242', exp_month: 12, exp_year: 2027 },
    state: 'active',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

function buildFakeCardEventRecord(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    orgId: 'org_123',
    agentId: 'agt_123',
    resourceId: 'res_card_123',
    provider: 'stripe',
    providerEventId: null,
    eventType: 'payment.card.issued' as const,
    occurredAt: FIXED_TIMESTAMP,
    idempotencyKey: null,
    data: { card_id: 'ic_test123' },
    ingestedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

type EventRecord = ReturnType<typeof buildFakeCardEventRecord>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function installResourcesDalMock(methods: {
  findById?: (id: string) => Promise<ResourceRecord | null>;
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

function installStripeAdapterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<StripeAdapter>,
) {
  const original = server.stripeAdapter;
  server.stripeAdapter = methods as StripeAdapter;
  return () => {
    server.stripeAdapter = original;
  };
}

function installEventWriterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<EventWriter>,
) {
  const original = server.eventWriter;
  server.eventWriter = methods as EventWriter;
  server.webhookProcessor = new (server.webhookProcessor.constructor as new (
    ew: EventWriter,
  ) => typeof server.webhookProcessor)(server.eventWriter);
  return () => {
    server.eventWriter = original;
  };
}

// Stripe webhook signing: t={ts},v1={HMAC-SHA256(`{ts}.{body}`, secret)}
function buildStripeWebhookHeaders(body: string, secret: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return {
    'stripe-signature': `t=${ts},v1=${sig}`,
    'content-type': 'application/json',
  };
}

function buildAuthorizationWebhookPayload(approved: boolean, overrides?: Record<string, unknown>) {
  return JSON.stringify({
    id: 'evt_auth_001',
    type: 'issuing_authorization.created',
    created: Math.floor(FIXED_TIMESTAMP.getTime() / 1000),
    data: {
      object: {
        id: 'iauth_001',
        card: { id: 'ic_test123' },
        approved,
        amount: 5000,
        currency: 'usd',
      },
    },
    ...overrides,
  });
}

function buildTransactionWebhookPayload(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    id: 'evt_txn_001',
    type: 'issuing_transaction.created',
    created: Math.floor(FIXED_TIMESTAMP.getTime() / 1000),
    data: {
      object: {
        id: 'ipi_001',
        card: 'ic_test123',
        amount: -5000,
        currency: 'usd',
        authorization: 'iauth_001',
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// issue_card action tests
// ---------------------------------------------------------------------------

void test('POST /agents/:id/actions/issue_card returns 404 when agent is archived', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const archivedAgent = buildAgentRecord({ isArchived: true });
  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(archivedAgent) });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: { spending_limits: [{ amount: 5000, interval: 'per_authorization' }] },
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

void test('POST /agents/:id/actions/issue_card returns 500 when Stripe not configured', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });

  // Ensure stripeAdapter is undefined
  const original = server.stripeAdapter;
  server.stripeAdapter = undefined;

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: { spending_limits: [{ amount: 5000, interval: 'per_authorization' }] },
    });

    assert.strictEqual(response.statusCode, 500);
    const body = JSON.parse(response.payload) as { message: string };
    assert.ok(body.message.toLowerCase().includes('stripe'));
  } finally {
    server.stripeAdapter = original;
    restore();
    restoreAgents();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card returns 200 with card details and emits payment.card.issued', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildCardResourceRecord();
  const sensitiveData = {
    number: '4242424242424242',
    cvc: '123',
    exp_month: 12,
    exp_year: 2027,
    last4: '4242',
  };
  const fakeEvent = buildFakeCardEventRecord();

  const writeEventCalls: unknown[] = [];

  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });
  // Ensure stripeAdapter is present (route checks for it before calling resourceManager)
  const restoreAdapter = installStripeAdapterMock(server, {});
  const restoreRM = installResourceManagerMock(server, {
    provision: () => Promise.resolve({ resource, sensitiveData }),
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
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: { spending_limits: [{ amount: 5000, interval: 'per_authorization' }] },
    });

    assert.strictEqual(response.statusCode, 200);

    const body = JSON.parse(response.payload) as {
      resource: { id: string; type: string; provider: string; providerRef: string };
      card: { number: string; cvc: string; exp_month: number; exp_year: number; last4: string };
      event: { eventType: string; data: Record<string, unknown> };
    };

    // Card details returned once
    assert.strictEqual(body.card.number, '4242424242424242');
    assert.strictEqual(body.card.cvc, '123');
    assert.strictEqual(body.card.last4, '4242');

    // Resource has ic_... as providerRef
    assert.strictEqual(body.resource.providerRef, 'ic_test123');
    assert.strictEqual(body.resource.type, 'card');
    assert.strictEqual(body.resource.provider, 'stripe');

    // Event emitted with correct type and card_id (not PAN/CVC)
    assert.strictEqual(writeEventCalls.length, 1);
    const eventInput = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(eventInput['eventType'], 'payment.card.issued');
    const eventData = eventInput['data'] as Record<string, unknown>;
    assert.strictEqual(eventData['card_id'], 'ic_test123');
    assert.ok(!('number' in eventData), 'PAN must not be in event data');
    assert.ok(!('cvc' in eventData), 'CVC must not be in event data');
  } finally {
    restore();
    restoreAgents();
    restoreAdapter();
    restoreRM();
    restoreWriter();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card replays an existing issuance for the same idempotency key', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildCardResourceRecord({
    config: {
      billing_name: agent.name,
      spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
      cardholder_id: 'ich_test',
      last4: '4242',
      exp_month: 12,
      exp_year: 2027,
    },
  });
  const fakeEvent = buildFakeCardEventRecord({
    resourceId: resource.id,
    idempotencyKey: 'idem-card-001',
  });

  let provisionCalls = 0;

  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });
  const restoreEvents = installEventsDalMock({
    findByIdempotencyKey: () => Promise.resolve(fakeEvent),
  });
  const restoreResources = installResourcesDalMock({
    findById: () => Promise.resolve(resource),
  });
  const restoreAdapter = installStripeAdapterMock(server, {});
  const restoreRM = installResourceManagerMock(server, {
    provision: () => {
      provisionCalls += 1;
      return Promise.resolve({ resource });
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        idempotency_key: 'idem-card-001',
      },
    });

    assert.strictEqual(response.statusCode, 200);

    const body = JSON.parse(response.payload) as {
      resource: { id: string };
      card: { number: string | null; cvc: string | null; exp_month: number; exp_year: number };
      event: { eventType: string; idempotencyKey: string | null };
    };

    assert.strictEqual(provisionCalls, 0);
    assert.strictEqual(body.resource.id, resource.id);
    assert.strictEqual(body.card.number, null);
    assert.strictEqual(body.card.cvc, null);
    assert.strictEqual(body.card.exp_month, 12);
    assert.strictEqual(body.card.exp_year, 2027);
    assert.strictEqual(body.event.eventType, 'payment.card.issued');
    assert.strictEqual(body.event.idempotencyKey, 'idem-card-001');
  } finally {
    restore();
    restoreAgents();
    restoreEvents();
    restoreResources();
    restoreAdapter();
    restoreRM();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card replays after an agent rename without requiring Stripe config', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const currentAgent = buildAgentRecord({ name: 'concierge-agent-renamed' });
  const resource = buildCardResourceRecord({
    config: {
      billing_name: 'concierge-agent',
      spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
      cardholder_id: 'ich_test',
      last4: '4242',
      exp_month: 12,
      exp_year: 2027,
    },
  });
  const fakeEvent = buildFakeCardEventRecord({
    resourceId: resource.id,
    idempotencyKey: 'idem-card-rename',
  });

  let provisionCalls = 0;

  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(currentAgent) });
  const restoreEvents = installEventsDalMock({
    findByIdempotencyKey: () => Promise.resolve(fakeEvent),
  });
  const restoreResources = installResourcesDalMock({
    findById: () => Promise.resolve(resource),
  });
  const originalAdapter = server.stripeAdapter;
  server.stripeAdapter = undefined;
  const restoreRM = installResourceManagerMock(server, {
    provision: () => {
      provisionCalls += 1;
      return Promise.resolve({ resource });
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        idempotency_key: 'idem-card-rename',
      },
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(provisionCalls, 0);

    const body = JSON.parse(response.payload) as {
      resource: { id: string };
      event: { idempotencyKey: string | null };
    };
    assert.strictEqual(body.resource.id, resource.id);
    assert.strictEqual(body.event.idempotencyKey, 'idem-card-rename');
  } finally {
    server.stripeAdapter = originalAdapter;
    restore();
    restoreAgents();
    restoreEvents();
    restoreResources();
    restoreRM();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card returns 409 when an org key is already tied to another agent', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  let provisionCalls = 0;

  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });
  const restoreEvents = installEventsDalMock({
    findByIdempotencyKey: () => Promise.resolve(null),
  });
  const restoreResources = installResourcesDalMock({
    findById: () =>
      Promise.resolve(
        buildCardResourceRecord({
          id: 'res_conflict',
          agentId: 'agt_other',
          config: {
            billing_name: agent.name,
            spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
            cardholder_id: 'ich_test',
            last4: '4242',
            exp_month: 12,
            exp_year: 2027,
          },
          state: 'provisioning',
        }),
      ),
  });
  const restoreAdapter = installStripeAdapterMock(server, {});
  const restoreRM = installResourceManagerMock(server, {
    provision: () => {
      provisionCalls += 1;
      return Promise.resolve({ resource: buildCardResourceRecord({ agentId: 'agt_other' }) });
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        idempotency_key: 'idem-card-001',
      },
    });

    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(provisionCalls, 0);
    const body = JSON.parse(response.payload) as { message: string };
    assert.strictEqual(body.message, 'Idempotency key already used for a different action');
  } finally {
    restore();
    restoreAgents();
    restoreEvents();
    restoreResources();
    restoreAdapter();
    restoreRM();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card rejects invalid Stripe spending controls before provisioning', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        allowed_categories: ['not_a_real_category'],
        allowed_merchant_countries: ['zz'],
      },
    });

    assert.strictEqual(response.statusCode, 400);
  } finally {
    restore();
    restoreAgents();
    await server.close();
  }
});

void test('POST /agents/:id/actions/issue_card: resource config does not contain PAN or CVC', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  // Resource config only contains safe fields — no PAN/CVC
  const resource = buildCardResourceRecord({
    config: { cardholder_id: 'ich_test', last4: '4242', exp_month: 12, exp_year: 2027 },
  });
  const sensitiveData = {
    number: '4242424242424242',
    cvc: '123',
    exp_month: 12,
    exp_year: 2027,
    last4: '4242',
  };
  const fakeEvent = buildFakeCardEventRecord();

  const provisionCalls: unknown[] = [];
  const restoreAgents = installAgentsDalMock({ findById: () => Promise.resolve(agent) });
  const restoreAdapter = installStripeAdapterMock(server, {});
  const restoreRM = installResourceManagerMock(server, {
    provision: (...args) => {
      provisionCalls.push(args);
      return Promise.resolve({ resource, sensitiveData });
    },
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: () => Promise.resolve({ event: fakeEvent, wasCreated: true } as WriteEventResult),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents/agt_123/actions/issue_card',
      headers: { authorization: authorizationHeader },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
      },
    });

    assert.strictEqual(response.statusCode, 200);

    // The resource config from provision (what gets persisted) must not contain PAN/CVC
    const body = JSON.parse(response.payload) as { resource: { config: Record<string, unknown> } };
    assert.ok(!('number' in body.resource.config), 'PAN must not be in resource config');
    assert.ok(!('cvc' in body.resource.config), 'CVC must not be in resource config');
  } finally {
    restore();
    restoreAgents();
    restoreAdapter();
    restoreRM();
    restoreWriter();
    await server.close();
  }
});

void test('StripeAdapter.provision activates cards and deactivates cardholders on failure', async () => {
  const adapter = new StripeAdapter('sk_test_123', 'whsec_test_123');

  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let createPayload: Record<string, unknown> | null = null;

  (
    adapter as unknown as {
      stripe: {
        issuing: {
          cardholders: {
            create: (payload: Record<string, unknown>) => Promise<{ id: string }>;
            update: (
              id: string,
              payload: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>;
          };
          cards: {
            create: (payload: Record<string, unknown>) => Promise<never>;
          };
        };
      };
    }
  ).stripe = {
    issuing: {
      cardholders: {
        create: () => Promise.resolve({ id: 'ich_test' }),
        update: (id, payload) => {
          calls.push({ id, payload });
          return Promise.resolve({});
        },
      },
      cards: {
        create: (payload) => {
          createPayload = payload;
          return Promise.reject(new Error('card create failed'));
        },
      },
    },
  };

  await assert.rejects(() =>
    adapter.provision('agt_123', {
      billing_name: 'Agent One',
      spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
    }),
  );

  assert.ok(createPayload);
  assert.strictEqual(createPayload['status'], 'active');
  assert.deepStrictEqual(calls, [{ id: 'ich_test', payload: { status: 'inactive' } }]);
});

void test('StripeAdapter.deprovision cancels cards and deactivates cardholders', async () => {
  const adapter = new StripeAdapter('sk_test_123', 'whsec_test_123');

  const calls: Array<{
    target: 'card' | 'cardholder';
    id: string;
    payload: Record<string, unknown>;
  }> = [];

  (
    adapter as unknown as {
      stripe: {
        issuing: {
          cardholders: {
            update: (
              id: string,
              payload: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>;
          };
          cards: {
            update: (
              id: string,
              payload: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>;
          };
        };
      };
    }
  ).stripe = {
    issuing: {
      cardholders: {
        update: (id, payload) => {
          calls.push({ target: 'cardholder', id, payload });
          return Promise.resolve({});
        },
      },
      cards: {
        update: (id, payload) => {
          calls.push({ target: 'card', id, payload });
          return Promise.resolve({});
        },
      },
    },
  };

  await adapter.deprovision(
    buildCardResourceRecord({
      config: { cardholder_id: 'ich_test', last4: '4242', exp_month: 12, exp_year: 2027 },
    }),
  );

  assert.deepStrictEqual(calls, [
    { target: 'card', id: 'ic_test123', payload: { status: 'canceled' } },
    { target: 'cardholder', id: 'ich_test', payload: { status: 'inactive' } },
  ]);
});

void test('ResourceManager.provision deprovisions a Stripe card when DB activation fails', async () => {
  const adapterCalls: Array<{ kind: 'provision' | 'deprovision'; resource?: ResourceRecord }> = [];
  const adapter = {
    providerName: 'stripe' as const,
    provision: () => {
      adapterCalls.push({ kind: 'provision' });
      return Promise.resolve({
        providerRef: 'ic_test123',
        config: {
          cardholder_id: 'ich_test',
          last4: '4242',
          exp_month: 12,
          exp_year: 2027,
        },
      });
    },
    deprovision: (resource: ResourceRecord) => {
      adapterCalls.push({ kind: 'deprovision', resource });
      return Promise.resolve({});
    },
    performAction: () => Promise.resolve({}),
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => Promise.resolve([]),
  };
  const resourceManager = new ResourceManager(new Map([['stripe', adapter]]));
  let activeUpdateAttempted = false;

  const dal = {
    resources: {
      findById: () => Promise.resolve(null),
      insert: (data: Record<string, unknown>) =>
        Promise.resolve(
          buildCardResourceRecord({
            id: data['id'] as string,
            providerRef: null,
            providerOrgId: null,
            config: data['config'] as Record<string, unknown>,
            state: 'provisioning',
          }),
        ),
      updateById: (_id: string, data: Record<string, unknown>) => {
        if (data['state'] === 'active' && !activeUpdateAttempted) {
          activeUpdateAttempted = true;
          return Promise.reject(new Error('db write failed'));
        }

        const providerRef = typeof data['providerRef'] === 'string' ? data['providerRef'] : null;
        const providerOrgId =
          typeof data['providerOrgId'] === 'string' ? data['providerOrgId'] : null;
        const config =
          typeof data['config'] === 'object' && data['config'] !== null
            ? (data['config'] as Record<string, unknown>)
            : {};
        const state = data['state'];

        return Promise.resolve(
          buildCardResourceRecord({
            providerRef,
            providerOrgId,
            config,
            state:
              state === 'provisioning' ||
              state === 'active' ||
              state === 'suspended' ||
              state === 'deleted'
                ? state
                : 'active',
          }),
        );
      },
    },
  } as unknown as DalFactory;

  await assert.rejects(() =>
    resourceManager.provision(
      dal,
      'agt_123',
      'card',
      'stripe',
      {
        billing_name: 'Agent One',
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
      },
      { resourceId: 'res_card_rollback' },
    ),
  );

  assert.deepStrictEqual(
    adapterCalls.map((call) => call.kind),
    ['provision', 'deprovision'],
  );
  const deprovisionCall = adapterCalls[1];
  assert.strictEqual(deprovisionCall.kind, 'deprovision');
  assert.ok(deprovisionCall.resource);
  assert.strictEqual(deprovisionCall.resource.providerRef, 'ic_test123');
  assert.strictEqual(deprovisionCall.resource.config['cardholder_id'], 'ich_test');
});

void test('StripeAdapter.parseWebhook preserves refund sign and type metadata', async () => {
  const adapter = new StripeAdapter('sk_test_123', 'whsec_test_123');
  const payload = JSON.stringify({
    id: 'evt_refund_001',
    type: 'issuing_transaction.created',
    created: Math.floor(FIXED_TIMESTAMP.getTime() / 1000),
    data: {
      object: {
        id: 'ipi_refund_001',
        card: 'ic_test123',
        amount: -5000,
        currency: 'usd',
        authorization: 'iauth_001',
        type: 'refund',
      },
    },
  });

  const [event] = await adapter.parseWebhook(Buffer.from(payload), {});
  assert.ok(event);
  assert.strictEqual(event.eventType, 'payment.card.settled');
  assert.strictEqual(event.resourceRef, 'ic_test123');
  assert.deepStrictEqual(event.data, {
    transaction_id: 'ipi_refund_001',
    authorization_id: 'iauth_001',
    amount: -5000,
    currency: 'USD',
    transaction_type: 'refund',
  });
});

// ---------------------------------------------------------------------------
// Stripe webhook endpoint tests
// ---------------------------------------------------------------------------

const STRIPE_TEST_SECRET = 'stripe_test_webhook_secret_for_unit_tests';

void test('POST /webhooks/stripe returns 401 for invalid signature', async () => {
  const server = await buildServer();
  const body = buildAuthorizationWebhookPayload(true);

  const restoreAdapter = installStripeAdapterMock(server, {
    verifyWebhook: () => Promise.resolve(false),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'invalid', 'content-type': 'application/json' },
      payload: body,
    });

    assert.strictEqual(response.statusCode, 401);
  } finally {
    restoreAdapter();
    await server.close();
  }
});

void test('POST /webhooks/stripe: approved authorization → payment.card.authorized', async () => {
  const server = await buildServer();
  const bodyStr = buildAuthorizationWebhookPayload(true);
  const headers = buildStripeWebhookHeaders(bodyStr, STRIPE_TEST_SECRET);
  const resource = buildCardResourceRecord();
  const writeEventCalls: unknown[] = [];

  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = () => Promise.resolve(resource);

  const restoreAdapter = installStripeAdapterMock(server, {
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () =>
      Promise.resolve([
        {
          resourceRef: 'ic_test123',
          provider: 'stripe',
          providerEventId: 'evt_auth_001',
          eventType: 'payment.card.authorized',
          occurredAt: FIXED_TIMESTAMP,
          data: { authorization_id: 'iauth_001', amount: 5000, currency: 'USD' },
        } satisfies ParsedWebhookEvent,
      ]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeCardEventRecord({ eventType: 'payment.card.authorized' }),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 1);
    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'payment.card.authorized');
    assert.strictEqual(input['providerEventId'], 'evt_auth_001');
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/stripe: declined authorization → payment.card.declined', async () => {
  const server = await buildServer();
  const bodyStr = buildAuthorizationWebhookPayload(false);
  const headers = buildStripeWebhookHeaders(bodyStr, STRIPE_TEST_SECRET);
  const resource = buildCardResourceRecord();
  const writeEventCalls: unknown[] = [];

  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = () => Promise.resolve(resource);

  const restoreAdapter = installStripeAdapterMock(server, {
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () =>
      Promise.resolve([
        {
          resourceRef: 'ic_test123',
          provider: 'stripe',
          providerEventId: 'evt_auth_002',
          eventType: 'payment.card.declined',
          occurredAt: FIXED_TIMESTAMP,
          data: { authorization_id: 'iauth_002', amount: 5000, currency: 'USD' },
        } satisfies ParsedWebhookEvent,
      ]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeCardEventRecord({ eventType: 'payment.card.declined' }),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 1);
    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'payment.card.declined');
    assert.strictEqual(input['providerEventId'], 'evt_auth_002');
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/stripe: transaction → payment.card.settled', async () => {
  const server = await buildServer();
  const bodyStr = buildTransactionWebhookPayload();
  const headers = buildStripeWebhookHeaders(bodyStr, STRIPE_TEST_SECRET);
  const resource = buildCardResourceRecord();
  const writeEventCalls: unknown[] = [];

  const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
  systemDal.findResourceByProviderRef = () => Promise.resolve(resource);

  const restoreAdapter = installStripeAdapterMock(server, {
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () =>
      Promise.resolve([
        {
          resourceRef: 'ic_test123',
          provider: 'stripe',
          providerEventId: 'evt_txn_001',
          eventType: 'payment.card.settled',
          occurredAt: FIXED_TIMESTAMP,
          data: {
            transaction_id: 'ipi_001',
            authorization_id: 'iauth_001',
            amount: 5000,
            currency: 'USD',
          },
        } satisfies ParsedWebhookEvent,
      ]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeCardEventRecord({ eventType: 'payment.card.settled' }),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers,
      payload: bodyStr,
    });

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(writeEventCalls.length, 1);
    const input = writeEventCalls[0] as Record<string, unknown>;
    assert.strictEqual(input['eventType'], 'payment.card.settled');
    assert.strictEqual(input['providerEventId'], 'evt_txn_001');
    const data = input['data'] as Record<string, unknown>;
    assert.strictEqual(data['transaction_id'], 'ipi_001');
    assert.strictEqual(data['authorization_id'], 'iauth_001');
  } finally {
    systemDal.findResourceByProviderRef = originalFind;
    restoreAdapter();
    restoreWriter();
    await server.close();
  }
});

void test('POST /webhooks/stripe: unknown event type → 200, no event written', async () => {
  const server = await buildServer();
  const bodyStr = JSON.stringify({
    id: 'evt_unknown',
    type: 'customer.created',
    created: 0,
    data: { object: {} },
  });
  const headers = buildStripeWebhookHeaders(bodyStr, STRIPE_TEST_SECRET);
  const writeEventCalls: unknown[] = [];

  const restoreAdapter = installStripeAdapterMock(server, {
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => Promise.resolve([]),
  });
  const restoreWriter = installEventWriterMock(server, {
    writeEvent: (input) => {
      writeEventCalls.push(input);
      return Promise.resolve({
        event: buildFakeCardEventRecord(),
        wasCreated: true,
      } as WriteEventResult);
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
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
