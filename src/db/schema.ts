import { boolean,pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

export const orgs = pgTable('orgs', {
    id: varchar('id', { length: 255 }).primaryKey(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
    id: varchar('id', { length: 255 }).primaryKey(),
    orgId: varchar('org_id', { length: 255 })
        .references(() => orgs.id)
        .notNull(),
    keyType: varchar('key_type', { length: 50 }).notNull(), // 'root' | 'service'
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agents = pgTable('agents', {
    id: varchar('id', { length: 255 }).primaryKey(),
    orgId: varchar('org_id', { length: 255 })
        .references(() => orgs.id)
        .notNull(),
    name: text('name').notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});
