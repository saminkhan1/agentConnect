import crypto from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { EventWriterExecutor } from './event-writer';
import { AppError } from './errors';
import { eventTypeSchema, eventTypeValues, type EventType } from './events';
import { db } from '../db';
import {
  events,
  webhookDeliveries,
  webhookDeliveryStatusEnum,
  webhookSubscriptionDeliveryModeEnum,
  webhookSubscriptions,
  webhookSubscriptionStatusEnum,
} from '../db/schema';

type EventRecord = typeof events.$inferSelect;
type WebhookSubscriptionRecord = typeof webhookSubscriptions.$inferSelect;
type WebhookDeliveryRecord = typeof webhookDeliveries.$inferSelect;

export const OUTBOUND_WEBHOOK_MAX_RETRIES = 3;
export const OUTBOUND_WEBHOOK_LOCK_TTL_MS = 5 * 60 * 1000;
export const OUTBOUND_WEBHOOK_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const OUTBOUND_WEBHOOK_BASE_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BODY_CHARS = 2_000;
const TEST_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();

export const webhookSubscriptionDeliveryModeSchema = z.enum(
  webhookSubscriptionDeliveryModeEnum.enumValues,
);
export const webhookSubscriptionStatusSchema = z.enum(webhookSubscriptionStatusEnum.enumValues);
export const webhookDeliveryStatusSchema = z.enum(webhookDeliveryStatusEnum.enumValues);

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const outboundWebhookStaticHeadersObjectSchema = z
  .object({
    authorization: optionalNonEmptyStringSchema,
    'x-openclaw-token': optionalNonEmptyStringSchema,
  })
  .strict();

export const outboundWebhookStaticHeadersSchema = z.preprocess((value) => {
  if (!isStringRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, headerValue]) => [normalizeHeaderName(name), headerValue]),
  );
}, outboundWebhookStaticHeadersObjectSchema);

export const outboundWebhookEventTypesSchema = z
  .array(eventTypeSchema)
  .min(1)
  .max(eventTypeValues.length);

