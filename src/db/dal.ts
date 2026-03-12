import { and, desc, eq, gte, InferInsertModel, lt, lte, ne, or, sql } from 'drizzle-orm';

import { db } from './index';
import {
  agents,
  apiKeys,
  events,
  orgs,
  outboundActions,
  resources,
  webhookDeliveries,
  webhookSubscriptions,
} from './schema';
import type { EventType } from '../domain/events';
import type { OutboundActionState, OutboundActionType } from '../domain/outbound-actions';
import type { WebhookDeliveryListRow } from '../domain/outbound-webhooks';
import {
  buildTimelineItem,
  type TimelineCursor,
  type TimelineItem,
  type TimelineItemKind,
} from '../domain/timeline';

type NewAgent = InferInsertModel<typeof agents>;
type NewApiKey = InferInsertModel<typeof apiKeys>;
type NewEvent = InferInsertModel<typeof events>;
type NewOrg = InferInsertModel<typeof orgs>;
type NewOutboundAction = InferInsertModel<typeof outboundActions>;
type NewResource = InferInsertModel<typeof resources>;
type NewWebhookDelivery = InferInsertModel<typeof webhookDeliveries>;
type NewWebhookSubscription = InferInsertModel<typeof webhookSubscriptions>;
type AgentRecord = typeof agents.$inferSelect;
type OrgRecord = typeof orgs.$inferSelect;
type ApiKeyRecord = typeof apiKeys.$inferSelect;
type EventRecord = typeof events.$inferSelect;
type OutboundActionRecord = typeof outboundActions.$inferSelect;
type ResourceRecord = typeof resources.$inferSelect;
type WebhookDeliveryRecord = typeof webhookDeliveries.$inferSelect;
type WebhookSubscriptionRecord = typeof webhookSubscriptions.$inferSelect;

type EventCursor = {
  occurredAt: Date;
  id: string;
};

type TimelineGroupRow = {
  itemId: string;
  itemKind: TimelineItemKind;
  groupKey: string;
  occurredAt: Date | string;
};

type TimelineEventRow = {
  itemId: string;
  itemKind: TimelineItemKind;
  groupKey: string;
  eventId: string;
  orgId: string;
  agentId: string;
  resourceId: string | null;
  provider: string;
  providerEventId: string | null;
  eventType: EventType;
  occurredAt: Date | string;
  idempotencyKey: string | null;
  data: Record<string, unknown>;
  ingestedAt: Date | string;
};

// Older action-generated email.sent rows may lack thread_id, so inherit it
// from sibling email events with the same provider-scoped message_id.
const resolvedEmailThreadIdSql = sql`
  coalesce(
    nullif(e.data->>'thread_id', ''),
    max(nullif(e.data->>'thread_id', '')) over (
      partition by e.provider, nullif(e.data->>'message_id', '')
    )
  )
`;

const cardActivityGroupKeySql = sql`
  coalesce(
    nullif(e.data->>'authorization_id', ''),
    nullif(e.data->>'transaction_id', '')
  )
`;

const emailThreadEventTypesSql = sql`e.event_type in (
  'email.sent',
  'email.received',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.rejected'
)`;

const cardActivityEventTypesSql = sql`e.event_type in (
  'payment.card.authorized',
  'payment.card.declined',
  'payment.card.settled'
)`;

const timelineItemKindSql = sql`
  case
    when ${emailThreadEventTypesSql} and ${resolvedEmailThreadIdSql} is not null then 'email_thread'
    when ${cardActivityEventTypesSql} and ${cardActivityGroupKeySql} is not null then 'card_activity'
    else 'event'
  end
`;

const timelineGroupKeySql = sql`
  case
    when ${emailThreadEventTypesSql} and ${resolvedEmailThreadIdSql} is not null then ${resolvedEmailThreadIdSql}
    when ${cardActivityEventTypesSql} and ${cardActivityGroupKeySql} is not null then ${cardActivityGroupKeySql}
    else e.id::text
  end
`;

function normalizeDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requireOrgId(orgId: string): string {
  if (orgId.trim().length === 0) {
    throw new Error('orgId is required');
  }
  return orgId;
}

