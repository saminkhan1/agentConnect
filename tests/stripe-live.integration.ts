import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

import { STRIPE_API_VERSION } from '../src/adapters/stripe-adapter';
import { buildServer } from '../src/api/server';
import { db } from '../src/db';
import { agents, apiKeys, events, orgs, outboundActions, resources } from '../src/db/schema';
import { generateApiKeyMaterial } from '../src/domain/api-keys';
import { EVENT_TYPES } from '../src/domain/events';

const liveStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const liveStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const liveStripeCardDetailsNonce = process.env.STRIPE_TEST_CARD_DETAILS_NONCE;
const liveStripeSmokeRequested = process.env.STRIPE_LIVE_SMOKE === '1';

const liveStripeSmokeSkipReason = !liveStripeSmokeRequested
  ? 'Set STRIPE_LIVE_SMOKE=1 to enable the live Stripe sandbox smoke suite.'
  : !liveStripeSecretKey || !liveStripeWebhookSecret
    ? 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to run the live Stripe sandbox smoke suite.'
    : undefined;

function liveSmokeTest(name: string, fn: () => Promise<void>) {
  if (liveStripeSmokeSkipReason) {
    void test.skip(name, fn);
    return;
  }

  void test(name, fn);
}

function liveCardDetailsSmokeTest(name: string, fn: () => Promise<void>) {
  if (liveStripeSmokeSkipReason || !liveStripeCardDetailsNonce) {
    void test.skip(name, fn);
    return;
  }

  void test(name, fn);
}

