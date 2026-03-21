CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'personal', 'power');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'active', 'trialing', 'past_due', 'canceled', 'unpaid');--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "plan_tier" "plan_tier" DEFAULT 'starter' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "subscription_status" "subscription_status" DEFAULT 'incomplete' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "current_period_end" timestamp with time zone;