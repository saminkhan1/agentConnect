import { desc, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const apiKeyTypeEnum = pgEnum('api_key_type', ['root', 'service']);

export const orgs = pgTable('orgs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 })
    .references(() => orgs.id)
    .notNull(),
  keyType: apiKeyTypeEnum('key_type').notNull(),
  keyHash: text('key_hash').notNull(),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable('agents', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 })
    .references(() => orgs.id)
    .notNull(),
  name: text('name').notNull(),
  isArchived: boolean('is_archived').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    orgId: varchar('org_id', { length: 255 })
      .references(() => orgs.id)
      .notNull(),
    agentId: varchar('agent_id', { length: 255 })
      .references(() => agents.id)
      .notNull(),
    resourceId: varchar('resource_id', { length: 255 }),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id'),
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key'),
    data: jsonb('data').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('events_org_provider_provider_event_id_unique')
      .on(table.orgId, table.provider, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    uniqueIndex('events_org_idempotency_key_unique')
      .on(table.orgId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('events_org_agent_occurred_at_idx').on(
      table.orgId,
      table.agentId,
      desc(table.occurredAt),
    ),
    index('events_org_type_occurred_at_idx').on(
      table.orgId,
      table.eventType,
      desc(table.occurredAt),
    ),
  ],
);