export const openClawHookAgentDeliveryConfigSchema = z
  .object({
    name: optionalNonEmptyStringSchema,
    agent_id: optionalNonEmptyStringSchema,
    session_key_prefix: nonEmptyStringSchema.regex(/^[A-Za-z0-9:_-]+$/).optional(),
    wake_mode: z.enum(['now', 'next-heartbeat']).optional(),
    deliver: z.boolean().optional(),
    channel: optionalNonEmptyStringSchema,
    to: optionalNonEmptyStringSchema,
    model: optionalNonEmptyStringSchema,
    thinking: optionalNonEmptyStringSchema,
    timeout_seconds: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const openClawHookWakeDeliveryConfigSchema = z
  .object({
    mode: z.enum(['now', 'next-heartbeat']).optional(),
  })
  .strict();

export const canonicalWebhookDeliveryConfigSchema = z.object({}).strict();

export const outboundWebhookCreateInputSchema = z
  .object({
    url: z.string().trim().pipe(z.url()),
    event_types: outboundWebhookEventTypesSchema.optional(),
    delivery_mode: webhookSubscriptionDeliveryModeSchema.optional().default('canonical_event'),
    static_headers: outboundWebhookStaticHeadersSchema.optional().default({}),
    delivery_config: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export type WebhookSubscriptionDeliveryMode = z.infer<typeof webhookSubscriptionDeliveryModeSchema>;
export type WebhookSubscriptionStatus = z.infer<typeof webhookSubscriptionStatusSchema>;
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;
export type OutboundWebhookStaticHeaders = z.infer<typeof outboundWebhookStaticHeadersSchema>;
export type OpenClawHookAgentDeliveryConfig = z.infer<typeof openClawHookAgentDeliveryConfigSchema>;
export type OpenClawHookWakeDeliveryConfig = z.infer<typeof openClawHookWakeDeliveryConfigSchema>;
export type CanonicalWebhookDeliveryConfig = z.infer<typeof canonicalWebhookDeliveryConfigSchema>;
export type OutboundWebhookCreateInput = z.infer<typeof outboundWebhookCreateInputSchema>;
type WebhookTargetAddress = {
  address: string;
  family: number;
};
type ResolveHostname = (hostname: string) => Promise<WebhookTargetAddress[]>;

type CreateWebhookSubscriptionDal = {
  webhookSubscriptions: {
    insert(data: {
      id: string;
      url: string;
      eventTypes: EventType[];
      deliveryMode: WebhookSubscriptionDeliveryMode;
      deliveryConfig: Record<string, unknown>;
      signingSecret: string;
      staticHeaders: Record<string, string>;
      status: WebhookSubscriptionStatus;
    }): Promise<WebhookSubscriptionRecord>;
  };
};

type ListWebhookDeliveriesDal = {
  webhookSubscriptions: {
    findById(id: string): Promise<WebhookSubscriptionRecord | null>;
  };
  webhookDeliveries: {
    listBySubscriptionId(
      subscriptionId: string,
      options: { limit: number },
    ): Promise<WebhookDeliveryListRow[]>;
  };
};

export type WebhookDeliveryListRow = {
  id: string;
  subscriptionId: string;
  eventId: string;
  attemptCount: number;
  lastStatus: WebhookDeliveryStatus;
  nextAttemptAt: Date;
  lastResponseStatusCode: number | null;
  lastResponseBody: string | null;
  lastRequestHeaders: Record<string, string>;
  lastPayload: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  eventType: EventType;
  agentId: string;
  resourceId: string | null;
  occurredAt: Date;
};

export type OutboundCanonicalEvent = {
  id: string;
  org_id: string;
  agent_id: string;
  resource_id: string | null;
  provider: string;
  provider_event_id: string | null;
  event_type: EventType;
  occurred_at: string;
  idempotency_key: string | null;
  data: Record<string, unknown>;
  ingested_at: string;
};

export type OutboundWebhookEnvelope = {
  source: 'agentconnect';
  delivery_mode: WebhookSubscriptionDeliveryMode;
  subscription_id: string;
  event: OutboundCanonicalEvent;
};

export type DeliveryAttemptRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
};

export type DeliveryAttemptOutcome =
  | {
      kind: 'response';
      statusCode: number;
      responseBody: string | null;
    }
  | {
      kind: 'network_error';
      message: string;
    };

export function buildWebhookSubscriptionId() {
  return `whsub_${crypto.randomUUID()}`;
}

export function buildWebhookDeliveryId() {
  return `whdel_${crypto.randomUUID()}`;
}

export function generateWebhookSigningSecret() {
  return `acwhsec_${crypto.randomBytes(24).toString('base64url')}`;
}

export function parseOutboundWebhookAllowedHosts(rawValue?: string) {
  return (rawValue ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function normalizeHeaderName(name: string) {
  return name.trim().toLowerCase();
}

async function resolveWebhookHostname(hostname: string): Promise<WebhookTargetAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizePathnameForMatch(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function redactHeaderValue(name: string, value: string) {
  const normalizedName = normalizeHeaderName(name);
  if (normalizedName === 'authorization') {
    const [scheme] = value.split(/\s+/, 1);
    return scheme ? `${scheme} ***` : '***';
  }

  if (normalizedName === 'x-openclaw-token') {
    return '***';
  }

  return value;
}

export function redactStaticHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      normalizeHeaderName(name),
      redactHeaderValue(name, value),
    ]),
  );
}

function normalizeStaticHeaders(input: OutboundWebhookStaticHeaders) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([name, value]) =>
      value ? [[normalizeHeaderName(name), value]] : [],
    ),
  );
}

function normalizeEventTypes(eventTypes?: EventType[]) {
  const normalizedEventTypes: EventType[] = eventTypes ? [...eventTypes] : [...eventTypeValues];
  return [...new Set(normalizedEventTypes)].sort();
}

function hostMatchesAllowedPattern(hostname: string, pattern: string) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }

  return hostname === pattern;
}

function isAllowlistedHost(hostname: string, allowlistedHosts: string[]) {
  return allowlistedHosts.some((pattern) => hostMatchesAllowedPattern(hostname, pattern));
}