export class AgentDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findById(id: string): Promise<AgentRecord | null> {
    const result = await db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, this.orgId), eq(agents.id, id)))
      .limit(1);
    return result[0] || null;
  }

  async findMany(options?: { includeArchived?: boolean }): Promise<AgentRecord[]> {
    const includeArchived = options?.includeArchived ?? false;

    if (includeArchived) {
      return db.select().from(agents).where(eq(agents.orgId, this.orgId));
    }

    return db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, this.orgId), eq(agents.isArchived, false)));
  }

  async insert(data: Omit<NewAgent, 'orgId'>): Promise<AgentRecord> {
    const result = await db
      .insert(agents)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async updateById(
    id: string,
    data: Partial<Omit<NewAgent, 'orgId' | 'id'>>,
  ): Promise<AgentRecord | null> {
    const result = await db
      .update(agents)
      .set(data)
      .where(and(eq(agents.orgId, this.orgId), eq(agents.id, id)))
      .returning();
    return result[0] || null;
  }

  async archiveById(id: string): Promise<AgentRecord | null> {
    const result = await db
      .update(agents)
      .set({ isArchived: true })
      .where(and(eq(agents.orgId, this.orgId), eq(agents.id, id)))
      .returning();
    return result[0] || null;
  }
}

export class ApiKeyDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findById(id: string) {
    const result = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, this.orgId), eq(apiKeys.id, id)))
      .limit(1);
    return result[0] || null;
  }

  async findMany() {
    return db.select().from(apiKeys).where(eq(apiKeys.orgId, this.orgId));
  }

  async insert(data: Omit<NewApiKey, 'orgId'>) {
    const result = await db
      .insert(apiKeys)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async deleteById(id: string) {
    const result = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.orgId, this.orgId), eq(apiKeys.id, id)))
      .returning();
    return result[0] || null;
  }
}

