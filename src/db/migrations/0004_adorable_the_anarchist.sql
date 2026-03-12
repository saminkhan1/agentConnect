CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'retry_scheduled', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_delivery_mode" AS ENUM('canonical_event', 'openclaw_hook_agent', 'openclaw_hook_wake');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_status" AS ENUM('active', 'paused');--> statement-breakpoint
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
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_subscription_event_unique" ON "webhook_deliveries" USING btree ("subscription_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("last_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_updated_at_idx" ON "webhook_deliveries" USING btree ("subscription_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_status_idx" ON "webhook_subscriptions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_created_at_idx" ON "webhook_subscriptions" USING btree ("org_id","created_at" desc);