CREATE TYPE "public"."outbound_action_state" AS ENUM('ready', 'dispatching', 'rejected', 'provider_succeeded', 'completed', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."outbound_action_type" AS ENUM('send_email', 'reply_email');--> statement-breakpoint
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
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_actions_org_action_idempotency_key_unique" ON "outbound_actions" USING btree ("org_id","action","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_actions_org_idempotency_key_idx" ON "outbound_actions" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_actions_org_agent_idx" ON "outbound_actions" USING btree ("org_id","agent_id");