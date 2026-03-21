import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
	stripeIssuingAllowedCategorySchema,
	stripeIssuingBlockedCategorySchema,
	stripeIssuingMerchantCountrySchema,
	stripeIssuingSpendingLimitSchema,
} from "../../domain/stripe-issuing.js";
import { injectWithStatusOrThrow } from "../errors.js";
import type { McpSessionContext } from "../server.js";
import {
	resolveToolAuthorization,
	withOptionalAuthorizationSchema,
} from "./auth.js";

type IssuedCardMetadata = {
	exp_month: number;
	exp_year: number;
	last4: string;
	currency: string;
};

type IssueCardResponse = {
	resource: unknown;
	card: IssuedCardMetadata;
	event: unknown;
};

type CardDetailsSession = {
	resource_id: string;
	card_id: string;
	ephemeral_key_secret: string;
	expires_at: number;
	livemode: boolean;
	stripe_api_version: string;
};

type CreateCardDetailsSessionResponse = { session: CardDetailsSession };
type PendingIssueCardResponse = { status: "pending"; message: string };

function isIssuedCardMetadata(value: unknown): value is IssuedCardMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { exp_month?: unknown }).exp_month === "number" &&
		typeof (value as { exp_year?: unknown }).exp_year === "number" &&
		typeof (value as { last4?: unknown }).last4 === "string" &&
		typeof (value as { currency?: unknown }).currency === "string"
	);
}

function isIssueCardResponse(value: unknown): value is IssueCardResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"resource" in value &&
		"event" in value &&
		isIssuedCardMetadata((value as { card?: unknown }).card)
	);
}

function isCardDetailsSession(value: unknown): value is CardDetailsSession {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { resource_id?: unknown }).resource_id === "string" &&
		typeof (value as { card_id?: unknown }).card_id === "string" &&
		typeof (value as { ephemeral_key_secret?: unknown })
			.ephemeral_key_secret === "string" &&
		typeof (value as { expires_at?: unknown }).expires_at === "number" &&
		typeof (value as { livemode?: unknown }).livemode === "boolean" &&
		typeof (value as { stripe_api_version?: unknown }).stripe_api_version ===
			"string"
	);
}

function isCreateCardDetailsSessionResponse(
	value: unknown,
): value is CreateCardDetailsSessionResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		isCardDetailsSession((value as { session?: unknown }).session)
	);
}

function extractPendingMessage(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	return typeof (value as { message?: unknown }).message === "string"
		? (value as { message: string }).message
		: null;
}

function buildPendingIssueCardResponse(
	message: string,
): PendingIssueCardResponse {
	return {
		status: "pending",
		message,
	};
}

