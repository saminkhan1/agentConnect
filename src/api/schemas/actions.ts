import { z } from "zod";
import {
	stripeIssuingAllowedCategorySchema,
	stripeIssuingBlockedCategorySchema,
	stripeIssuingMerchantCountrySchema,
	stripeIssuingSpendingLimitSchema,
} from "../../domain/stripe-issuing";
import { eventResponseSchema } from "./events";
import { resourceResponseSchema } from "./resources";

const agentParamsSchema = z.object({ id: z.string().min(1) });
const replyToSchema = z.union([z.email(), z.array(z.email()).min(1)]);
const idempotencyKeySchema = z
	.string()
	.trim()
	.min(1, "idempotency_key is required");

export const sendEmailParamsSchema = agentParamsSchema;

export const replyEmailParamsSchema = agentParamsSchema;

export const replyEmailBodySchema = z.object({
	message_id: z.string().min(1),
	text: z.string(),
	html: z.string().optional(),
	cc: z.array(z.email()).optional(),
	bcc: z.array(z.email()).optional(),
	reply_to: replyToSchema.optional(),
	idempotency_key: idempotencyKeySchema,
});

export const replyEmailResponseSchema = z.object({
	event: eventResponseSchema,
});

export const sendEmailBodySchema = z.object({
	to: z.array(z.email()).min(1),
	subject: z.string().min(1),
	text: z.string(),
	html: z.string().optional(),
	cc: z.array(z.email()).optional(),
	bcc: z.array(z.email()).optional(),
	reply_to: replyToSchema.optional(),
	idempotency_key: idempotencyKeySchema,
});

export const sendEmailResponseSchema = z.object({ event: eventResponseSchema });

// ---------------------------------------------------------------------------
// issue_card
// ---------------------------------------------------------------------------

export const issueCardParamsSchema = agentParamsSchema;

const cardholderNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(24)
	.refine((value) => !/\d/.test(value), {
		message: "cardholder_name must not contain numbers",
	});

const billingAddressSchema = z.object({
	line1: z.string().trim().min(1),
	line2: z.string().trim().min(1).optional(),
	city: z.string().trim().min(1),
	state: z.string().trim().min(1).optional(),
	postal_code: z.string().trim().min(1),
	country: stripeIssuingMerchantCountrySchema,
});

const currencySchema = z
	.string()
	.trim()
	.transform((value) => value.toLowerCase())
	.refine((value) => /^[a-z]{3}$/.test(value), {
		message: "currency must be a 3-letter ISO code",
	});

export const issueCardBodySchema = z
	.object({
		cardholder_name: cardholderNameSchema,
		billing_address: billingAddressSchema,
		currency: currencySchema,
		spending_limits: z.array(stripeIssuingSpendingLimitSchema).optional(),
		allowed_categories: z.array(stripeIssuingAllowedCategorySchema).optional(),
		blocked_categories: z.array(stripeIssuingBlockedCategorySchema).optional(),
		allowed_merchant_countries: z
			.array(stripeIssuingMerchantCountrySchema)
			.optional(),
		blocked_merchant_countries: z
			.array(stripeIssuingMerchantCountrySchema)
			.optional(),
		idempotency_key: z.string().min(1).optional(),
	})
	.superRefine((value, context) => {
		if (value.allowed_categories && value.blocked_categories) {
			context.addIssue({
				code: "custom",
				message:
					"allowed_categories and blocked_categories are mutually exclusive",
				path: ["blocked_categories"],
			});
		}

		if (value.allowed_merchant_countries && value.blocked_merchant_countries) {
			context.addIssue({
				code: "custom",
				message:
					"allowed_merchant_countries and blocked_merchant_countries are mutually exclusive",
				path: ["blocked_merchant_countries"],
			});
		}
	});

export const issuedCardMetadataSchema = z.object({
	exp_month: z.number().int().min(1).max(12),
	exp_year: z.number().int().min(2000),
	last4: z.string().regex(/^\d{4}$/, "last4 must be exactly 4 digits"),
	currency: currencySchema,
});

export const issueCardResponseSchema = z.object({
	resource: resourceResponseSchema,
	card: issuedCardMetadataSchema,
	event: eventResponseSchema,
});

export const createCardDetailsSessionParamsSchema = agentParamsSchema;

export const createCardDetailsSessionBodySchema = z.object({
	resource_id: z.string().min(1),
	nonce: z.string().min(1),
});

export const createCardDetailsSessionResponseSchema = z.object({
	session: z.object({
		resource_id: z.string(),
		card_id: z.string(),
		ephemeral_key_secret: z.string(),
		expires_at: z.number().int(),
		livemode: z.boolean(),
		stripe_api_version: z.string(),
	}),
});
