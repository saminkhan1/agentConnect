import { and, count, eq, gte, ne } from "drizzle-orm";
import { db } from "../db";
import { agents, outboundActions, resources } from "../db/schema";
import type { PlanTier } from "./billing";
import { AppError } from "./errors";

type PlanLimits = {
	maxAgents: number;
	maxInboxes: number;
	maxEmailsPerMonth: number;
	maxCardsPerMonth: number;
};

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
	starter: {
		maxAgents: 1,
		maxInboxes: 1,
		maxEmailsPerMonth: 1_000,
		maxCardsPerMonth: 5,
	},
	personal: {
		maxAgents: 1,
		maxInboxes: 1,
		maxEmailsPerMonth: 2_000,
		maxCardsPerMonth: 15,
	},
	power: {
		maxAgents: 3,
		maxInboxes: 3,
		maxEmailsPerMonth: 5_000,
		maxCardsPerMonth: 50,
	},
};

export function getPlanLimits(tier: PlanTier): PlanLimits {
	return PLAN_LIMITS[tier];
}

function startOfMonth(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function enforceAgentLimit(
	orgId: string,
	planTier: PlanTier,
): Promise<void> {
	const limits = getPlanLimits(planTier);
	const result = await db
		.select({ value: count() })
		.from(agents)
		.where(and(eq(agents.orgId, orgId), eq(agents.isArchived, false)));

	const current = result[0]?.value ?? 0;
	if (current >= limits.maxAgents) {
		throw new AppError(
			"QUOTA_EXCEEDED",
			402,
			`Agent limit reached (${limits.maxAgents} on ${planTier} plan). Upgrade your plan for more agents.`,
		);
	}
}

export async function enforceInboxLimit(
	orgId: string,
	planTier: PlanTier,
): Promise<void> {
	const limits = getPlanLimits(planTier);
	const result = await db
		.select({ value: count() })
		.from(resources)
		.where(
			and(
				eq(resources.orgId, orgId),
				eq(resources.type, "email_inbox"),
				ne(resources.state, "deleted"),
			),
		);

	const current = result[0]?.value ?? 0;
	if (current >= limits.maxInboxes) {
		throw new AppError(
			"QUOTA_EXCEEDED",
			402,
			`Inbox limit reached (${limits.maxInboxes} on ${planTier} plan). Upgrade your plan for more inboxes.`,
		);
	}
}

export async function enforceEmailSendLimit(
	orgId: string,
	planTier: PlanTier,
): Promise<void> {
	const limits = getPlanLimits(planTier);
	const monthStart = startOfMonth();

	const result = await db
		.select({ value: count() })
		.from(outboundActions)
		.where(
			and(
				eq(outboundActions.orgId, orgId),
				eq(outboundActions.action, "send_email"),
				gte(outboundActions.createdAt, monthStart),
			),
		);

	const current = result[0]?.value ?? 0;
	if (current >= limits.maxEmailsPerMonth) {
		throw new AppError(
			"QUOTA_EXCEEDED",
			402,
			`Monthly email limit reached (${limits.maxEmailsPerMonth} on ${planTier} plan). Upgrade your plan for more emails.`,
		);
	}
}

export async function enforceCardLimit(
	orgId: string,
	planTier: PlanTier,
): Promise<void> {
	const limits = getPlanLimits(planTier);
	const monthStart = startOfMonth();

	const result = await db
		.select({ value: count() })
		.from(resources)
		.where(
			and(
				eq(resources.orgId, orgId),
				eq(resources.type, "card"),
				ne(resources.state, "deleted"),
				gte(resources.createdAt, monthStart),
			),
		);

	const current = result[0]?.value ?? 0;
	if (current >= limits.maxCardsPerMonth) {
		throw new AppError(
			"QUOTA_EXCEEDED",
			402,
			`Monthly card limit reached (${limits.maxCardsPerMonth} on ${planTier} plan). Upgrade your plan for more cards.`,
		);
	}
}
