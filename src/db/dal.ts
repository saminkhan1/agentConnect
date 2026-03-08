import { and, desc, eq, gte, InferInsertModel, lt, lte, ne, or } from 'drizzle-orm';

import { db } from './index';
import { agents, apiKeys, events, orgs, resources } from './schema';
import type { EventType } from '../domain/events';

type NewAgent = InferInsertModel<typeof agents>;
type NewApiKey = InferInsertModel<typeof apiKeys>;
type NewEvent = InferInsertModel<typeof events>;
type NewOrg = InferInsertModel<typeof orgs>;
type NewResource = InferInsertModel<typeof resources>;
type AgentRecord = typeof agents.$inferSelect;
type OrgRecord = typeof orgs.$inferSelect;
type ApiKeyRecord = typeof apiKeys.$inferSelect;
type EventRecord = typeof events.$inferSelect;
type ResourceRecord = typeof resources.$inferSelect;

type EventCursor = {
  occurredAt: Date;
  id: string;
};

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
