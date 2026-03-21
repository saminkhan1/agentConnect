CREATE TYPE "public"."api_key_type" AS ENUM('root', 'service');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('email.sent', 'email.received', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'payment.card.issued', 'payment.card.authorized', 'payment.card.declined', 'payment.card.settled');--> statement-breakpoint
CREATE TYPE "public"."outbound_action_state" AS ENUM('ready', 'dispatching', 'rejected', 'provider_succeeded', 'completed', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."outbound_action_type" AS ENUM('send_email', 'reply_email');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'personal', 'power');--> statement-breakpoint
CREATE TYPE "public"."resource_state" AS ENUM('provisioning', 'active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('email_inbox', 'card');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'active', 'trialing', 'past_due', 'canceled', 'unpaid');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'retry_scheduled', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_delivery_mode" AS ENUM('canonical_event', 'openclaw_hook_agent', 'openclaw_hook_wake');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_status" AS ENUM('active', 'paused');--> statement-breakpoint
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
	"plan_tier" "plan_tier" DEFAULT 'starter' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" "subscription_status" DEFAULT 'incomplete' NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"resource_id" varchar(255) NOT NULL,
	"provider" text NOT NULL,
	"action" "outbound_action_type" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_result" jsonb,
	"event_id" uuid,
	"last_error" jsonb,
	"state" "outbound_action_state" DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"type" "resource_type" NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"provider_org_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "resource_state" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"subscription_id" varchar(255) NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_response_status_code" integer,
	"last_response_body" text,
	"last_request_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_payload" jsonb,
	"last_error" jsonb,
	"delivered_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"delivery_mode" "webhook_subscription_delivery_mode" DEFAULT 'canonical_event' NOT NULL,
	"delivery_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signing_secret" text NOT NULL,
	"static_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "webhook_subscription_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_id_id_unique" ON "agents" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_provider_provider_event_id_unique" ON "events" USING btree ("org_id","provider","provider_event_id") WHERE "events"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_idempotency_key_unique" ON "events" USING btree ("org_id","idempotency_key") WHERE "events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "events_org_agent_occurred_at_idx" ON "events" USING btree ("org_id","agent_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "events_org_type_occurred_at_idx" ON "events" USING btree ("org_id","event_type","occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_actions_org_action_idempotency_key_unique" ON "outbound_actions" USING btree ("org_id","action","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_actions_org_idempotency_key_idx" ON "outbound_actions" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_actions_org_agent_idx" ON "outbound_actions" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "outbound_actions_org_state_idx" ON "outbound_actions" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_org_provider_provider_ref_unique" ON "resources" USING btree ("org_id","provider","provider_ref") WHERE "resources"."provider_ref" is not null;--> statement-breakpoint
CREATE INDEX "resources_org_agent_idx" ON "resources" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_subscription_event_unique" ON "webhook_deliveries" USING btree ("subscription_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("last_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_updated_at_idx" ON "webhook_deliveries" USING btree ("subscription_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_status_idx" ON "webhook_subscriptions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_created_at_idx" ON "webhook_subscriptions" USING btree ("org_id","created_at" desc);