function createLiveStripeClient() {
  assert.ok(liveStripeSecretKey, 'Expected STRIPE_SECRET_KEY to be set for live smoke tests');
  return new Stripe(liveStripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
  });
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(outboundActions).where(eq(outboundActions.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(resources).where(eq(resources.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
}

async function createOrgAndAgent(server: Awaited<ReturnType<typeof buildServer>>, label: string) {
  const orgId = `org_live_stripe_${crypto.randomUUID()}`;
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

  assert.strictEqual(createAgentResponse.statusCode, 201, createAgentResponse.payload);

  const agentId = (
    JSON.parse(createAgentResponse.payload) as {
      agent: { id: string };
    }
  ).agent.id;

  return { orgId, authorization, agentId };
}

function buildLiveIssueCardPayload() {
  return {
    cardholder_name: 'Stripe Live Tester',
    billing_address: {
      line1: '123 Market St',
      city: 'San Francisco',
      postal_code: '94105',
      country: 'US',
    },
    currency: 'usd',
    spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
    allowed_merchant_countries: ['US'],
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

function buildStripeWebhookPayload(
  eventType: string,
  eventId: string,
  created: number,
  object: object,
) {
  return JSON.stringify({
    id: eventId,
    type: eventType,
    created,
    data: { object },
  });
}

async function issueLiveCard(
  server: Awaited<ReturnType<typeof buildServer>>,
  authorization: string,
  agentId: string,
) {
  const response = await server.inject({
    method: 'POST',
    url: `/agents/${agentId}/actions/issue_card`,
    headers: { authorization },
    payload: buildLiveIssueCardPayload(),
  });

  assert.strictEqual(response.statusCode, 200, response.payload);

  return JSON.parse(response.payload) as {
    resource: { id: string; providerRef: string; state: string };
    card: { exp_month: number; exp_year: number; last4: string; currency: string };
    event: { id: string; eventType: string };
  };
}

async function deleteResourceIfPresent(
  server: Awaited<ReturnType<typeof buildServer>>,
  authorization: string,
  agentId: string,
  resourceId: string | undefined,
) {
  if (!resourceId) {
    return;
  }

  const response = await server.inject({
    method: 'DELETE',
    url: `/agents/${agentId}/resources/${resourceId}`,
    headers: { authorization },
  });

  assert.ok([200, 404].includes(response.statusCode), response.payload);
}

liveSmokeTest(
  'live stripe smoke: issue_card creates a real test-mode virtual card and persists only safe metadata',
  async () => {
    const server = await buildServer();
    const stripe = createLiveStripeClient();
    const { orgId, authorization, agentId } = await createOrgAndAgent(server, 'Live Stripe Issue');
    let resourceId: string | undefined;

    try {
      const payload = await issueLiveCard(server, authorization, agentId);
      resourceId = payload.resource.id;

      assert.strictEqual(payload.resource.state, 'active');
      assert.ok(payload.resource.providerRef.startsWith('ic_'));
      assert.strictEqual(payload.event.eventType, EVENT_TYPES.PAYMENT_CARD_ISSUED);
      assert.strictEqual(payload.card.currency, 'usd');
      assert.ok(!('number' in payload.card));
      assert.ok(!('cvc' in payload.card));

      const [storedResource] = await db
        .select()
        .from(resources)
        .where(eq(resources.id, payload.resource.id));
      assert.ok(storedResource, 'Expected issued card resource to be persisted');
      assert.strictEqual(storedResource.provider, 'stripe');
      assert.strictEqual(storedResource.providerRef, payload.resource.providerRef);
      assert.strictEqual(storedResource.config['currency'], 'usd');
      assert.ok(!('number' in storedResource.config));
      assert.ok(!('cvc' in storedResource.config));

      const liveCard = await stripe.issuing.cards.retrieve(payload.resource.providerRef);
      assert.strictEqual(liveCard.id, payload.resource.providerRef);
      assert.strictEqual(liveCard.last4, payload.card.last4);
      assert.strictEqual(liveCard.exp_month, payload.card.exp_month);
      assert.strictEqual(liveCard.exp_year, payload.card.exp_year);
      assert.strictEqual(liveCard.currency, payload.card.currency);
    } finally {
      await deleteResourceIfPresent(server, authorization, agentId, resourceId);
      await cleanupOrg(orgId);
      await server.close();
    }
  },
);

liveSmokeTest(
  'live stripe smoke: live Issuing test helpers round-trip authorization, capture, and refund payloads through the webhook route',
  async () => {
    const server = await buildServer();
    const stripe = createLiveStripeClient();
    const { orgId, authorization, agentId } = await createOrgAndAgent(
      server,
      'Live Stripe Webhooks',
    );
    let resourceId: string | undefined;

    try {
      const issuedCard = await issueLiveCard(server, authorization, agentId);
      resourceId = issuedCard.resource.id;

      assert.ok(
        liveStripeWebhookSecret,
        'Expected STRIPE_WEBHOOK_SECRET to be set for live webhook smoke tests',
      );

      const authorizationObject = await stripe.testHelpers.issuing.authorizations.create({
        card: issuedCard.resource.providerRef,
        amount: 500,
        currency: 'usd',
      });

      const authorizationEventId = `evt_live_auth_${crypto.randomUUID().replaceAll('-', '')}`;
      const authorizationPayload = buildStripeWebhookPayload(
        'issuing_authorization.created',
        authorizationEventId,
        authorizationObject.created,
        authorizationObject,
      );
      const authorizationResponse = await server.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: buildStripeWebhookHeaders(authorizationPayload, liveStripeWebhookSecret),
        payload: authorizationPayload,
      });

      assert.strictEqual(authorizationResponse.statusCode, 200, authorizationResponse.payload);

      const captureObject = await stripe.testHelpers.issuing.transactions.createForceCapture({
        card: issuedCard.resource.providerRef,
        amount: 500,
        currency: 'usd',
      });

      const captureEventId = `evt_live_capture_${crypto.randomUUID().replaceAll('-', '')}`;
      const capturePayload = buildStripeWebhookPayload(
        'issuing_transaction.created',
        captureEventId,
        captureObject.created,
        captureObject,
      );
      const captureResponse = await server.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: buildStripeWebhookHeaders(capturePayload, liveStripeWebhookSecret),
        payload: capturePayload,
      });

      assert.strictEqual(captureResponse.statusCode, 200, captureResponse.payload);

      const refundObject = await stripe.testHelpers.issuing.transactions.refund(captureObject.id, {
        refund_amount: 100,
      });

      const refundEventId = `evt_live_refund_${crypto.randomUUID().replaceAll('-', '')}`;
      const refundPayload = buildStripeWebhookPayload(
        'issuing_transaction.created',
        refundEventId,
        refundObject.created,
        refundObject,
      );
      const refundResponse = await server.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: buildStripeWebhookHeaders(refundPayload, liveStripeWebhookSecret),
        payload: refundPayload,
      });

      assert.strictEqual(refundResponse.statusCode, 200, refundResponse.payload);

      const storedEvents = await db.select().from(events).where(eq(events.orgId, orgId));
      const authorizationEvent = storedEvents.find(
        (eventRecord) => eventRecord.providerEventId === authorizationEventId,
      );
      const captureEvent = storedEvents.find(
        (eventRecord) => eventRecord.providerEventId === captureEventId,
      );
      const refundEvent = storedEvents.find(
        (eventRecord) => eventRecord.providerEventId === refundEventId,
      );

      assert.ok(authorizationEvent, 'Expected live authorization webhook to be persisted');
      assert.ok(captureEvent, 'Expected live capture webhook to be persisted');
      assert.ok(refundEvent, 'Expected live refund webhook to be persisted');

      assert.strictEqual(
        authorizationEvent.eventType,
        authorizationObject.approved
          ? EVENT_TYPES.PAYMENT_CARD_AUTHORIZED
          : EVENT_TYPES.PAYMENT_CARD_DECLINED,
      );
      assert.strictEqual(captureEvent.eventType, EVENT_TYPES.PAYMENT_CARD_SETTLED);
      assert.strictEqual(refundEvent.eventType, EVENT_TYPES.PAYMENT_CARD_SETTLED);

      const captureData = captureEvent.data;
      const refundData = refundEvent.data;

      assert.strictEqual(captureData['transaction_id'], captureObject.id);
      assert.strictEqual(captureData['amount'], captureObject.amount);
      assert.strictEqual(captureData['currency'], captureObject.currency.toUpperCase());

      assert.strictEqual(refundData['transaction_id'], refundObject.id);
      assert.strictEqual(refundData['amount'], refundObject.amount);
      assert.strictEqual(refundData['currency'], refundObject.currency.toUpperCase());
      assert.strictEqual(refundData['transaction_type'], refundObject.type);
    } finally {
      await deleteResourceIfPresent(server, authorization, agentId, resourceId);
      await cleanupOrg(orgId);
      await server.close();
    }
  },
);