export function registerPaymentTools(
	server: McpServer,
	fastify: FastifyInstance,
	session: McpSessionContext,
) {
	server.registerTool(
		"agentinfra.payments.issue_card",
		{
			description:
				"Issue a virtual payment card for an agent with configurable spending limits and merchant restrictions. Returns safe metadata only — use create_card_details_session to access full card numbers.",
			inputSchema: withOptionalAuthorizationSchema(session, {
				agent_id: z.string().min(1).describe("Agent ID"),
				cardholder_name: z
					.string()
					.min(1)
					.max(24)
					.describe("Name printed on the card"),
				billing_address: z.object({
					line1: z.string().min(1),
					line2: z.string().min(1).optional(),
					city: z.string().min(1),
					state: z.string().min(1).optional(),
					postal_code: z.string().min(1),
					country: stripeIssuingMerchantCountrySchema.describe(
						"ISO 3166-1 alpha-2 country code",
					),
				}),
				currency: z.string().length(3).describe("3-letter ISO currency code"),
				spending_limits: z
					.array(stripeIssuingSpendingLimitSchema)
					.optional()
					.describe("Stripe spending limits"),
				allowed_categories: z
					.array(stripeIssuingAllowedCategorySchema)
					.optional()
					.describe("Allowed MCC categories"),
				blocked_categories: z
					.array(stripeIssuingBlockedCategorySchema)
					.optional()
					.describe("Blocked MCC categories"),
				allowed_merchant_countries: z
					.array(stripeIssuingMerchantCountrySchema)
					.optional()
					.describe("Allowed 2-letter merchant country codes"),
				blocked_merchant_countries: z
					.array(stripeIssuingMerchantCountrySchema)
					.optional()
					.describe("Blocked 2-letter merchant country codes"),
				idempotency_key: z.string().optional().describe("Idempotency key"),
			}),
		},
		async ({
			agent_id,
			cardholder_name,
			billing_address,
			currency,
			spending_limits,
			allowed_categories,
			blocked_categories,
			allowed_merchant_countries,
			blocked_merchant_countries,
			idempotency_key,
			authorization,
		}) => {
			const authHeader = resolveToolAuthorization(session, authorization);
			const body: Record<string, unknown> = {
				cardholder_name,
				billing_address,
				currency,
			};
			if (spending_limits !== undefined) body.spending_limits = spending_limits;
			if (allowed_categories !== undefined)
				body.allowed_categories = allowed_categories;
			if (blocked_categories !== undefined)
				body.blocked_categories = blocked_categories;
			if (allowed_merchant_countries !== undefined) {
				body.allowed_merchant_countries = allowed_merchant_countries;
			}
			if (blocked_merchant_countries !== undefined) {
				body.blocked_merchant_countries = blocked_merchant_countries;
			}
			if (idempotency_key !== undefined) body.idempotency_key = idempotency_key;

			const { statusCode, data } = await injectWithStatusOrThrow(fastify, {
				method: "POST",
				url: `/agents/${agent_id}/actions/issue_card`,
				headers: {
					authorization: authHeader,
					"content-type": "application/json",
				},
				payload: JSON.stringify(body),
			});

			if (!isIssueCardResponse(data)) {
				const pending = buildPendingIssueCardResponse(
					statusCode === 202
						? (extractPendingMessage(data) ??
								"Card issuance is still in progress")
						: "Card issuance is still in progress",
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(pending, null, 2) },
					],
					structuredContent: pending,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{ resource: data.resource, card: data.card, event: data.event },
							null,
							2,
						),
					},
				],
				structuredContent: {
					resource: data.resource,
					card: data.card,
					event: data.event,
				},
			};
		},
	);

	if (
		session.auth?.key_type === "root" ||
		(!session.auth && session.allowToolAuthorizationFallback)
	) {
		server.registerTool(
			"agentinfra.payments.create_card_details_session",
			{
				description:
					"Create a short-lived session to securely access full card details (PAN, CVC, expiry) via Stripe.js Issuing Elements. Requires root-key auth and a Stripe.js nonce.",
				inputSchema: withOptionalAuthorizationSchema(session, {
					agent_id: z.string().min(1).describe("Agent ID"),
					resource_id: z.string().min(1).describe("Stripe card resource ID"),
					nonce: z.string().min(1).describe("Stripe.js Issuing Elements nonce"),
				}),
			},
			async ({ agent_id, resource_id, nonce, authorization }) => {
				const authHeader = resolveToolAuthorization(session, authorization);

				const { data } = await injectWithStatusOrThrow(fastify, {
					method: "POST",
					url: `/agents/${agent_id}/actions/create_card_details_session`,
					headers: {
						authorization: authHeader,
						"content-type": "application/json",
					},
					payload: JSON.stringify({ resource_id, nonce }),
				});

				if (!isCreateCardDetailsSessionResponse(data)) {
					throw new Error("Unexpected card details session response");
				}

				const { ephemeral_key_secret: _, ...safeSession } = data.session;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ session: safeSession }, null, 2),
						},
					],
					structuredContent: { session: data.session },
				};
			},
		);
	}
}
