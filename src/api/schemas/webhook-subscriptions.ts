import { z } from 'zod';

import { eventTypeSchema } from '../../domain/events';
import {
  outboundWebhookCreateInputSchema,
  outboundWebhookStaticHeadersSchema,
  webhookDeliveryStatusSchema,
  webhookSubscriptionDeliveryModeSchema,
  webhookSubscriptionStatusSchema,
} from '../../domain/outbound-webhooks';

export const createWebhookSubscriptionBodySchema = outboundWebhookCreateInputSchema;

export const webhookSubscriptionResponseSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  url: z.url(),
  eventTypes: z.array(eventTypeSchema),
  deliveryMode: webhookSubscriptionDeliveryModeSchema,
  deliveryConfig: z.record(z.string(), z.unknown()),
  staticHeaders: outboundWebhookStaticHeadersSchema,
  status: webhookSubscriptionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createWebhookSubscriptionResponseSchema = z.object({
  subscription: webhookSubscriptionResponseSchema,
  signingSecret: z.string().min(1),
});

export const webhookSubscriptionDeliveriesParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const webhookSubscriptionDeliveriesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const webhookDeliveryResponseSchema = z.object({
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  eventId: z.uuid(),
  eventType: eventTypeSchema,
  agentId: z.string().min(1),
  resourceId: z.string().nullable(),
  occurredAt: z.iso.datetime(),
  attemptCount: z.number().int().min(0),
  lastStatus: webhookDeliveryStatusSchema,
  nextAttemptAt: z.iso.datetime(),
  lastResponseStatusCode: z.number().int().nullable(),
  lastResponseBody: z.string().nullable(),
  lastRequestHeaders: z.record(z.string(), z.string()),
  lastPayload: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.record(z.string(), z.unknown()).nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const listWebhookDeliveriesResponseSchema = z.object({
  deliveries: z.array(webhookDeliveryResponseSchema),
});
