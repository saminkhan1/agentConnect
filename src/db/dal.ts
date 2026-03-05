import { and, eq } from 'drizzle-orm';
import { InferInsertModel } from 'drizzle-orm';

import { db } from './index';
import { agents, apiKeys, orgs } from './schema';

type NewAgent = InferInsertModel<typeof agents>;
type NewApiKey = InferInsertModel<typeof apiKeys>;

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

  async findById(id: string) {
    const result = await db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, this.orgId), eq(agents.id, id)))
      .limit(1);
    return result[0] || null;
  }

  async findMany() {
    return db.select().from(agents).where(eq(agents.orgId, this.orgId));
  }

  async insert(data: Omit<NewAgent, 'orgId'>) {
    const result = await db
      .insert(agents)
      .values({ ...data, orgId: this.orgId })
      .returning();
    return result[0];
  }

  async updateById(id: string, data: Partial<Omit<NewAgent, 'orgId' | 'id'>>) {
    const result = await db
      .update(agents)
      .set(data)
      .where(and(eq(agents.orgId, this.orgId), eq(agents.id, id)))
      .returning();
    return result[0] || null;
  }

  async deleteById(id: string) {
    const result = await db
      .delete(agents)
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
}

// Admin / System DAL without org scope restriction
export const systemDal = {
  async createOrg(data: InferInsertModel<typeof orgs>) {
    const result = await db.insert(orgs).values(data).returning();
    return result[0];
  },
  async getOrg(id: string) {
    const result = await db.select().from(orgs).where(eq(orgs.id, id)).limit(1);
    return result[0] || null;
  },
};
