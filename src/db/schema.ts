import { desc, sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
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

import { eventTypeValues } from '../domain/events';

export const apiKeyTypeEnum = pgEnum('api_key_type', ['root', 'service']);
export const eventTypeEnum = pgEnum('event_type', eventTypeValues);
export const resourceTypeEnum = pgEnum('resource_type', ['email_inbox', 'card']);
export const resourceStateEnum = pgEnum('resource_state', [
  'provisioning',
  'active',
  'suspended',
  'deleted',
]);
export const outboundActionTypeEnum = pgEnum('outbound_action_type', ['send_email', 'reply_email']);
export const outboundActionStateEnum = pgEnum('outbound_action_state', [
  'ready',
  'dispatching',
  'rejected',
  'provider_succeeded',
  'completed',
  'ambiguous',
]);

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

export const agents = pgTable(
  'agents',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    orgId: varchar('org_id', { length: 255 })
      .references(() => orgs.id)
      .notNull(),
    name: text('name').notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('agents_org_id_id_unique').on(table.orgId, table.id)],
);

export const resources = pgTable(
  'resources',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    orgId: varchar('org_id', { length: 255 })
      .references(() => orgs.id)
      .notNull(),
    agentId: varchar('agent_id', { length: 255 }).notNull(),
    type: resourceTypeEnum('type').notNull(),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref'),
    providerOrgId: text('provider_org_id'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    state: resourceStateEnum('state').notNull().default('provisioning'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.agentId],
      foreignColumns: [agents.orgId, agents.id],
    }),
    uniqueIndex('resources_org_provider_provider_ref_unique')
      .on(table.orgId, table.provider, table.providerRef)
      .where(sql`${table.providerRef} is not null`),
    index('resources_org_agent_idx').on(table.orgId, table.agentId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    orgId: varchar('org_id', { length: 255 })
      .references(() => orgs.id)
      .notNull(),
    agentId: varchar('agent_id', { length: 255 }).notNull(),
    resourceId: varchar('resource_id', { length: 255 }),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id'),
    eventType: eventTypeEnum('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.agentId],
      foreignColumns: [agents.orgId, agents.id],
      name: 'events_org_id_agent_id_agents_org_id_id_fk',
    }),
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

export const outboundActions = pgTable(
  'outbound_actions',
  {
    id: uuid('id').primaryKey(),
    orgId: varchar('org_id', { length: 255 })
      .references(() => orgs.id)
      .notNull(),
    agentId: varchar('agent_id', { length: 255 }).notNull(),
    resourceId: varchar('resource_id', { length: 255 }).notNull(),
    provider: text('provider').notNull(),
    action: outboundActionTypeEnum('action').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    requestData: jsonb('request_data').$type<Record<string, unknown>>().notNull().default({}),
    providerResult: jsonb('provider_result').$type<Record<string, unknown>>(),
    eventId: uuid('event_id'),
    lastError: jsonb('last_error').$type<Record<string, unknown>>(),
    state: outboundActionStateEnum('state').notNull().default('ready'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.agentId],
      foreignColumns: [agents.orgId, agents.id],
      name: 'outbound_actions_org_id_agent_id_agents_org_id_id_fk',
    }),
    uniqueIndex('outbound_actions_org_action_idempotency_key_unique').on(
      table.orgId,
      table.action,
      table.idempotencyKey,
    ),
    index('outbound_actions_org_idempotency_key_idx').on(table.orgId, table.idempotencyKey),
    index('outbound_actions_org_agent_idx').on(table.orgId, table.agentId),
    index('outbound_actions_org_state_idx').on(table.orgId, table.state),
  ],
);
