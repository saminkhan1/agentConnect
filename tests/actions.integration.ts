import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import type { AgentMailAdapter } from '../src/adapters/agentmail-adapter';
import type { ProviderAdapter, Resource } from '../src/adapters/provider-adapter';
import { STRIPE_API_VERSION, StripeAdapter } from '../src/adapters/stripe-adapter';
import { buildServer } from '../src/api/server';
import { db } from '../src/db';
import { agents, apiKeys, events, orgs, outboundActions, resources } from '../src/db/schema';
import { generateApiKeyMaterial } from '../src/domain/api-keys';
import { EventWriter } from '../src/domain/event-writer';
import { EVENT_TYPES } from '../src/domain/events';
import { ResourceManager } from '../src/domain/resource-manager';

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(outboundActions).where(eq(outboundActions.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(resources).where(eq(resources.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
}

async function createOrgAndAgent(server: Awaited<ReturnType<typeof buildServer>>, label: string) {
  const orgId = `org_actions_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  await server.systemDal.createOrgWithApiKey({
    org: { id: orgId, name: `${label} Org` },
    apiKey: { id: rootKey.id, keyType: 'root', keyHash: rootKey.keyHash },
  });

  const createAgentResponse = await server.inject({
    method: 'POST',
    url: '/agents',
    headers: { authorization },
    payload: { name: `${label} Agent` },
  });
  assert.strictEqual(createAgentResponse.statusCode, 201);
  const agentId = (JSON.parse(createAgentResponse.payload) as { agent: { id: string } }).agent.id;

  return { orgId, authorization, agentId };
}

async function createServiceAuthorization(orgId: string) {
  const serviceKey = await generateApiKeyMaterial();
  await db.insert(apiKeys).values({
    id: serviceKey.id,
    orgId,
    keyType: 'service',
    keyHash: serviceKey.keyHash,
  });

  return `Bearer ${serviceKey.plaintextKey}`;
}

function buildIssueCardPayload(overrides?: Record<string, unknown>) {
  return {
    cardholder_name: 'Agent Tester',
    billing_address: {
      line1: '123 Market St',
      city: 'San Francisco',
      postal_code: '94105',
      country: 'US',
    },
    currency: 'usd',
    spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
    ...overrides,
  };
}

function buildStripeWebhookHeaders(body: string, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return {
    'content-type': 'application/json',
    'stripe-signature': `t=${timestamp},v1=${signature}`,
  };
}

void test('integration: issue_card persists resource/event and replays without reprovisioning', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Issue Card');
  const provisionCalls: Array<{ agentId: string; config: Record<string, unknown> }> = [];

  const fakeStripeAdapter: ProviderAdapter = {
    providerName: 'stripe',
    provision: (provisionAgentId, config) => {
      provisionCalls.push({ agentId: provisionAgentId, config });
      return Promise.resolve({
        providerRef: 'ic_integration_123',
        config: {
          cardholder_id: 'ich_integration_123',
          last4: '4242',
          exp_month: 12,
          exp_year: 2027,
          currency: 'usd',
        },
      });
    },
    deprovision: () => Promise.resolve({}),
    performAction: () => Promise.resolve({}),
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => Promise.resolve([]),
  };

  server.stripeAdapter = fakeStripeAdapter as unknown as StripeAdapter;
  server.resourceManager = new ResourceManager(new Map([['stripe', fakeStripeAdapter]]));

  try {
    const firstResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/issue_card`,
      headers: { authorization },
      payload: buildIssueCardPayload({
        idempotency_key: 'issue-card-integration-idem',
      }),
    });

    assert.strictEqual(firstResponse.statusCode, 200);
    const firstPayload = JSON.parse(firstResponse.payload) as {
      resource: { id: string; providerRef: string; state: string };
      card: { exp_month: number; exp_year: number; last4: string; currency: string };
      event: { id: string; eventType: string; idempotencyKey: string | null };
    };
    assert.strictEqual(firstPayload.resource.providerRef, 'ic_integration_123');
    assert.strictEqual(firstPayload.resource.state, 'active');
    assert.strictEqual(firstPayload.card.last4, '4242');
    assert.strictEqual(firstPayload.card.exp_month, 12);
    assert.strictEqual(firstPayload.card.exp_year, 2027);
    assert.strictEqual(firstPayload.card.currency, 'usd');
    assert.strictEqual(firstPayload.event.eventType, EVENT_TYPES.PAYMENT_CARD_ISSUED);
    assert.strictEqual(firstPayload.event.idempotencyKey, 'issue-card-integration-idem');
    assert.ok(!('number' in firstPayload.card));
    assert.ok(!('cvc' in firstPayload.card));

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedResources[0].provider, 'stripe');
    assert.strictEqual(storedResources[0].providerRef, 'ic_integration_123');
    assert.strictEqual(storedResources[0].state, 'active');
    assert.strictEqual(storedResources[0].config['currency'], 'usd');
    assert.ok(!('number' in storedResources[0].config));
    assert.ok(!('cvc' in storedResources[0].config));

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.PAYMENT_CARD_ISSUED);
    assert.strictEqual(storedEvents[0].resourceId, storedResources[0].id);

    server.stripeAdapter = undefined;

    const replayResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/issue_card`,
      headers: { authorization },
      payload: buildIssueCardPayload({
        idempotency_key: 'issue-card-integration-idem',
      }),
    });

    assert.strictEqual(replayResponse.statusCode, 200);
    const replayPayload = JSON.parse(replayResponse.payload) as {
      resource: { id: string };
      card: { last4: string; currency: string };
      event: { id: string };
    };
    assert.strictEqual(replayPayload.resource.id, firstPayload.resource.id);
    assert.strictEqual(replayPayload.card.last4, '4242');
    assert.strictEqual(replayPayload.card.currency, 'usd');
    assert.strictEqual(replayPayload.event.id, firstPayload.event.id);
    assert.strictEqual(provisionCalls.length, 1);

    const resourcesAfterReplay = await db
      .select()
      .from(resources)
      .where(eq(resources.orgId, orgId));
    const eventsAfterReplay = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(resourcesAfterReplay.length, 1);
    assert.strictEqual(eventsAfterReplay.length, 1);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: issue_card idempotency rejects different card parameters without reprovisioning', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Issue Card Conflict');
  let provisionCalls = 0;

  const fakeStripeAdapter: ProviderAdapter = {
    providerName: 'stripe',
    provision: () => {
      provisionCalls += 1;
      return Promise.resolve({
        providerRef: 'ic_integration_conflict_123',
        config: {
          cardholder_id: 'ich_integration_conflict_123',
          last4: '1111',
          exp_month: 1,
          exp_year: 2029,
          currency: 'usd',
        },
      });
    },
    deprovision: () => Promise.resolve({}),
    performAction: () => Promise.resolve({}),
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => Promise.resolve([]),
  };

  server.stripeAdapter = fakeStripeAdapter as unknown as StripeAdapter;
  server.resourceManager = new ResourceManager(new Map([['stripe', fakeStripeAdapter]]));

  try {
    const firstResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/issue_card`,
      headers: { authorization },
      payload: buildIssueCardPayload({
        idempotency_key: 'issue-card-conflict-idem',
      }),
    });

    assert.strictEqual(firstResponse.statusCode, 200);
    assert.strictEqual(provisionCalls, 1);

    const conflictResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/issue_card`,
      headers: { authorization },
      payload: buildIssueCardPayload({
        currency: 'eur',
        idempotency_key: 'issue-card-conflict-idem',
      }),
    });

    assert.strictEqual(conflictResponse.statusCode, 409);
    assert.strictEqual(provisionCalls, 1);

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedEvents.length, 1);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: issue_card provisions only once under concurrency for the same idempotency key', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(
    server,
    'Issue Card Concurrency',
  );
  let provisionCalls = 0;

  const fakeStripeAdapter: ProviderAdapter = {
    providerName: 'stripe',
    provision: async () => {
      provisionCalls += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      return {
        providerRef: 'ic_integration_concurrency_123',
        config: {
          cardholder_id: 'ich_integration_concurrency_123',
          last4: '5555',
          exp_month: 11,
          exp_year: 2030,
          currency: 'usd',
        },
      };
    },
    deprovision: () => Promise.resolve({}),
    performAction: () => Promise.resolve({}),
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => Promise.resolve([]),
  };

  server.stripeAdapter = fakeStripeAdapter as unknown as StripeAdapter;
  server.resourceManager = new ResourceManager(new Map([['stripe', fakeStripeAdapter]]));

  try {
    const [firstResponse, secondResponse] = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/agents/${agentId}/actions/issue_card`,
        headers: { authorization },
        payload: buildIssueCardPayload({
          idempotency_key: 'issue-card-concurrency-idem',
        }),
      }),
      server.inject({
        method: 'POST',
        url: `/agents/${agentId}/actions/issue_card`,
        headers: { authorization },
        payload: buildIssueCardPayload({
          idempotency_key: 'issue-card-concurrency-idem',
        }),
      }),
    ]);

    assert.strictEqual(firstResponse.statusCode, 200);
    assert.strictEqual(secondResponse.statusCode, 200);
    assert.strictEqual(provisionCalls, 1);

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedEvents.length, 1);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: create_card_details_session is root-only and returns a short-lived session', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Card Details Session');
  const serviceAuthorization = await createServiceAuthorization(orgId);
  const resourceId = `res_card_details_${crypto.randomUUID()}`;

  await db.insert(resources).values({
    id: resourceId,
    orgId,
    agentId,
    type: 'card',
    provider: 'stripe',
    providerRef: 'ic_card_details_123',
    config: {
      cardholder_id: 'ich_card_details_123',
      last4: '9876',
      exp_month: 8,
      exp_year: 2029,
      currency: 'usd',
    },
    state: 'active',
  });

  server.stripeAdapter = {
    createCardDetailsSession: () =>
      Promise.resolve({
        cardId: 'ic_card_details_123',
        ephemeralKeySecret: 'ephkey_test_secret',
        expiresAt: 1_800_000_000,
        livemode: false,
        apiVersion: STRIPE_API_VERSION,
      }),
  } as unknown as StripeAdapter;

  try {
    const forbiddenResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/create_card_details_session`,
      headers: { authorization: serviceAuthorization },
      payload: { resource_id: resourceId, nonce: 'nonce_service_denied' },
    });

    assert.strictEqual(forbiddenResponse.statusCode, 403);

    const rootResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/create_card_details_session`,
      headers: { authorization },
      payload: { resource_id: resourceId, nonce: 'nonce_root_allowed' },
    });

    assert.strictEqual(rootResponse.statusCode, 200);
    const payload = JSON.parse(rootResponse.payload) as {
      session: {
        resource_id: string;
        card_id: string;
        ephemeral_key_secret: string;
        stripe_api_version: string;
      };
    };
    assert.strictEqual(payload.session.resource_id, resourceId);
    assert.strictEqual(payload.session.card_id, 'ic_card_details_123');
    assert.strictEqual(payload.session.ephemeral_key_secret, 'ephkey_test_secret');
    assert.strictEqual(payload.session.stripe_api_version, STRIPE_API_VERSION);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: send_email uses the active inbox and replays idempotent sends without resending', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Send Email');
  const performActionCalls: Array<{
    resourceId: string;
    providerRef: string | null;
    payload: Record<string, unknown>;
  }> = [];

  const fakeAgentMailAdapter = {
    performAction: (resource: Resource, _action: string, payload: Record<string, unknown>) => {
      performActionCalls.push({
        resourceId: resource.id,
        providerRef: resource.providerRef,
        payload,
      });
      return Promise.resolve({
        message_id: 'msg_send_integration_123',
        thread_id: 'thread_send_integration_123',
      });
    },
  } as unknown as AgentMailAdapter;

  server.agentMailAdapter = fakeAgentMailAdapter;

  try {
    await db.insert(resources).values([
      {
        id: `res_deleted_${crypto.randomUUID()}`,
        orgId,
        agentId,
        type: 'email_inbox',
        provider: 'agentmail',
        providerRef: 'deleted@agentmail.to',
        config: {},
        state: 'deleted',
      },
      {
        id: `res_active_${crypto.randomUUID()}`,
        orgId,
        agentId,
        type: 'email_inbox',
        provider: 'agentmail',
        providerRef: 'active@agentmail.to',
        config: {},
        state: 'active',
      },
    ]);

    const firstResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['user@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'Integration hello',
        text: 'Hello from integration',
        reply_to: 'reply@example.com',
        idempotency_key: 'send-email-integration-idem',
      },
    });

    assert.strictEqual(firstResponse.statusCode, 200);
    const firstPayload = JSON.parse(firstResponse.payload) as {
      event: { id: string; eventType: string; idempotencyKey: string | null };
    };
    assert.strictEqual(firstPayload.event.eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(firstPayload.event.idempotencyKey, 'send-email-integration-idem');
    assert.strictEqual(performActionCalls.length, 1);
    assert.strictEqual(performActionCalls[0].providerRef, 'active@agentmail.to');

    const replayResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['user@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'Integration hello',
        text: 'Hello from integration',
        reply_to: 'reply@example.com',
        idempotency_key: 'send-email-integration-idem',
      },
    });

    assert.strictEqual(replayResponse.statusCode, 200);
    const replayPayload = JSON.parse(replayResponse.payload) as {
      event: { id: string };
    };
    assert.strictEqual(replayPayload.event.id, firstPayload.event.id);
    assert.strictEqual(performActionCalls.length, 1);

    const conflictResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['user@example.com'],
        subject: 'Different subject',
        text: 'Hello from integration',
        idempotency_key: 'send-email-integration-idem',
      },
    });

    assert.strictEqual(conflictResponse.statusCode, 409);
    assert.strictEqual(performActionCalls.length, 1);

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(storedEvents[0].resourceId, performActionCalls[0].resourceId);
    assert.strictEqual(storedEvents[0].data['from'], 'active@agentmail.to');
    assert.deepStrictEqual(storedEvents[0].data['to'], ['user@example.com']);
    assert.deepStrictEqual(storedEvents[0].data['cc'], ['cc@example.com']);
    assert.deepStrictEqual(storedEvents[0].data['bcc'], ['bcc@example.com']);
    assert.strictEqual(typeof storedEvents[0].data['request_hash'], 'string');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: send_email recovers from provider success plus event write failure without resending', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Send Email Recover');
  const performActionCalls: Array<{
    resourceId: string;
    providerRef: string | null;
    payload: Record<string, unknown>;
  }> = [];

  const fakeAgentMailAdapter = {
    performAction: (resource: Resource, _action: string, payload: Record<string, unknown>) => {
      performActionCalls.push({
        resourceId: resource.id,
        providerRef: resource.providerRef,
        payload,
      });
      return Promise.resolve({
        message_id: 'msg_send_recover_123',
        thread_id: 'thread_send_recover_123',
      });
    },
  } as unknown as AgentMailAdapter;

  server.agentMailAdapter = fakeAgentMailAdapter;
  const originalWriter = server.eventWriter;
  let writeEventAttempts = 0;
  const wrappedWriter = Object.assign(
    Object.create(EventWriter.prototype) as typeof server.eventWriter,
    originalWriter,
  );
  wrappedWriter.writeEvent = async (input: Parameters<typeof originalWriter.writeEvent>[0]) => {
    writeEventAttempts += 1;
    if (writeEventAttempts === 1) {
      throw new Error('forced integration write failure');
    }

    return originalWriter.writeEvent(input);
  };
  server.eventWriter = wrappedWriter;

  try {
    await db.insert(resources).values({
      id: `res_active_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'email_inbox',
      provider: 'agentmail',
      providerRef: 'recover@agentmail.to',
      config: {},
      state: 'active',
    });

    const firstResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['user@example.com'],
        subject: 'Recover hello',
        text: 'Hello from recovery integration',
        idempotency_key: 'send-email-recover-idem',
      },
    });

    assert.strictEqual(firstResponse.statusCode, 500);
    assert.strictEqual(performActionCalls.length, 1);
    assert.strictEqual(writeEventAttempts, 1);

    const storedActionsAfterFailure = await db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.orgId, orgId));
    assert.strictEqual(storedActionsAfterFailure.length, 1);
    assert.strictEqual(storedActionsAfterFailure[0].state, 'provider_succeeded');

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['user@example.com'],
        subject: 'Recover hello',
        text: 'Hello from recovery integration',
        idempotency_key: 'send-email-recover-idem',
      },
    });

    assert.strictEqual(retryResponse.statusCode, 200);
    assert.strictEqual(performActionCalls.length, 1);
    assert.strictEqual(writeEventAttempts, 2);

    const storedActionsAfterRetry = await db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.orgId, orgId));
    assert.strictEqual(storedActionsAfterRetry.length, 1);
    assert.strictEqual(storedActionsAfterRetry[0].state, 'completed');
    assert.ok(storedActionsAfterRetry[0].eventId);

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(storedEvents[0].idempotencyKey, 'send-email-recover-idem');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: reply_email persists outbound action data and replays without re-dispatching', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Reply Email');
  const performActionCalls: Array<{
    action: string;
    resourceId: string;
    providerRef: string | null;
    payload: Record<string, unknown>;
  }> = [];

  const fakeAgentMailAdapter = {
    performAction: (resource: Resource, action: string, payload: Record<string, unknown>) => {
      performActionCalls.push({
        action,
        resourceId: resource.id,
        providerRef: resource.providerRef,
        payload,
      });

      if (action === 'send_email') {
        return Promise.resolve({
          message_id: 'msg_send_reply_integration_123',
          thread_id: 'thread_reply_integration_123',
        });
      }

      if (action === 'get_message') {
        assert.strictEqual(payload['message_id'], 'msg_send_reply_integration_123');
        return Promise.resolve({
          message_id: 'msg_send_reply_integration_123',
          thread_id: 'thread_reply_integration_123',
          from: 'replybox@agentmail.to',
          to: ['customer@example.com'],
          subject: 'Integration hello',
          text: 'Original outbound message',
          html: null,
        });
      }

      assert.strictEqual(action, 'reply_email');
      return Promise.resolve({
        message_id: 'msg_reply_integration_123',
        thread_id: 'thread_reply_integration_123',
      });
    },
  } as unknown as AgentMailAdapter;

  server.agentMailAdapter = fakeAgentMailAdapter;

  try {
    await db.insert(resources).values({
      id: `res_active_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'email_inbox',
      provider: 'agentmail',
      providerRef: 'replybox@agentmail.to',
      config: { email_address: 'replybox@agentmail.to' },
      state: 'active',
    });

    const sendResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['customer@example.com'],
        subject: 'Integration hello',
        text: 'Hello from integration',
        idempotency_key: 'send-email-before-reply-idem',
      },
    });

    assert.strictEqual(sendResponse.statusCode, 200);

    const firstReplyResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/reply_email`,
      headers: { authorization },
      payload: {
        message_id: 'msg_send_reply_integration_123',
        text: 'Reply from integration',
        idempotency_key: 'reply-email-integration-idem',
      },
    });

    assert.strictEqual(firstReplyResponse.statusCode, 200);
    const firstReplyPayload = JSON.parse(firstReplyResponse.payload) as {
      event: { id: string; eventType: string; idempotencyKey: string | null };
    };
    assert.strictEqual(firstReplyPayload.event.eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(firstReplyPayload.event.idempotencyKey, 'reply-email-integration-idem');

    const replayResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/reply_email`,
      headers: { authorization },
      payload: {
        message_id: 'msg_send_reply_integration_123',
        text: 'Reply from integration',
        idempotency_key: 'reply-email-integration-idem',
      },
    });

    assert.strictEqual(replayResponse.statusCode, 200);
    const replayPayload = JSON.parse(replayResponse.payload) as {
      event: { id: string };
    };
    assert.strictEqual(replayPayload.event.id, firstReplyPayload.event.id);

    const getMessageCalls = performActionCalls.filter((call) => call.action === 'get_message');
    const replyCalls = performActionCalls.filter((call) => call.action === 'reply_email');
    assert.strictEqual(getMessageCalls.length, 1);
    assert.strictEqual(replyCalls.length, 1);
    assert.deepStrictEqual(replyCalls[0].payload['reply_recipients'], ['customer@example.com']);

    const storedActions = await db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.orgId, orgId));
    const replyAction = storedActions.find((action) => action.action === 'reply_email');
    assert.ok(replyAction);
    assert.strictEqual(replyAction.state, 'completed');
    assert.deepStrictEqual(replyAction.requestData['reply_recipients'], ['customer@example.com']);
    assert.strictEqual(replyAction.requestData['subject'], 'Integration hello');

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    const replyEvent = storedEvents.find(
      (event) => event.idempotencyKey === 'reply-email-integration-idem',
    );
    assert.ok(replyEvent);
    assert.strictEqual(replyEvent.eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(replyEvent.data['in_reply_to_message_id'], 'msg_send_reply_integration_123');
    assert.deepStrictEqual(replyEvent.data['to'], ['customer@example.com']);
    assert.strictEqual(replyEvent.data['subject'], 'Integration hello');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: reply_email recovers from provider success plus event write failure without refetching or re-replying', async () => {
  const server = await buildServer();
  const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Reply Recover');
  const performActionCalls: Array<{
    action: string;
    resourceId: string;
    providerRef: string | null;
    payload: Record<string, unknown>;
  }> = [];

  const fakeAgentMailAdapter = {
    performAction: (resource: Resource, action: string, payload: Record<string, unknown>) => {
      performActionCalls.push({
        action,
        resourceId: resource.id,
        providerRef: resource.providerRef,
        payload,
      });

      if (action === 'send_email') {
        return Promise.resolve({
          message_id: 'msg_send_reply_recover_123',
          thread_id: 'thread_reply_recover_123',
        });
      }

      if (action === 'get_message') {
        assert.strictEqual(payload['message_id'], 'msg_send_reply_recover_123');
        return Promise.resolve({
          message_id: 'msg_send_reply_recover_123',
          thread_id: 'thread_reply_recover_123',
          from: 'recover-reply@agentmail.to',
          to: ['customer@example.com'],
          subject: 'Recover hello',
          text: 'Original outbound message',
          html: null,
        });
      }

      assert.strictEqual(action, 'reply_email');
      return Promise.resolve({
        message_id: 'msg_reply_recover_123',
        thread_id: 'thread_reply_recover_123',
      });
    },
  } as unknown as AgentMailAdapter;

  server.agentMailAdapter = fakeAgentMailAdapter;
  const originalWriter = server.eventWriter;
  let replyWriteAttempts = 0;
  const wrappedWriter = Object.assign(
    Object.create(EventWriter.prototype) as typeof server.eventWriter,
    originalWriter,
  );
  wrappedWriter.writeEvent = async (input: Parameters<typeof originalWriter.writeEvent>[0]) => {
    if (input.idempotencyKey === 'reply-email-recover-idem') {
      replyWriteAttempts += 1;
      if (replyWriteAttempts === 1) {
        throw new Error('forced reply integration write failure');
      }
    }

    return originalWriter.writeEvent(input);
  };
  server.eventWriter = wrappedWriter;

  try {
    await db.insert(resources).values({
      id: `res_active_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'email_inbox',
      provider: 'agentmail',
      providerRef: 'recover-reply@agentmail.to',
      config: { email_address: 'recover-reply@agentmail.to' },
      state: 'active',
    });

    const sendResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/send_email`,
      headers: { authorization },
      payload: {
        to: ['customer@example.com'],
        subject: 'Recover hello',
        text: 'Hello before reply recovery',
        idempotency_key: 'send-email-before-reply-recover-idem',
      },
    });

    assert.strictEqual(sendResponse.statusCode, 200);

    const firstReplyResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/reply_email`,
      headers: { authorization },
      payload: {
        message_id: 'msg_send_reply_recover_123',
        text: 'Reply recovery body',
        idempotency_key: 'reply-email-recover-idem',
      },
    });

    assert.strictEqual(firstReplyResponse.statusCode, 500);
    assert.strictEqual(replyWriteAttempts, 1);
    assert.strictEqual(
      performActionCalls.filter((call) => call.action === 'get_message').length,
      1,
    );
    assert.strictEqual(
      performActionCalls.filter((call) => call.action === 'reply_email').length,
      1,
    );

    const storedActionsAfterFailure = await db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.orgId, orgId));
    const replyActionAfterFailure = storedActionsAfterFailure.find(
      (action) => action.action === 'reply_email',
    );
    assert.ok(replyActionAfterFailure);
    assert.strictEqual(replyActionAfterFailure.state, 'provider_succeeded');
    assert.deepStrictEqual(replyActionAfterFailure.requestData['reply_recipients'], [
      'customer@example.com',
    ]);
    assert.strictEqual(replyActionAfterFailure.requestData['subject'], 'Recover hello');

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/reply_email`,
      headers: { authorization },
      payload: {
        message_id: 'msg_send_reply_recover_123',
        text: 'Reply recovery body',
        idempotency_key: 'reply-email-recover-idem',
      },
    });

    assert.strictEqual(retryResponse.statusCode, 200);
    assert.strictEqual(replyWriteAttempts, 2);
    assert.strictEqual(
      performActionCalls.filter((call) => call.action === 'get_message').length,
      1,
    );
    assert.strictEqual(
      performActionCalls.filter((call) => call.action === 'reply_email').length,
      1,
    );

    const storedActionsAfterRetry = await db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.orgId, orgId));
    const replyActionAfterRetry = storedActionsAfterRetry.find(
      (action) => action.action === 'reply_email',
    );
    assert.ok(replyActionAfterRetry);
    assert.strictEqual(replyActionAfterRetry.state, 'completed');
    assert.ok(replyActionAfterRetry.eventId);
    assert.deepStrictEqual(replyActionAfterRetry.requestData['reply_recipients'], [
      'customer@example.com',
    ]);
    assert.strictEqual(replyActionAfterRetry.requestData['subject'], 'Recover hello');

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    const replyEvent = storedEvents.find(
      (event) => event.idempotencyKey === 'reply-email-recover-idem',
    );
    assert.ok(replyEvent);
    assert.strictEqual(replyEvent.eventType, EVENT_TYPES.EMAIL_SENT);
    assert.strictEqual(replyEvent.data['in_reply_to_message_id'], 'msg_send_reply_recover_123');
    assert.deepStrictEqual(replyEvent.data['to'], ['customer@example.com']);
    assert.strictEqual(replyEvent.data['subject'], 'Recover hello');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: Stripe authorization webhook verifies signature and writes a canonical event', async () => {
  const server = await buildServer();
  const { orgId, agentId } = await createOrgAndAgent(server, 'Stripe Webhook Auth');
  const webhookSecret = 'whsec_integration_authorization';

  server.stripeAdapter = new StripeAdapter('sk_test_123', webhookSecret);

  try {
    await db.insert(resources).values({
      id: `res_card_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'card',
      provider: 'stripe',
      providerRef: 'ic_webhook_auth_123',
      config: {
        cardholder_id: 'ich_webhook_auth_123',
        last4: '4242',
        exp_month: 12,
        exp_year: 2027,
      },
      state: 'active',
    });

    const body = JSON.stringify({
      id: 'evt_webhook_auth_123',
      type: 'issuing_authorization.created',
      created: Date.parse('2026-03-07T12:00:00.000Z') / 1000,
      data: {
        object: {
          id: 'iauth_webhook_123',
          card: { id: 'ic_webhook_auth_123' },
          approved: true,
          amount: 5000,
          currency: 'usd',
        },
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: buildStripeWebhookHeaders(body, webhookSecret),
      payload: body,
    });

    assert.strictEqual(response.statusCode, 200);

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.PAYMENT_CARD_AUTHORIZED);
    assert.strictEqual(storedEvents[0].providerEventId, 'evt_webhook_auth_123');
    assert.strictEqual(storedEvents[0].data['authorization_id'], 'iauth_webhook_123');
    assert.strictEqual(storedEvents[0].data['amount'], 5000);
    assert.strictEqual(storedEvents[0].data['currency'], 'USD');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: Stripe authorization webhook accepts string card IDs', async () => {
  const server = await buildServer();
  const { orgId, agentId } = await createOrgAndAgent(server, 'Stripe Webhook Auth String Card');
  const webhookSecret = 'whsec_integration_authorization_string_card';

  server.stripeAdapter = new StripeAdapter('sk_test_123', webhookSecret);

  try {
    await db.insert(resources).values({
      id: `res_card_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'card',
      provider: 'stripe',
      providerRef: 'ic_webhook_auth_string_123',
      config: {
        cardholder_id: 'ich_webhook_auth_string_123',
        last4: '4242',
        exp_month: 12,
        exp_year: 2027,
      },
      state: 'active',
    });

    const body = JSON.stringify({
      id: 'evt_webhook_auth_string_123',
      type: 'issuing_authorization.created',
      created: Date.parse('2026-03-07T12:00:00.000Z') / 1000,
      data: {
        object: {
          id: 'iauth_webhook_string_123',
          card: 'ic_webhook_auth_string_123',
          approved: false,
          amount: 5000,
          currency: 'usd',
        },
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: buildStripeWebhookHeaders(body, webhookSecret),
      payload: body,
    });

    assert.strictEqual(response.statusCode, 200);

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.PAYMENT_CARD_DECLINED);
    assert.strictEqual(storedEvents[0].providerEventId, 'evt_webhook_auth_string_123');
    assert.strictEqual(storedEvents[0].data['authorization_id'], 'iauth_webhook_string_123');
    assert.strictEqual(storedEvents[0].data['amount'], 5000);
    assert.strictEqual(storedEvents[0].data['currency'], 'USD');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: Stripe refund webhook verifies signature and preserves refund amounts', async () => {
  const server = await buildServer();
  const { orgId, agentId } = await createOrgAndAgent(server, 'Stripe Webhook Refund');
  const webhookSecret = 'whsec_integration_refund';

  server.stripeAdapter = new StripeAdapter('sk_test_123', webhookSecret);

  try {
    await db.insert(resources).values({
      id: `res_card_${crypto.randomUUID()}`,
      orgId,
      agentId,
      type: 'card',
      provider: 'stripe',
      providerRef: 'ic_webhook_refund_123',
      config: {
        cardholder_id: 'ich_webhook_refund_123',
        last4: '4242',
        exp_month: 12,
        exp_year: 2027,
      },
      state: 'active',
    });

    const body = JSON.stringify({
      id: 'evt_webhook_refund_123',
      type: 'issuing_transaction.created',
      created: Date.parse('2026-03-07T13:00:00.000Z') / 1000,
      data: {
        object: {
          id: 'ipi_webhook_refund_123',
          card: 'ic_webhook_refund_123',
          amount: -2500,
          currency: 'usd',
          authorization: 'iauth_webhook_refund_123',
          type: 'refund',
        },
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: buildStripeWebhookHeaders(body, webhookSecret),
      payload: body,
    });

    assert.strictEqual(response.statusCode, 200);

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.PAYMENT_CARD_SETTLED);
    assert.strictEqual(storedEvents[0].providerEventId, 'evt_webhook_refund_123');
    assert.strictEqual(storedEvents[0].data['transaction_id'], 'ipi_webhook_refund_123');
    assert.strictEqual(storedEvents[0].data['authorization_id'], 'iauth_webhook_refund_123');
    assert.strictEqual(storedEvents[0].data['amount'], -2500);
    assert.strictEqual(storedEvents[0].data['currency'], 'USD');
    assert.strictEqual(storedEvents[0].data['transaction_type'], 'refund');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});
