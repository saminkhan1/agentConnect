import Stripe from 'stripe';

import type {
  DeprovisionResult,
  ParsedWebhookEvent,
  ProviderAdapter,
  ProvisionResult,
  Resource,
} from './provider-adapter.js';
import { EVENT_TYPES } from '../domain/events.js';

// Stripe event payload shapes we depend on
type StripeEventPayload = {
  id: string; // evt_...
  type: string;
  created: number; // unix timestamp
  data: { object: Record<string, unknown> };
};

type StripeExpandableId = string | { id: string };

type StripeAuthObject = {
  id: string; // iauth_...
  card: StripeExpandableId; // ic_...
  approved: boolean;
  amount: number;
  currency: string;
};

type StripeTransactionObject = {
  id: string; // ipi_...
  card: StripeExpandableId; // ic_...
  amount: number;
  currency: string;
  authorization: StripeExpandableId | null;
  type?: 'capture' | 'refund';
};

function getExpandableId(value: StripeExpandableId | null | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value.id === 'string') return value.id;
  return undefined;
}

export class StripeAdapter implements ProviderAdapter {
  readonly providerName = 'stripe';
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string) {
    this.stripe = new Stripe(secretKey);
    this.webhookSecret = webhookSecret;
  }

  async provision(_agentId: string, config: Record<string, unknown>): Promise<ProvisionResult> {
    const billingName =
      typeof config['billing_name'] === 'string' ? config['billing_name'] : _agentId;

    const cardholder = await this.stripe.issuing.cardholders.create({
      name: billingName,
      type: 'individual',
      billing: {
        address: {
          line1: '1 Agent Street',
          city: 'San Francisco',
          postal_code: '94105',
          country: 'US',
        },
      },
    });

    const spendingLimits = Array.isArray(config['spending_limits'])
      ? (config['spending_limits'] as Array<{ amount: number; interval: string }>).map((l) => ({
          amount: l.amount,
          interval:
            l.interval as Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Interval,
        }))
      : [];

    const spendingControls: Stripe.Issuing.CardCreateParams.SpendingControls = {
      spending_limits: spendingLimits,
    };

    if (Array.isArray(config['allowed_categories'])) {
      spendingControls.allowed_categories = config[
        'allowed_categories'
      ] as Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[];
    }

    if (Array.isArray(config['allowed_merchant_countries'])) {
      spendingControls.allowed_merchant_countries = config[
        'allowed_merchant_countries'
      ] as string[];
    }

    const cardParams: Stripe.Issuing.CardCreateParams = {
      cardholder: cardholder.id,
      type: 'virtual',
      currency: 'usd',
      status: 'active',
      spending_controls: spendingControls,
    };

    let card: Stripe.Issuing.Card;
    try {
      card = await this.stripe.issuing.cards.create({
        ...cardParams,
        expand: ['number', 'cvc'],
      });
    } catch (err) {
      await this.stripe.issuing.cardholders
        .update(cardholder.id, { status: 'inactive' })
        .catch(() => {});
      throw err;
    }

    return {
      providerRef: card.id, // ic_...
      config: {
        cardholder_id: cardholder.id,
        last4: card.last4,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
      },
      sensitiveData: {
        number: card.number ?? null,
        cvc: card.cvc ?? null,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        last4: card.last4,
      },
    };
  }

  async deprovision(resource: Resource): Promise<DeprovisionResult> {
    if (!resource.providerRef) {
      throw new Error(`Resource ${resource.id} has no providerRef`);
    }

    const cardholderId =
      typeof resource.config['cardholder_id'] === 'string'
        ? resource.config['cardholder_id']
        : null;

    await this.stripe.issuing.cards.update(resource.providerRef, { status: 'canceled' });

    if (cardholderId) {
      await this.stripe.issuing.cardholders.update(cardholderId, { status: 'inactive' });
    }

    return {};
  }

  performAction(
    _resource: Resource,
    action: string,
    _payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return Promise.reject(new Error(`Unsupported action for stripe card resource: ${action}`));
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean> {
    try {
      this.stripe.webhooks.constructEvent(
        rawBody,
        headers['stripe-signature'] ?? '',
        this.webhookSecret,
      );
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string>): Promise<ParsedWebhookEvent[]> {
    let payload: StripeEventPayload;
    try {
      payload = JSON.parse(rawBody.toString()) as StripeEventPayload;
    } catch {
      return Promise.resolve([]);
    }

    const occurredAt = new Date(payload.created * 1000);

    if (payload.type === 'issuing_authorization.created') {
      const auth = payload.data.object as StripeAuthObject;
      const cardId = getExpandableId(auth.card);
      const eventType = auth.approved
        ? EVENT_TYPES.PAYMENT_CARD_AUTHORIZED
        : EVENT_TYPES.PAYMENT_CARD_DECLINED;

      return Promise.resolve([
        {
          resourceRef: cardId,
          provider: this.providerName,
          providerEventId: payload.id,
          eventType,
          occurredAt,
          data: {
            authorization_id: auth.id,
            amount: Math.abs(auth.amount),
            currency: auth.currency.toUpperCase(),
          },
        },
      ]);
    }

    if (payload.type === 'issuing_transaction.created') {
      const txn = payload.data.object as StripeTransactionObject;
      const cardId = getExpandableId(txn.card);
      const authorizationId = getExpandableId(txn.authorization);

      return Promise.resolve([
        {
          resourceRef: cardId,
          provider: this.providerName,
          providerEventId: payload.id,
          eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
          occurredAt,
          data: {
            transaction_id: txn.id,
            ...(authorizationId !== undefined ? { authorization_id: authorizationId } : {}),
            amount: txn.amount,
            currency: txn.currency.toUpperCase(),
            ...(txn.type ? { transaction_type: txn.type } : {}),
          },
        },
      ]);
    }

    return Promise.resolve([]);
  }
}
