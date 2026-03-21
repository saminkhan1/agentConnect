import { eq } from "drizzle-orm";
import Stripe from "stripe";
import type { ServerConfig } from "../config";
import { db } from "../db";
import { orgs } from "../db/schema";

export type PlanTier = "starter" | "personal" | "power";
export type SubscriptionStatus =
	| "incomplete"
	| "active"
	| "trialing"
	| "past_due"
	| "canceled"
	| "unpaid";

const PLAN_TIERS: PlanTier[] = ["starter", "personal", "power"];

export function isValidPlanTier(tier: string): tier is PlanTier {
	return PLAN_TIERS.includes(tier as PlanTier);
}

export function createBillingService(config: ServerConfig) {
	const stripeKey = config.STRIPE_SECRET_KEY;
	if (!stripeKey) {
		return null;
	}
	const stripe = new Stripe(stripeKey);

	function getPriceId(tier: PlanTier): string | undefined {
		switch (tier) {
			case "starter":
				return config.STRIPE_PRICE_ID_STARTER;
			case "personal":
				return config.STRIPE_PRICE_ID_PERSONAL;
			case "power":
				return config.STRIPE_PRICE_ID_POWER;
		}
	}

	async function getOrCreateStripeCustomer(
		orgId: string,
		orgName: string,
	): Promise<string> {
		const org = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
		if (org.length === 0) {
			throw new Error(`Org ${orgId} not found`);
		}

		if (org[0].stripeCustomerId) {
			return org[0].stripeCustomerId;
		}

		const customer = await stripe.customers.create({
			metadata: { org_id: orgId },
			name: orgName,
		});

		await db
			.update(orgs)
			.set({ stripeCustomerId: customer.id })
			.where(eq(orgs.id, orgId));

		return customer.id;
	}

	async function createCheckoutSession(
		orgId: string,
		orgName: string,
		planTier: PlanTier,
		successUrl: string,
		cancelUrl: string,
	): Promise<{ url: string }> {
		const priceId = getPriceId(planTier);
		if (!priceId) {
			throw new Error(`No price configured for plan tier: ${planTier}`);
		}

		const customerId = await getOrCreateStripeCustomer(orgId, orgName);

		const session = await stripe.checkout.sessions.create({
			customer: customerId,
			mode: "subscription",
			line_items: [{ price: priceId, quantity: 1 }],
			success_url: successUrl,
			cancel_url: cancelUrl,
			metadata: { org_id: orgId, plan_tier: planTier },
			subscription_data: {
				metadata: { org_id: orgId, plan_tier: planTier },
			},
		});

		if (!session.url) {
			throw new Error("Stripe checkout session did not return a URL");
		}

		return { url: session.url };
	}

	async function createPortalSession(
		orgId: string,
		returnUrl: string,
	): Promise<{ url: string }> {
		const org = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
		if (org.length === 0 || !org[0].stripeCustomerId) {
			throw new Error("No billing account found for this organization");
		}

		const session = await stripe.billingPortal.sessions.create({
			customer: org[0].stripeCustomerId,
			return_url: returnUrl,
		});

		return { url: session.url };
	}

	function mapStripeStatus(status: string): SubscriptionStatus {
		const mapping: Record<string, SubscriptionStatus> = {
			incomplete: "incomplete",
			incomplete_expired: "incomplete",
			active: "active",
			trialing: "trialing",
			past_due: "past_due",
			canceled: "canceled",
			unpaid: "unpaid",
			paused: "canceled",
		};
		return mapping[status] ?? "incomplete";
	}

	async function syncSubscription(event: Stripe.Event): Promise<void> {
		switch (event.type) {
			case "checkout.session.completed": {
				const session = event.data.object as Stripe.Checkout.Session;
				const orgId = session.metadata?.org_id;
				const planTier = session.metadata?.plan_tier;
				if (!orgId || !session.subscription) return;

				const subscriptionId =
					typeof session.subscription === "string"
						? session.subscription
						: session.subscription.id;

				const subscription = await stripe.subscriptions.retrieve(
					subscriptionId,
					{
						expand: ["latest_invoice"],
					},
				);

				const latestInvoice =
					typeof subscription.latest_invoice === "object"
						? subscription.latest_invoice
						: null;
				const periodEnd = latestInvoice?.period_end;

				await db
					.update(orgs)
					.set({
						stripeSubscriptionId: subscriptionId,
						subscriptionStatus: mapStripeStatus(subscription.status),
						planTier:
							planTier && isValidPlanTier(planTier) ? planTier : "starter",
						...(periodEnd
							? { currentPeriodEnd: new Date(periodEnd * 1000) }
							: {}),
					})
					.where(eq(orgs.id, orgId));
				break;
			}
			case "customer.subscription.updated":
			case "customer.subscription.deleted": {
				const subscription = event.data.object as Stripe.Subscription;
				const orgId = subscription.metadata?.org_id;
				if (!orgId) return;

				const planTier = subscription.metadata?.plan_tier;

				const updates: Record<string, unknown> = {
					subscriptionStatus: mapStripeStatus(subscription.status),
				};

				const subLatestInvoice =
					typeof subscription.latest_invoice === "object"
						? subscription.latest_invoice
						: null;
				if (subLatestInvoice?.period_end) {
					updates.currentPeriodEnd = new Date(
						subLatestInvoice.period_end * 1000,
					);
				}

				if (planTier && isValidPlanTier(planTier)) {
					updates.planTier = planTier;
				}

				await db.update(orgs).set(updates).where(eq(orgs.id, orgId));
				break;
			}
			case "invoice.payment_failed": {
				const invoice = event.data.object as Stripe.Invoice;
				const parentSub = invoice.parent?.subscription_details?.subscription;
				const subscriptionId =
					typeof parentSub === "string" ? parentSub : parentSub?.id;
				if (!subscriptionId) return;

				const subscription =
					await stripe.subscriptions.retrieve(subscriptionId);
				const orgId = subscription.metadata?.org_id;
				if (!orgId) return;

				await db
					.update(orgs)
					.set({
						subscriptionStatus: mapStripeStatus(subscription.status),
					})
					.where(eq(orgs.id, orgId));
				break;
			}
		}
	}

	function constructEvent(
		rawBody: Buffer,
		signature: string,
		webhookSecret: string,
	): Stripe.Event {
		return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
	}

	return {
		createCheckoutSession,
		createPortalSession,
		syncSubscription,
		constructEvent,
	};
}

export type BillingService = NonNullable<
	ReturnType<typeof createBillingService>
>;