function isLocalHostname(hostname: string) {
  if (TEST_LOCAL_HOSTS.has(hostname)) {
    return true;
  }

  return LOCAL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function isAllowedTestLocalTarget(hostname: string, nodeEnv: string) {
  return nodeEnv === 'test' && TEST_LOCAL_HOSTS.has(hostname);
}

function isPrivateIpv4Address(address: string) {
  const octets = address.split('.').map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isPrivateIpv6Address(address: string) {
  const normalizedAddress = address.toLowerCase();
  if (normalizedAddress === '::' || normalizedAddress === '::1') {
    return true;
  }

  const ipv4MappedAddress = normalizedAddress.includes('.')
    ? normalizedAddress.slice(normalizedAddress.lastIndexOf(':') + 1)
    : null;
  if (ipv4MappedAddress && net.isIP(ipv4MappedAddress) === 4) {
    return isPrivateIpv4Address(ipv4MappedAddress);
  }

  return (
    normalizedAddress.startsWith('fc') ||
    normalizedAddress.startsWith('fd') ||
    normalizedAddress.startsWith('fe8') ||
    normalizedAddress.startsWith('fe9') ||
    normalizedAddress.startsWith('fea') ||
    normalizedAddress.startsWith('feb')
  );
}

function isPrivateResolvedAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    return isPrivateIpv4Address(address);
  }

  if (family === 6) {
    return isPrivateIpv6Address(address);
  }

  return false;
}

function assertAllowedHttpProtocol(
  protocol: string,
  hostname: string,
  allowlistedHosts: string[],
  nodeEnv: string,
) {
  if (protocol === 'https:') {
    return;
  }

  if (
    protocol === 'http:' &&
    (isAllowlistedHost(hostname, allowlistedHosts) || isAllowedTestLocalTarget(hostname, nodeEnv))
  ) {
    return;
  }

  throw new AppError(
    'OUTBOUND_WEBHOOK_URL_INVALID',
    400,
    'Outbound webhook URLs must use HTTPS unless the host is explicitly allowlisted',
  );
}

async function assertSafeHostname(
  hostname: string,
  allowlistedHosts: string[],
  nodeEnv: string,
  resolveHostname: ResolveHostname,
) {
  if (hostname.length === 0) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Outbound webhook URL hostname is required',
    );
  }

  if (
    isAllowlistedHost(hostname, allowlistedHosts) ||
    isAllowedTestLocalTarget(hostname, nodeEnv)
  ) {
    return;
  }

  if (net.isIP(hostname) !== 0) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'IP literal webhook targets must be explicitly allowlisted',
    );
  }

  if (isLocalHostname(hostname)) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Local webhook targets must be explicitly allowlisted',
    );
  }

  let resolvedAddresses: WebhookTargetAddress[];
  try {
    resolvedAddresses = await resolveHostname(hostname);
  } catch {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Outbound webhook URL hostname could not be resolved',
    );
  }

  if (resolvedAddresses.length === 0) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Outbound webhook URL hostname could not be resolved',
    );
  }

  if (resolvedAddresses.some((entry) => isPrivateResolvedAddress(entry.address))) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Outbound webhook targets must not resolve to private or local addresses',
    );
  }
}

export async function validateOutboundWebhookUrl(
  url: string,
  deliveryMode: WebhookSubscriptionDeliveryMode,
  options: {
    allowlistedHosts: string[];
    nodeEnv: string;
    resolveHostname?: ResolveHostname;
  },
) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AppError('OUTBOUND_WEBHOOK_URL_INVALID', 400, 'Outbound webhook URL is invalid');
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (parsedUrl.username || parsedUrl.password) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'Outbound webhook URLs must not include credentials',
    );
  }

  assertAllowedHttpProtocol(
    parsedUrl.protocol,
    hostname,
    options.allowlistedHosts,
    options.nodeEnv,
  );
  await assertSafeHostname(
    hostname,
    options.allowlistedHosts,
    options.nodeEnv,
    options.resolveHostname ?? resolveWebhookHostname,
  );

  const normalizedPathname = normalizePathnameForMatch(parsedUrl.pathname);

  if (deliveryMode === 'openclaw_hook_agent' && !normalizedPathname.endsWith('/agent')) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'OpenClaw agent hook subscriptions must target a path ending in /agent',
    );
  }

  if (deliveryMode === 'openclaw_hook_wake' && !normalizedPathname.endsWith('/wake')) {
    throw new AppError(
      'OUTBOUND_WEBHOOK_URL_INVALID',
      400,
      'OpenClaw wake hook subscriptions must target a path ending in /wake',
    );
  }

  return parsedUrl.toString();
}

function parseStoredStaticHeaders(value: unknown) {
  return normalizeStaticHeaders(outboundWebhookStaticHeadersSchema.parse(value));
}

export function parseDeliveryConfig(
  deliveryMode: WebhookSubscriptionDeliveryMode,
  value: unknown,
): Record<string, unknown> {
  switch (deliveryMode) {
    case 'canonical_event':
      return canonicalWebhookDeliveryConfigSchema.parse(value);
    case 'openclaw_hook_agent':
      return openClawHookAgentDeliveryConfigSchema.parse(value);
    case 'openclaw_hook_wake':
      return openClawHookWakeDeliveryConfigSchema.parse(value);
  }
}

