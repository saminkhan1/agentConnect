CREATE TYPE "public"."api_key_type" AS ENUM('root', 'service');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('email.sent', 'email.received', 'email.delivered', 'email.bounced', 'payment.card.issued', 'payment.card.authorized', 'payment.card.declined', 'payment.card.settled');--> statement-breakpoint
CREATE TYPE "public"."resource_state" AS ENUM('provisioning', 'active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('email_inbox', 'card');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"name" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"key_type" "api_key_type" NOT NULL,
	"key_hash" text NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"type" "resource_type" NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "resource_state" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_id_id_unique" ON "agents" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_provider_provider_event_id_unique" ON "events" USING btree ("org_id","provider","provider_event_id") WHERE "events"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_idempotency_key_unique" ON "events" USING btree ("org_id","idempotency_key") WHERE "events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "events_org_agent_occurred_at_idx" ON "events" USING btree ("org_id","agent_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "events_org_type_occurred_at_idx" ON "events" USING btree ("org_id","event_type","occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "resources_org_provider_provider_ref_unique" ON "resources" USING btree ("org_id","provider","provider_ref") WHERE "resources"."provider_ref" is not null;--> statement-breakpoint
CREATE INDEX "resources_org_agent_idx" ON "resources" USING btree ("org_id","agent_id");