export class EventDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async insert(data: Omit<NewEvent, 'orgId'>): Promise<EventRecord> {
    const result = await db
      .insert(events)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<EventRecord | null> {
    const result = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, this.orgId), eq(events.idempotencyKey, idempotencyKey)))
      .limit(1);
    return result[0] ?? null;
  }

  async findById(id: string): Promise<EventRecord | null> {
    const result = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, this.orgId), eq(events.id, id)))
      .limit(1);
    return result[0] ?? null;
  }

  async listByAgent(
    agentId: string,
    options: {
      eventType?: EventType;
      since?: Date;
      until?: Date;
      cursor?: EventCursor;
      limit: number;
    },
  ): Promise<EventRecord[]> {
    const conditions = [eq(events.orgId, this.orgId), eq(events.agentId, agentId)];

    if (options.eventType) {
      conditions.push(eq(events.eventType, options.eventType));
    }

    if (options.since) {
      conditions.push(gte(events.occurredAt, options.since));
    }

    if (options.until) {
      conditions.push(lte(events.occurredAt, options.until));
    }

    if (options.cursor) {
      const cursorCondition = or(
        lt(events.occurredAt, options.cursor.occurredAt),
        and(eq(events.occurredAt, options.cursor.occurredAt), lt(events.id, options.cursor.id)),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    return db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(options.limit);
  }

  async listTimelineByAgent(
    agentId: string,
    options: {
      since?: Date;
      until?: Date;
      cursor?: TimelineCursor;
      limit: number;
    },
  ): Promise<TimelineItem[]> {
    const filters = [sql`e.org_id = ${this.orgId}`, sql`e.agent_id = ${agentId}`];

    if (options.since) {
      filters.push(sql`e.occurred_at >= ${options.since}`);
    }

    if (options.until) {
      filters.push(sql`e.occurred_at <= ${options.until}`);
    }

    const cursorFilter = options.cursor
      ? sql`
          where (
            grouped_items."occurredAt" < ${options.cursor.occurredAt}
            or (
              grouped_items."occurredAt" = ${options.cursor.occurredAt}
              and grouped_items."itemId" < ${options.cursor.id}
            )
          )
        `
      : sql.empty();

    const groupedResult = await db.execute<TimelineGroupRow>(sql`
      with derived_events as (
        select
          ${timelineItemKindSql} as "itemKind",
          ${timelineGroupKeySql} as "groupKey",
          e.occurred_at as "occurredAt"
        from events e
        where ${sql.join(filters, sql` and `)}
      ),
      grouped_items as (
        select
          "itemKind",
          "groupKey",
          -- Keep this base64url transform aligned with encodeTimelineItemId():
          -- translate('/+', '_-') maps '/' -> '_' and '+' -> '-'.
          rtrim(
            translate(
              encode(convert_to(array_to_json(array["itemKind", "groupKey"])::text, 'UTF8'), 'base64'),
              '/+',
              '_-'
            ),
            '='
          ) as "itemId",
          max("occurredAt") as "occurredAt"
        from derived_events
        group by "itemKind", "groupKey"
      )
      select
        grouped_items."itemId",
        grouped_items."itemKind",
        grouped_items."groupKey",
        grouped_items."occurredAt"
      from grouped_items
      ${cursorFilter}
      order by grouped_items."occurredAt" desc, grouped_items."itemId" desc
      limit ${options.limit}
    `);

    const groupedRows = groupedResult.rows;
    if (groupedRows.length === 0) {
      return [];
    }

    const selectedGroups = sql.join(
      groupedRows.map(
        (row) => sql`(${row.itemId}, ${row.itemKind}, ${row.groupKey}, ${row.occurredAt})`,
      ),
      sql`, `,
    );

    const eventsResult = await db.execute<TimelineEventRow>(sql`
      with derived_events as (
        select
          ${timelineItemKindSql} as "itemKind",
          ${timelineGroupKeySql} as "groupKey",
          e.id as "eventId",
          e.org_id as "orgId",
          e.agent_id as "agentId",
          e.resource_id as "resourceId",
          e.provider as "provider",
          e.provider_event_id as "providerEventId",
          e.event_type as "eventType",
          e.occurred_at as "occurredAt",
          e.idempotency_key as "idempotencyKey",
          e.data as "data",
          e.ingested_at as "ingestedAt"
        from events e
        where ${sql.join(filters, sql` and `)}
      ),
      selected_groups("itemId", "itemKind", "groupKey", "itemOccurredAt") as (
        values ${selectedGroups}
      )
      select
        selected_groups."itemId",
        selected_groups."itemKind",
        selected_groups."groupKey",
        derived_events."eventId",
        derived_events."orgId",
        derived_events."agentId",
        derived_events."resourceId",
        derived_events."provider",
        derived_events."providerEventId",
        derived_events."eventType",
        derived_events."occurredAt",
        derived_events."idempotencyKey",
        derived_events."data",
        derived_events."ingestedAt"
      from derived_events
      join selected_groups
        on derived_events."itemKind" = selected_groups."itemKind"
        and derived_events."groupKey" = selected_groups."groupKey"
      order by
        selected_groups."itemOccurredAt" desc,
        selected_groups."itemId" desc,
        derived_events."occurredAt" desc,
        derived_events."eventId" desc
    `);

    const eventsByItemId = new Map<string, EventRecord[]>();
    for (const row of eventsResult.rows) {
      let groupedEvents = eventsByItemId.get(row.itemId);
      if (!groupedEvents) {
        groupedEvents = [];
        eventsByItemId.set(row.itemId, groupedEvents);
      }

      groupedEvents.push({
        id: row.eventId,
        orgId: row.orgId,
        agentId: row.agentId,
        resourceId: row.resourceId,
        provider: row.provider,
        providerEventId: row.providerEventId,
        eventType: row.eventType,
        occurredAt: normalizeDate(row.occurredAt),
        idempotencyKey: row.idempotencyKey,
        data: row.data,
        ingestedAt: normalizeDate(row.ingestedAt),
      });
    }

    return groupedRows.flatMap((row) => {
      const groupedEvents = eventsByItemId.get(row.itemId);
      if (!groupedEvents) {
        return [];
      }

      return [buildTimelineItem(row.itemKind, row.groupKey, groupedEvents, row.itemId)];
    });
  }
}

export class OutboundActionDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OutboundActionRecord | null> {
    const result = await db
      .select()
      .from(outboundActions)
      .where(
        and(
          eq(outboundActions.orgId, this.orgId),
          eq(outboundActions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return result[0] ?? null;
  }

  async insert(
    data: Omit<NewOutboundAction, 'orgId' | 'id' | 'createdAt' | 'updatedAt'> & { id: string },
  ): Promise<OutboundActionRecord> {
    const result = await db
      .insert(outboundActions)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async updateById(
    id: string,
    data: Partial<
      Omit<
        NewOutboundAction,
        'orgId' | 'id' | 'createdAt' | 'updatedAt' | 'action' | 'idempotencyKey'
      >
    >,
  ): Promise<OutboundActionRecord | null> {
    const result = await db
      .update(outboundActions)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(outboundActions.orgId, this.orgId), eq(outboundActions.id, id)))
      .returning();
    return result[0] ?? null;
  }

  async createReady(input: {
    id: string;
    agentId: string;
    resourceId: string;
    provider: string;
    action: OutboundActionType;
    idempotencyKey: string;
    requestHash: string;
    requestData: Record<string, unknown>;
  }): Promise<OutboundActionRecord> {
    return this.insert({
      ...input,
      providerResult: null,
      eventId: null,
      lastError: null,
      state: 'ready',
    });
  }

  async transitionState(
    id: string,
    state: OutboundActionState,
    updates?: {
      requestData?: Record<string, unknown>;
      providerResult?: Record<string, unknown> | null;
      eventId?: string | null;
      lastError?: Record<string, unknown> | null;
    },
  ): Promise<OutboundActionRecord | null> {
    return this.updateById(id, {
      state,
      requestData: updates?.requestData,
      providerResult: updates?.providerResult,
      eventId: updates?.eventId,
      lastError: updates?.lastError,
    });
  }
}

export class ResourceDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findById(id: string): Promise<ResourceRecord | null> {
    const result = await db
      .select()
      .from(resources)
      .where(and(eq(resources.orgId, this.orgId), eq(resources.id, id)))
      .limit(1);
    return result[0] || null;
  }

  async findByAgentId(agentId: string): Promise<ResourceRecord[]> {
    return db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.orgId, this.orgId),
          eq(resources.agentId, agentId),
          ne(resources.state, 'deleted'),
        ),
      );
  }

  async findActiveByAgentIdAndType(
    agentId: string,
    type: ResourceRecord['type'],
    provider: string,
  ): Promise<ResourceRecord | null> {
    const result = await db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.orgId, this.orgId),
          eq(resources.agentId, agentId),
          eq(resources.type, type),
          eq(resources.provider, provider),
          eq(resources.state, 'active'),
        ),
      )
      .limit(1);
    return result[0] ?? null;
  }

  async insert(data: Omit<NewResource, 'orgId'>): Promise<ResourceRecord> {
    const result = await db
      .insert(resources)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async updateById(
    id: string,
    data: Partial<Omit<NewResource, 'orgId' | 'id'>>,
  ): Promise<ResourceRecord | null> {
    const result = await db
      .update(resources)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(resources.orgId, this.orgId), eq(resources.id, id)))
      .returning();
    return result[0] || null;
  }
}