function requireOpenClawAuthHeader(
  deliveryMode: WebhookSubscriptionDeliveryMode,
  headers: Record<string, string>,
) {
  if (deliveryMode === 'canonical_event') {
    return;
  }

  if (headers['authorization'] || headers['x-openclaw-token']) {
    return;
  }

  throw new AppError(
    'OUTBOUND_WEBHOOK_HEADERS_INVALID',
    400,
    'OpenClaw hook subscriptions must set either authorization or x-openclaw-token',
  );
}

export function serializeOutboundCanonicalEvent(event: EventRecord): OutboundCanonicalEvent {
  return {
    id: event.id,
    org_id: event.orgId,
    agent_id: event.agentId,
    resource_id: event.resourceId ?? null,
    provider: event.provider,
    provider_event_id: event.providerEventId ?? null,
    event_type: event.eventType,
    occurred_at: event.occurredAt.toISOString(),
    idempotency_key: event.idempotencyKey ?? null,
    data: event.data,
    ingested_at: event.ingestedAt.toISOString(),
  };
}

function buildOpenClawMessageEnvelope(
  subscription: Pick<WebhookSubscriptionRecord, 'id' | 'deliveryMode'>,
  event: EventRecord,
): OutboundWebhookEnvelope {
  return {
    source: 'agentconnect',
    delivery_mode: subscription.deliveryMode,
    subscription_id: subscription.id,
    event: serializeOutboundCanonicalEvent(event),
  };
}

function buildOpenClawAgentPayload(
  subscription: Pick<WebhookSubscriptionRecord, 'id' | 'deliveryMode' | 'deliveryConfig'>,
  event: EventRecord,
) {
  const config = openClawHookAgentDeliveryConfigSchema.parse(subscription.deliveryConfig);
  const message = JSON.stringify(buildOpenClawMessageEnvelope(subscription, event));

  return {
    message,
    ...(config.name ? { name: config.name } : {}),
    ...(config.agent_id ? { agentId: config.agent_id } : {}),
    ...(config.session_key_prefix ? { sessionKey: `${config.session_key_prefix}${event.id}` } : {}),
    ...(config.wake_mode ? { wakeMode: config.wake_mode } : {}),
    ...(config.deliver !== undefined ? { deliver: config.deliver } : {}),
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.to ? { to: config.to } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    ...(config.timeout_seconds ? { timeoutSeconds: config.timeout_seconds } : {}),
  };
}

function buildOpenClawWakePayload(
  subscription: Pick<WebhookSubscriptionRecord, 'id' | 'deliveryMode' | 'deliveryConfig'>,
  event: EventRecord,
) {
  const config = openClawHookWakeDeliveryConfigSchema.parse(subscription.deliveryConfig);

  return {
    text: JSON.stringify(buildOpenClawMessageEnvelope(subscription, event)),
    ...(config.mode ? { mode: config.mode } : {}),
  };
}

export function buildOutboundWebhookPayload(
  subscription: Pick<WebhookSubscriptionRecord, 'id' | 'deliveryMode' | 'deliveryConfig'>,
  event: EventRecord,
) {
  switch (subscription.deliveryMode) {
    case 'canonical_event':
      return buildOpenClawMessageEnvelope(subscription, event);
    case 'openclaw_hook_agent':
      return buildOpenClawAgentPayload(subscription, event);
    case 'openclaw_hook_wake':
      return buildOpenClawWakePayload(subscription, event);
  }
}

export function buildOutboundWebhookSignature(secret: string, timestamp: string, body: string) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function buildDeliveryAttemptRequest(
  subscription: Pick<
    WebhookSubscriptionRecord,
    'id' | 'url' | 'deliveryMode' | 'deliveryConfig' | 'signingSecret' | 'staticHeaders'
  >,
  delivery: Pick<WebhookDeliveryRecord, 'id'>,
  event: EventRecord,
): DeliveryAttemptRequest {
  const payload = buildOutboundWebhookPayload(subscription, event);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildOutboundWebhookSignature(subscription.signingSecret, timestamp, body);
  const staticHeaders = parseStoredStaticHeaders(subscription.staticHeaders);

  return {
    url: subscription.url,
    body,
    payload,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'agentconnect/outbound-webhooks',
      'x-agentconnect-delivery-id': delivery.id,
      'x-agentconnect-delivery-mode': subscription.deliveryMode,
      'x-agentconnect-event-id': event.id,
      'x-agentconnect-signature': `sha256=${signature}`,
      'x-agentconnect-subscription-id': subscription.id,
      'x-agentconnect-timestamp': timestamp,
      ...staticHeaders,
    },
  };
}

