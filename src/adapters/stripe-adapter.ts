import Stripe from "stripe";
import { EVENT_TYPES } from "../domain/events.js";
import type {
	DeprovisionResult,
	ParsedWebhookEvent,
	ProviderActionOptions,
	ProviderAdapter,
	ProvisionResult,
	Resource,
} from "./provider-adapter.js";

export const STRIPE_API_VERSION = Stripe.API_VERSION as Stripe.LatestApiVersion;

export type StripeCardDetailsSession = {
	cardId: string;
	ephemeralKeySecret: string;
	expiresAt: number;
	livemode: boolean;
	apiVersion: string;
};

function getExpandableId(
	value: string | { id: string } | null | undefined,
): string | undefined {
	if (typeof value === "string") return value;
	if (value?.id) return value.id;
	return undefined;
}

function readRequiredString(config: Record<string, unknown>, key: string) {
	const value = config[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Missing required Stripe config field: ${key}`);
	}

	return value.trim();
}

function readOptionalString(config: Record<string, unknown>, key: string) {
	const value = config[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function readBillingAddress(
	config: Record<string, unknown>,
): Stripe.Issuing.CardholderCreateParams.Billing.Address {
	const value = config.billing_address;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Missing required Stripe config field: billing_address");
	}

	const address = value as Record<string, unknown>;
	return {
		line1: readRequiredString(address, "line1"),
		city: readRequiredString(address, "city"),
		postal_code: readRequiredString(address, "postal_code"),
		country: readRequiredString(address, "country").toUpperCase(),
		...(readOptionalString(address, "line2")
			? { line2: readOptionalString(address, "line2") }
			: {}),
		...(readOptionalString(address, "state")
			? { state: readOptionalString(address, "state") }
			: {}),
	};
}

function buildSpendingControls(
	config: Record<string, unknown>,
): Stripe.Issuing.CardCreateParams.SpendingControls | undefined {
	const spending_limits =
		Array.isArray(config.spending_limits) && config.spending_limits.length > 0
			? config.spending_limits.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) {
						return [];
					}

					const candidate = entry as Record<string, unknown>;
					if (
						typeof candidate.amount !== "number" ||
						typeof candidate.interval !== "string"
					) {
						return [];
					}

					const categories =
						Array.isArray(candidate.categories) &&
						candidate.categories.length > 0
							? (candidate.categories as Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Category[])
							: undefined;

					return [
						{
							amount: candidate.amount,
							...(categories ? { categories } : {}),
							interval:
								candidate.interval as Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Interval,
						},
					];
				})
			: undefined;
	const allowed_categories =
		Array.isArray(config.allowed_categories) &&
		config.allowed_categories.length > 0
			? (config.allowed_categories as Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[])
			: undefined;
	const blocked_categories =
		Array.isArray(config.blocked_categories) &&
		config.blocked_categories.length > 0
			? (config.blocked_categories as Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory[])
			: undefined;
	const allowed_merchant_countries =
		Array.isArray(config.allowed_merchant_countries) &&
		config.allowed_merchant_countries.length > 0
			? (config.allowed_merchant_countries as string[])
			: undefined;
	const blocked_merchant_countries =
		Array.isArray(config.blocked_merchant_countries) &&
		config.blocked_merchant_countries.length > 0
			? (config.blocked_merchant_countries as string[])
			: undefined;

	const spendingControls: Stripe.Issuing.CardCreateParams.SpendingControls = {
		...(spending_limits ? { spending_limits } : {}),
		...(allowed_categories ? { allowed_categories } : {}),
		...(blocked_categories ? { blocked_categories } : {}),
		...(allowed_merchant_countries ? { allowed_merchant_countries } : {}),
		...(blocked_merchant_countries ? { blocked_merchant_countries } : {}),
	};

	if (Object.keys(spendingControls).length > 0) {
		return spendingControls;
	}

	// Safe defaults: $500/day, block cash advances & gambling
	return {
		spending_limits: [
			{
				amount: 50000, // $500 in cents
				interval:
					"daily" as Stripe.Issuing.CardCreateParams.SpendingControls.SpendingLimit.Interval,
			},
		],
		blocked_categories: [
			"automated_cash_disburse" as Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory,
			"manual_cash_disburse" as Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory,
			"gambling" as Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory,
			"lottery" as Stripe.Issuing.CardCreateParams.SpendingControls.BlockedCategory,
		],
	};
}

function buildAuthorizationEvent(
	event: Stripe.IssuingAuthorizationCreatedEvent,
): ParsedWebhookEvent {
	const authorization = event.data.object;
	const cardId = getExpandableId(authorization.card);
	const eventType = authorization.approved
		? EVENT_TYPES.PAYMENT_CARD_AUTHORIZED
		: EVENT_TYPES.PAYMENT_CARD_DECLINED;

	return {
		resourceRef: cardId,
		provider: "stripe",
		providerEventId: event.id,
		eventType,
		occurredAt: new Date(event.created * 1000),
		data: {
			authorization_id: authorization.id,
			amount: Math.abs(authorization.amount),
			currency: authorization.currency.toUpperCase(),
		},
	};
}

function buildTransactionEvent(
	event: Stripe.IssuingTransactionCreatedEvent,
): ParsedWebhookEvent {
	const transaction = event.data.object;
	const cardId = getExpandableId(transaction.card);
	const authorizationId = getExpandableId(transaction.authorization);

	return {
		resourceRef: cardId,
		provider: "stripe",
		providerEventId: event.id,
		eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
		occurredAt: new Date(event.created * 1000),
		data: {
			transaction_id: transaction.id,
			...(authorizationId !== undefined
				? { authorization_id: authorizationId }
				: {}),
			amount: transaction.amount,
			currency: transaction.currency.toUpperCase(),
			transaction_type: transaction.type,
		},
	};
}

export class StripeAdapter implements ProviderAdapter {
	readonly providerName = "stripe";
	private readonly stripe: Stripe;
	private readonly webhookSecret: string;

	constructor(secretKey: string, webhookSecret: string) {
		this.stripe = new Stripe(secretKey, {
			apiVersion: STRIPE_API_VERSION,
		});
		this.webhookSecret = webhookSecret;
	}

	private constructWebhookEvent(
		rawBody: Buffer,
		headers: Record<string, string>,
	): Stripe.Event {
		return this.stripe.webhooks.constructEvent(
			rawBody,
			headers["stripe-signature"] ?? "",
			this.webhookSecret,
		);
	}

	async provision(
		_agentId: string,
		config: Record<string, unknown>,
	): Promise<ProvisionResult> {
		const cardholderName = readRequiredString(config, "cardholder_name");
		const currency = readRequiredString(config, "currency").toLowerCase();
		const billingAddress = readBillingAddress(config);
		const spendingControls = buildSpendingControls(config);

		const cardholder = await this.stripe.issuing.cardholders.create({
			name: cardholderName,
			type: "individual",
			billing: {
				address: billingAddress,
			},
		});

		const cardParams: Stripe.Issuing.CardCreateParams = {
			cardholder: cardholder.id,
			type: "virtual",
			currency,
			status: "active",
			...(spendingControls ? { spending_controls: spendingControls } : {}),
		};

		let card: Stripe.Issuing.Card;
		try {
			card = await this.stripe.issuing.cards.create(cardParams);
		} catch (err) {
			await this.stripe.issuing.cardholders
				.update(cardholder.id, { status: "inactive" })
				.catch(() => {});
			throw err;
		}

		return {
			providerRef: card.id,
			config: {
				cardholder_id: cardholder.id,
				last4: card.last4,
				exp_month: card.exp_month,
				exp_year: card.exp_year,
				currency,
			},
		};
	}

	async createCardDetailsSession(
		resource: Resource,
		nonce: string,
	): Promise<StripeCardDetailsSession> {
		if (!resource.providerRef) {
			throw new Error(`Resource ${resource.id} has no providerRef`);
		}

		const ephemeralKey = await this.stripe.ephemeralKeys.create(
			{
				issuing_card: resource.providerRef,
				nonce,
			},
			{ apiVersion: STRIPE_API_VERSION },
		);

		if (!ephemeralKey.secret) {
			throw new Error("Stripe ephemeral key response did not include a secret");
		}

		return {
			cardId: resource.providerRef,
			ephemeralKeySecret: ephemeralKey.secret,
			expiresAt: ephemeralKey.expires,
			livemode: ephemeralKey.livemode,
			apiVersion: STRIPE_API_VERSION,
		};
	}

	async deprovision(resource: Resource): Promise<DeprovisionResult> {
		if (!resource.providerRef) {
			throw new Error(`Resource ${resource.id} has no providerRef`);
		}

		const cardholderId =
			typeof resource.config.cardholder_id === "string"
				? resource.config.cardholder_id
				: null;

		await this.stripe.issuing.cards.update(resource.providerRef, {
			status: "canceled",
		});

		if (cardholderId) {
			await this.stripe.issuing.cardholders.update(cardholderId, {
				status: "inactive",
			});
		}

		return {};
	}

	performAction(
		_resource: Resource,
		action: string,
		_payload: Record<string, unknown>,
		_options?: ProviderActionOptions,
	): Promise<Record<string, unknown>> {
		return Promise.reject(
			new Error(`Unsupported action for stripe card resource: ${action}`),
		);
	}

	verifyWebhook(
		rawBody: Buffer,
		headers: Record<string, string>,
	): Promise<boolean> {
		try {
			this.constructWebhookEvent(rawBody, headers);
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}

	parseWebhook(
		rawBody: Buffer,
		headers: Record<string, string>,
	): Promise<ParsedWebhookEvent[]> {
		const event = this.constructWebhookEvent(rawBody, headers);

		switch (event.type) {
			case "issuing_authorization.created":
				return Promise.resolve([buildAuthorizationEvent(event)]);
			case "issuing_transaction.created":
				return Promise.resolve([buildTransactionEvent(event)]);
			default:
				return Promise.resolve([]);
		}
	}
}