export class WebhookSubscriptionDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findById(id: string): Promise<WebhookSubscriptionRecord | null> {
    const result = await db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.orgId, this.orgId), eq(webhookSubscriptions.id, id)))
      .limit(1);
    return result[0] ?? null;
  }

  async insert(
    data: Omit<NewWebhookSubscription, 'orgId' | 'createdAt' | 'updatedAt'>,
  ): Promise<WebhookSubscriptionRecord> {
    const now = new Date();
    const result = await db
      .insert(webhookSubscriptions)
      .values({
        ...data,
        orgId: this.orgId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return result[0];
  }
}

export class WebhookDeliveryDal {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  async findById(id: string): Promise<WebhookDeliveryRecord | null> {
    const result = await db
      .select({
        delivery: webhookDeliveries,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id),
      )
      .where(and(eq(webhookSubscriptions.orgId, this.orgId), eq(webhookDeliveries.id, id)))
      .limit(1);
    return result[0]?.delivery ?? null;
  }

  async insert(
    data: Omit<NewWebhookDelivery, 'createdAt' | 'updatedAt'>,
  ): Promise<WebhookDeliveryRecord> {
    const now = new Date();
    const result = await db
      .insert(webhookDeliveries)
      .values({
        ...data,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return result[0];
  }

  async listBySubscriptionId(
    subscriptionId: string,
    options: { limit: number },
  ): Promise<WebhookDeliveryListRow[]> {
    const rows = await db
      .select({
        id: webhookDeliveries.id,
        subscriptionId: webhookDeliveries.subscriptionId,
        eventId: webhookDeliveries.eventId,
        attemptCount: webhookDeliveries.attemptCount,
        lastStatus: webhookDeliveries.lastStatus,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        lastResponseStatusCode: webhookDeliveries.lastResponseStatusCode,
        lastResponseBody: webhookDeliveries.lastResponseBody,
        lastRequestHeaders: webhookDeliveries.lastRequestHeaders,
        lastPayload: webhookDeliveries.lastPayload,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
        updatedAt: webhookDeliveries.updatedAt,
        eventType: events.eventType,
        agentId: events.agentId,
        resourceId: events.resourceId,
        occurredAt: events.occurredAt,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id),
      )
      .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
      .where(
        and(
          eq(webhookSubscriptions.orgId, this.orgId),
          eq(webhookDeliveries.subscriptionId, subscriptionId),
        ),
      )
      .orderBy(desc(webhookDeliveries.updatedAt), desc(webhookDeliveries.id))
      .limit(options.limit);

    return rows.map((row) => ({
      ...row,
      lastRequestHeaders: row.lastRequestHeaders,
      lastPayload: row.lastPayload ?? null,
      lastError: row.lastError ?? null,
      deliveredAt: row.deliveredAt ?? null,
      resourceId: row.resourceId ?? null,
    }));
  }
}

export class DalFactory {
  private readonly orgId: string;

  constructor(orgId: string) {
    this.orgId = requireOrgId(orgId);
  }

  get agents() {
    return new AgentDal(this.orgId);
  }

  get apiKeys() {
    return new ApiKeyDal(this.orgId);
  }

  get events() {
    return new EventDal(this.orgId);
  }

  get resources() {
    return new ResourceDal(this.orgId);
  }

  get outboundActions() {
    return new OutboundActionDal(this.orgId);
  }

  get webhookSubscriptions() {
    return new WebhookSubscriptionDal(this.orgId);
  }

  get webhookDeliveries() {
    return new WebhookDeliveryDal(this.orgId);
  }
}

export const systemDal = {
  async findResourceByProviderRef(
    provider: string,
    providerRef: string,
    providerOrgId?: string,
  ): Promise<ResourceRecord | null> {
    const conditions = [
      eq(resources.provider, provider),
      eq(resources.providerRef, providerRef),
      ne(resources.state, 'deleted'),
    ];
    if (providerOrgId) {
      conditions.push(eq(resources.providerOrgId, providerOrgId));
    }
    const rows = await db
      .select()
      .from(resources)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ?? null;
  },
  async createOrg(data: InferInsertModel<typeof orgs>): Promise<OrgRecord> {
    const result = await db.insert(orgs).values(data).returning();
    return result[0];
  },
  async createOrgWithApiKey(data: { org: NewOrg; apiKey: Omit<NewApiKey, 'orgId'> }): Promise<{
    org: OrgRecord;
    apiKey: ApiKeyRecord;
  }> {
    return db.transaction(async (tx) => {
      const orgResult = await tx.insert(orgs).values(data.org).returning();
      const org = orgResult[0];

      const keyResult = await tx
        .insert(apiKeys)
        .values({ ...data.apiKey, orgId: org.id })
        .returning();
      const apiKey = keyResult[0];

      return {
        org,
        apiKey,
      };
    });
  },
  async getOrg(id: string): Promise<OrgRecord | null> {
    const result = await db.select().from(orgs).where(eq(orgs.id, id)).limit(1);
    return result[0] || null;
  },
  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const result = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return result[0] || null;
  },
};