export function truncateResponseBody(value: string | null) {
  if (value === null) {
    return null;
  }

  return value.length > MAX_RESPONSE_BODY_CHARS
    ? `${value.slice(0, MAX_RESPONSE_BODY_CHARS)}...`
    : value;
}

export function shouldRetryWebhookDelivery(outcome: DeliveryAttemptOutcome) {
  if (outcome.kind === 'network_error') {
    return true;
  }

  if (outcome.statusCode === 401 || outcome.statusCode === 408 || outcome.statusCode === 429) {
    return true;
  }

  return outcome.statusCode >= 500;
}

export function getWebhookRetryDelayMs(attemptCount: number, random = Math.random) {
  const baseDelay = OUTBOUND_WEBHOOK_BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attemptCount - 1);
  const jitter = Math.floor(random() * OUTBOUND_WEBHOOK_BASE_RETRY_DELAY_MS);
  return baseDelay + jitter;
}

function parseRetryAfterDelayMs(value: string | null, now: Date) {
  if (value === null) {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  if (/^\d+$/.test(trimmedValue)) {
    return Number.parseInt(trimmedValue, 10) * 1000;
  }

  const retryAt = Date.parse(trimmedValue);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  const delayMs = retryAt - now.getTime();
  return delayMs > 0 ? delayMs : null;
}

export class OutboundWebhookService {
  constructor(
    private readonly options: {
      allowlistedHosts: string[];
      nodeEnv: string;
      resolveHostname?: ResolveHostname;
    },
  ) {}

  async createSubscription(dal: CreateWebhookSubscriptionDal, input: OutboundWebhookCreateInput) {
    const parsedInput = outboundWebhookCreateInputSchema.parse(input);
    const eventTypes = normalizeEventTypes(parsedInput.event_types);
    const deliveryMode = parsedInput.delivery_mode;
    const staticHeaders = normalizeStaticHeaders(parsedInput.static_headers);
    const deliveryConfig = parseDeliveryConfig(deliveryMode, parsedInput.delivery_config);
    const url = await validateOutboundWebhookUrl(parsedInput.url, deliveryMode, this.options);

    requireOpenClawAuthHeader(deliveryMode, staticHeaders);

    const signingSecret = generateWebhookSigningSecret();
    const subscription = await dal.webhookSubscriptions.insert({
      id: buildWebhookSubscriptionId(),
      url,
      eventTypes,
      deliveryMode,
      deliveryConfig,
      signingSecret,
      staticHeaders,
      status: 'active',
    });

    return {
      subscription,
      signingSecret,
    };
  }

  async enqueueDeliveriesForEvent(
    dbExecutor: EventWriterExecutor,
    event: Pick<EventRecord, 'id' | 'orgId' | 'eventType'>,
  ) {
    const subscriptions = await dbExecutor
      .select()
      .from(webhookSubscriptions)
      .where(
        and(eq(webhookSubscriptions.orgId, event.orgId), eq(webhookSubscriptions.status, 'active')),
      );

    const matchingSubscriptions = subscriptions.filter((subscription) =>
      subscription.eventTypes.includes(event.eventType),
    );
    if (matchingSubscriptions.length === 0) {
      return;
    }

    const now = new Date();
    await dbExecutor
      .insert(webhookDeliveries)
      .values(
        matchingSubscriptions.map((subscription) => ({
          id: buildWebhookDeliveryId(),
          subscriptionId: subscription.id,
          eventId: event.id,
          attemptCount: 0,
          lastStatus: 'pending' as const,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  async listDeliveries(
    dal: ListWebhookDeliveriesDal,
    subscriptionId: string,
    options: { limit: number },
  ) {
    const subscription = await dal.webhookSubscriptions.findById(subscriptionId);
    if (!subscription) {
      throw new AppError('WEBHOOK_SUBSCRIPTION_NOT_FOUND', 404, 'Webhook subscription not found');
    }

    return dal.webhookDeliveries.listBySubscriptionId(subscriptionId, options);
  }
}

export class OutboundWebhookWorker {
  constructor(
    private readonly options: {
      requestTimeoutMs?: number;
      random?: () => number;
      now?: () => Date;
    } = {},
  ) {}

  async drainOnce(limit = 25) {
    const claimedDeliveries = await db.transaction(async (tx) => {
      const now = this.getNow();
      const lockCutoff = new Date(now.getTime() - OUTBOUND_WEBHOOK_LOCK_TTL_MS);

      const result = await tx.execute<WebhookDeliveryRecord>(sql`
        with due_deliveries as (
          select id
          from webhook_deliveries
          where next_attempt_at <= ${now}
            and last_status in ('pending', 'retry_scheduled')
            and (locked_at is null or locked_at <= ${lockCutoff})
          order by next_attempt_at asc, created_at asc
          limit ${limit}
          for update skip locked
        )
        update webhook_deliveries as deliveries
        set locked_at = ${now}, updated_at = ${now}
        from due_deliveries
        where deliveries.id = due_deliveries.id
        returning deliveries.*
      `);

      return result.rows;
    });

    for (const delivery of claimedDeliveries) {
      await this.processDelivery(delivery);
    }

    return claimedDeliveries.length;
  }

  private getNow() {
    return this.options.now ? this.options.now() : new Date();
  }

  private getRequestTimeoutMs() {
    return this.options.requestTimeoutMs ?? OUTBOUND_WEBHOOK_DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async processDelivery(delivery: WebhookDeliveryRecord) {
    const context = await db
      .select({
        delivery: webhookDeliveries,
        subscription: webhookSubscriptions,
        event: events,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id),
      )
      .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
      .where(eq(webhookDeliveries.id, delivery.id))
      .limit(1);

    if (context.length === 0) {
      return;
    }
    const row = context[0];

    const attemptNumber = row.delivery.attemptCount + 1;
    const request = buildDeliveryAttemptRequest(row.subscription, row.delivery, row.event);
    const requestHeaders = redactStaticHeaders(request.headers);

    let outcome: DeliveryAttemptOutcome;
    let retryAfterHeader: string | null = null;
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
      });

      outcome = {
        kind: 'response',
        statusCode: response.status,
        responseBody: truncateResponseBody(await response.text()),
      };
      retryAfterHeader = response.headers.get('retry-after');
    } catch (error) {
      outcome = {
        kind: 'network_error',
        message: error instanceof Error ? error.message : 'Unknown outbound webhook error',
      };
    }

    if (outcome.kind === 'response' && outcome.statusCode >= 200 && outcome.statusCode < 300) {
      const completedAt = this.getNow();
      await db
        .update(webhookDeliveries)
        .set({
          attemptCount: attemptNumber,
          lastStatus: 'delivered',
          lastResponseStatusCode: outcome.statusCode,
          lastResponseBody: outcome.responseBody,
          lastRequestHeaders: requestHeaders,
          lastPayload: request.payload,
          lastError: null,
          nextAttemptAt: completedAt,
          deliveredAt: completedAt,
          lockedAt: null,
          updatedAt: completedAt,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    const retryable = shouldRetryWebhookDelivery(outcome);
    const hasRetriesRemaining = attemptNumber <= OUTBOUND_WEBHOOK_MAX_RETRIES;
    const shouldRetry = retryable && hasRetriesRemaining;
    const updatedAt = this.getNow();
    const retryDelayMs = getWebhookRetryDelayMs(attemptNumber, this.options.random ?? Math.random);
    const retryAfterDelayMs =
      outcome.kind === 'response' && outcome.statusCode === 429
        ? parseRetryAfterDelayMs(retryAfterHeader, updatedAt)
        : null;
    const nextAttemptAt = shouldRetry
      ? new Date(updatedAt.getTime() + Math.max(retryDelayMs, retryAfterDelayMs ?? 0))
      : updatedAt;

    await db
      .update(webhookDeliveries)
      .set({
        attemptCount: attemptNumber,
        lastStatus: shouldRetry ? 'retry_scheduled' : 'failed',
        nextAttemptAt,
        lastResponseStatusCode: outcome.kind === 'response' ? outcome.statusCode : null,
        lastResponseBody: outcome.kind === 'response' ? outcome.responseBody : null,
        lastRequestHeaders: requestHeaders,
        lastPayload: request.payload,
        lastError:
          outcome.kind === 'network_error'
            ? { kind: 'network_error', message: outcome.message }
            : { kind: 'http_error', status_code: outcome.statusCode },
        lockedAt: null,
        updatedAt,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
}
