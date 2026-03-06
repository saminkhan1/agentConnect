CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"resource_id" varchar(255),
	"provider" text NOT NULL,
	"provider_event_id" text,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"data" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_provider_provider_event_id_unique" ON "events" USING btree ("org_id","provider","provider_event_id") WHERE "events"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_idempotency_key_unique" ON "events" USING btree ("org_id","idempotency_key") WHERE "events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "events_org_agent_occurred_at_idx" ON "events" USING btree ("org_id","agent_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "events_org_type_occurred_at_idx" ON "events" USING btree ("org_id","event_type","occurred_at" desc);