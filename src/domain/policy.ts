import { z } from "zod";

export const resourceConfigSchema = z
	.object({
		allowed_domains: z.array(z.string()).optional(),
		blocked_domains: z.array(z.string()).optional(),
		max_recipients: z.number().int().positive().optional(),
	})
	.loose();

export interface PolicyResult {
	allowed: boolean;
	reasons: string[];
}

export function enforceEmailPolicy(
	config: Record<string, unknown>,
	payload: { to?: string[]; cc?: string[]; bcc?: string[] },
): PolicyResult {
	const reasons: string[] = [];

	const allowedDomains = Array.isArray(config.allowed_domains)
		? (config.allowed_domains as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: undefined;
	const blockedDomains = Array.isArray(config.blocked_domains)
		? (config.blocked_domains as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: undefined;
	const maxRecipients =
		typeof config.max_recipients === "number"
			? config.max_recipients
			: undefined;

	const allRecipients = [
		...(payload.to ?? []),
		...(payload.cc ?? []),
		...(payload.bcc ?? []),
	];

	if (maxRecipients !== undefined && allRecipients.length > maxRecipients) {
		reasons.push(
			`Recipient count ${String(allRecipients.length)} exceeds max_recipients ${String(maxRecipients)}`,
		);
	}

	const getDomain = (email: string) => email.split("@")[1]?.toLowerCase();
	const allowedSet =
		allowedDomains && allowedDomains.length > 0
			? new Set(allowedDomains)
			: null;
	const blockedSet =
		blockedDomains && blockedDomains.length > 0
			? new Set(blockedDomains)
			: null;
	const allowAll = allowedSet?.has("*") ?? false;

	if (allowedSet || blockedSet) {
		for (const r of allRecipients) {
			const domain = getDomain(r);
			if (allowedSet && !allowAll && (!domain || !allowedSet.has(domain))) {
				reasons.push(`Recipient ${r} not in allowed_domains`);
			}
			if (blockedSet && domain && blockedSet.has(domain)) {
				reasons.push(`Recipient ${r} is in blocked_domains`);
			}
		}
	}

	return { allowed: reasons.length === 0, reasons };
}