liveCardDetailsSmokeTest(
  'live stripe smoke: create_card_details_session exchanges a real frontend nonce for an ephemeral key',
  async () => {
    const server = await buildServer();
    const { orgId, authorization, agentId } = await createOrgAndAgent(
      server,
      'Live Stripe Details',
    );
    let resourceId: string | undefined;

    try {
      const issuedCard = await issueLiveCard(server, authorization, agentId);
      resourceId = issuedCard.resource.id;

      const response = await server.inject({
        method: 'POST',
        url: `/agents/${agentId}/actions/create_card_details_session`,
        headers: { authorization },
        payload: {
          resource_id: issuedCard.resource.id,
          nonce: liveStripeCardDetailsNonce,
        },
      });

      assert.strictEqual(response.statusCode, 200, response.payload);

      const payload = JSON.parse(response.payload) as {
        session: {
          resource_id: string;
          card_id: string;
          ephemeral_key_secret: string;
          expires_at: number;
          livemode: boolean;
          stripe_api_version: string;
        };
      };

      assert.strictEqual(payload.session.resource_id, issuedCard.resource.id);
      assert.strictEqual(payload.session.card_id, issuedCard.resource.providerRef);
      assert.strictEqual(payload.session.stripe_api_version, STRIPE_API_VERSION);
      assert.strictEqual(typeof payload.session.ephemeral_key_secret, 'string');
      assert.ok(payload.session.ephemeral_key_secret.startsWith('ek_'));
      assert.strictEqual(typeof payload.session.expires_at, 'number');
    } finally {
      await deleteResourceIfPresent(server, authorization, agentId, resourceId);
      await cleanupOrg(orgId);
      await server.close();
    }
  },
);
