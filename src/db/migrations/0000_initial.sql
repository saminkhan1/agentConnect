CREATE TYPE "api_key_type" AS ENUM ('root', 'service');
CREATE TYPE "event_type" AS ENUM (
  'email.sent',
  'email.received',
  'email.delivered',
  'email.bounced',
  'payment.card.issued',
  'payment.card.authorized',
  'payment.card.declined',
  'payment.card.settled'
);

CREATE TABLE "orgs" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "api_keys" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "org_id" varchar(255) NOT NULL,
  "key_type" "api_key_type" NOT NULL,
  "key_hash" text NOT NULL,
  "is_revoked" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_keys_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id")
);

CREATE TABLE "agents" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "org_id" varchar(255) NOT NULL,
  "name" text NOT NULL,
  "is_archived" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agents_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id")
);

CREATE UNIQUE INDEX "agents_org_id_id_unique" ON "agents" ("org_id", "id");

CREATE TABLE "events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" varchar(255) NOT NULL,
  "agent_id" varchar(255) NOT NULL,
  "resource_id" varchar(255),
  "provider" text NOT NULL,
  "provider_event_id" text,
  "event_type" "event_type" NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "idempotency_key" text,
  "data" jsonb NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "events_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id"),
  CONSTRAINT "events_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id", "agent_id") REFERENCES "agents"("org_id", "id")
);

CREATE UNIQUE INDEX "events_org_provider_provider_event_id_unique" ON "events" ("org_id", "provider", "provider_event_id") WHERE "provider_event_id" IS NOT NULL;
CREATE UNIQUE INDEX "events_org_idempotency_key_unique" ON "events" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "events_org_agent_occurred_at_idx" ON "events" ("org_id", "agent_id", "occurred_at" DESC);
CREATE INDEX "events_org_type_occurred_at_idx" ON "events" ("org_id", "event_type", "occurred_at" DESC);
