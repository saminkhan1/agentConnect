import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import type { AgentMailAdapter } from '../src/adapters/agentmail-adapter';
import type { ProviderAdapter, Resource } from '../src/adapters/provider-adapter';
import { StripeAdapter } from '../src/adapters/stripe-adapter';
import { buildServer } from '../src/api/server';
import { db } from '../src/db';
import { agents, apiKeys, events, orgs, resources } from '../src/db/schema';
import { generateApiKeyMaterial } from '../src/domain/api-keys';
import { EVENT_TYPES } from '../src/domain/events';
import { ResourceManager } from '../src/domain/resource-manager';

async function cleanupOrg(orgId: string): Promise<void> {
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
        },
        sensitiveData: {
          number: '4242424242424242',
          cvc: '123',
          last4: '4242',
          exp_month: 12,
          exp_year: 2027,
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
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        idempotency_key: 'issue-card-integration-idem',
      },
    });

    assert.strictEqual(firstResponse.statusCode, 200);
    const firstPayload = JSON.parse(firstResponse.payload) as {
      resource: { id: string; providerRef: string; state: string };
      card: { number: string | null; cvc: string | null; last4: string };
      event: { id: string; eventType: string; idempotencyKey: string | null };
    };
    assert.strictEqual(firstPayload.resource.providerRef, 'ic_integration_123');
    assert.strictEqual(firstPayload.resource.state, 'active');
    assert.strictEqual(firstPayload.card.number, '4242424242424242');
    assert.strictEqual(firstPayload.card.cvc, '123');
    assert.strictEqual(firstPayload.card.last4, '4242');
    assert.strictEqual(firstPayload.event.eventType, EVENT_TYPES.PAYMENT_CARD_ISSUED);
    assert.strictEqual(firstPayload.event.idempotencyKey, 'issue-card-integration-idem');

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedResources[0].provider, 'stripe');
    assert.strictEqual(storedResources[0].providerRef, 'ic_integration_123');
    assert.strictEqual(storedResources[0].state, 'active');

    const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(storedEvents[0].eventType, EVENT_TYPES.PAYMENT_CARD_ISSUED);
    assert.strictEqual(storedEvents[0].resourceId, storedResources[0].id);

    server.stripeAdapter = undefined;

    const replayResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/actions/issue_card`,
      headers: { authorization },
      payload: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
        idempotency_key: 'issue-card-integration-idem',
      },
    });

    assert.strictEqual(replayResponse.statusCode, 200);
    const replayPayload = JSON.parse(replayResponse.payload) as {
      resource: { id: string };
      card: { number: string | null; cvc: string | null };
      event: { id: string };
    };
    assert.strictEqual(replayPayload.resource.id, firstPayload.resource.id);
    assert.strictEqual(replayPayload.card.number, null);
    assert.strictEqual(replayPayload.card.cvc, null);
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
