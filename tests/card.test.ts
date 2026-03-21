import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";

import type Stripe from "stripe";

import type {
	ParsedWebhookEvent,
	ProviderAdapter,
} from "../src/adapters/provider-adapter";
import {
	STRIPE_API_VERSION,
	StripeAdapter,
} from "../src/adapters/stripe-adapter";
import { issueCardBodySchema } from "../src/api/schemas/actions";
import { buildServer } from "../src/api/server";
import { type DalFactory, systemDal } from "../src/db/dal";
import { EVENT_TYPES } from "../src/domain/events";
import { ResourceManager } from "../src/domain/resource-manager";
import {
	buildAgentRecord,
	buildCardResourceRecord,
	buildEventRecord,
	FIXED_TIMESTAMP,
	installAgentsDalMock,
	installAuthApiKey,
	installEventsDalMock,
	installEventWriterMock,
	installResourceManagerMock,
	installResourcesDalMock,
	installStripeAdapterMock,
} from "./helpers";

function buildStripeWebhookHeaders(body: string, secret: string) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = crypto
		.createHmac("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");

	return {
		"content-type": "application/json",
		"stripe-signature": `t=${timestamp},v1=${signature}`,
	};
}

function buildIssueCardPayload(overrides?: Record<string, unknown>) {
	return {
		cardholder_name: "Agent Tester",
		billing_address: {
			line1: "123 Market St",
			city: "San Francisco",
			postal_code: "94105",
			country: "US",
		},
		currency: "usd",
		spending_limits: [{ amount: 5000, interval: "per_authorization" }],
		...overrides,
	};
}

void test("POST /agents/:id/actions/issue_card rejects missing explicit Stripe cardholder fields", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/issue_card",
			headers: { authorization: authorizationHeader },
			payload: {
				spending_limits: [{ amount: 5000, interval: "per_authorization" }],
			},
		});

		assert.strictEqual(response.statusCode, 400);
		assert.match(
			response.json<{ message: string }>().message,
			/cardholder_name/i,
		);
	} finally {
		restore();
		await server.close();
	}
});

void test("POST /agents/:id/actions/issue_card rejects mutually exclusive Stripe spending controls", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/issue_card",
			headers: { authorization: authorizationHeader },
			payload: buildIssueCardPayload({
				allowed_categories: ["advertising_services"],
				blocked_categories: ["art_dealers_and_galleries"],
			}),
		});

		assert.strictEqual(response.statusCode, 400);
		assert.match(
			response.json<{ message: string }>().message,
			/mutually exclusive/i,
		);
	} finally {
		restore();
		await server.close();
	}
});

void test("POST /agents/:id/actions/create_card_details_session requires a root key", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "service",
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/create_card_details_session",
			headers: { authorization: authorizationHeader },
			payload: { resource_id: "res_card_123", nonce: "nonce_123" },
		});

		assert.strictEqual(response.statusCode, 403);
	} finally {
		restore();
		await server.close();
	}
});

void test("POST /agents/:id/actions/create_card_details_session returns a short-lived Stripe session", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const resource = buildCardResourceRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findById: () => Promise.resolve(resource),
	});
	const restoreAdapter = installStripeAdapterMock(server, {
		createCardDetailsSession: () =>
			Promise.resolve({
				cardId: "ic_test123",
				ephemeralKeySecret: "ephkey_test_secret",
				expiresAt: 1_800_000_000,
				livemode: false,
				apiVersion: STRIPE_API_VERSION,
			}),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/create_card_details_session",
			headers: { authorization: authorizationHeader },
			payload: { resource_id: "res_card_123", nonce: "nonce_123" },
		});

		assert.strictEqual(response.statusCode, 200);
		const payload = response.json<{
			session: {
				resource_id: string;
				card_id: string;
				ephemeral_key_secret: string;
				expires_at: number;
				stripe_api_version: string;
			};
		}>();
		assert.strictEqual(payload.session.resource_id, "res_card_123");
		assert.strictEqual(payload.session.card_id, "ic_test123");
		assert.strictEqual(
			payload.session.ephemeral_key_secret,
			"ephkey_test_secret",
		);
		assert.strictEqual(payload.session.expires_at, 1_800_000_000);
		assert.strictEqual(payload.session.stripe_api_version, STRIPE_API_VERSION);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/create_card_details_session returns 404 for a card owned by another agent", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server, {
		keyType: "root",
	});
	const agent = buildAgentRecord();
	const otherAgentResource = buildCardResourceRecord({ agentId: "agt_other" });
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findById: () => Promise.resolve(otherAgentResource),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/create_card_details_session",
			headers: { authorization: authorizationHeader },
			payload: { resource_id: otherAgentResource.id, nonce: "nonce_123" },
		});

		assert.strictEqual(response.statusCode, 404);
		assert.deepStrictEqual(response.json(), {
			message: "Card resource not found",
		});
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

void test("issueCardBodySchema accepts Stripe spending-limit categories and intervals", () => {
	const parsed = issueCardBodySchema.parse(
		buildIssueCardPayload({
			spending_limits: [
				{
					amount: 5000,
					categories: ["advertising_services"],
					interval: "all_time",
				},
			],
			blocked_categories: ["art_dealers_and_galleries"],
			allowed_merchant_countries: ["us"],
		}),
	);

	assert.deepStrictEqual(parsed.spending_limits, [
		{
			amount: 5000,
			categories: ["advertising_services"],
			interval: "all_time",
		},
	]);
	assert.deepStrictEqual(parsed.blocked_categories, [
		"art_dealers_and_galleries",
	]);
	assert.deepStrictEqual(parsed.allowed_merchant_countries, ["US"]);
});

void test("StripeAdapter pins the Stripe API version and maps documented cardholder + spending-control fields", async () => {
	const adapter = new StripeAdapter("sk_test_123", "whsec_test_123");
	const stripeClient = (
		adapter as unknown as {
			stripe: Stripe & { getApiField(field: string): string | null };
		}
	).stripe;
	assert.strictEqual(stripeClient.getApiField("version"), STRIPE_API_VERSION);

	let cardholderCreateParams: Stripe.Issuing.CardholderCreateParams | undefined;
	let cardCreateParams: Stripe.Issuing.CardCreateParams | undefined;

	(
		adapter as unknown as {
			stripe: {
				issuing: {
					cardholders: {
						create: (
							params: Stripe.Issuing.CardholderCreateParams,
						) => Promise<{ id: string }>;
						update: (
							id: string,
							params: { status: "inactive" },
						) => Promise<void>;
					};
					cards: {
						create: (
							params: Stripe.Issuing.CardCreateParams,
						) => Promise<
							Pick<
								Stripe.Issuing.Card,
								"id" | "last4" | "exp_month" | "exp_year"
							>
						>;
					};
				};
			};
		}
	).stripe = {
		issuing: {
			cardholders: {
				create: (params) => {
					cardholderCreateParams = params;
					return Promise.resolve({ id: "ich_test_123" });
				},
				update: () => Promise.resolve(),
			},
			cards: {
				create: (params) => {
					cardCreateParams = params;
					return Promise.resolve({
						id: "ic_test_123",
						last4: "4242",
						exp_month: 12,
						exp_year: 2027,
					});
				},
			},
		},
	};

	const result = await adapter.provision("agt_123", {
		cardholder_name: "Agent Tester",
		billing_address: {
			line1: "123 Market St",
			line2: "Suite 10",
			city: "San Francisco",
			state: "CA",
			postal_code: "94105",
			country: "US",
		},
		currency: "usd",
		spending_limits: [
			{
				amount: 5000,
				categories: ["advertising_services"],
				interval: "all_time",
			},
		],
		allowed_categories: ["bakeries"],
		blocked_merchant_countries: ["CA"],
	});

	assert.deepStrictEqual(cardholderCreateParams, {
		name: "Agent Tester",
		type: "individual",
		billing: {
			address: {
				line1: "123 Market St",
				line2: "Suite 10",
				city: "San Francisco",
				state: "CA",
				postal_code: "94105",
				country: "US",
			},
		},
	});
	assert.deepStrictEqual(cardCreateParams, {
		cardholder: "ich_test_123",
		type: "virtual",
		currency: "usd",
		status: "active",
		spending_controls: {
			spending_limits: [
				{
					amount: 5000,
					categories: ["advertising_services"],
					interval: "all_time",
				},
			],
			allowed_categories: ["bakeries"],
			blocked_merchant_countries: ["CA"],
		},
	});
	assert.deepStrictEqual(result, {
		providerRef: "ic_test_123",
		config: {
			cardholder_id: "ich_test_123",
			last4: "4242",
			exp_month: 12,
			exp_year: 2027,
			currency: "usd",
		},
	});
});

void test("StripeAdapter.provision deactivates the cardholder when card creation fails", async () => {
	const adapter = new StripeAdapter("sk_test_123", "whsec_test_123");
	const deactivatedCardholders: string[] = [];

	(
		adapter as unknown as {
			stripe: {
				issuing: {
					cardholders: {
						create: (
							params: Stripe.Issuing.CardholderCreateParams,
						) => Promise<{ id: string }>;
						update: (
							id: string,
							params: { status: "inactive" },
						) => Promise<void>;
					};
					cards: {
						create: (params: Stripe.Issuing.CardCreateParams) => Promise<never>;
					};
				};
			};
		}
	).stripe = {
		issuing: {
			cardholders: {
				create: () => Promise.resolve({ id: "ich_fail_123" }),
				update: (id) => {
					deactivatedCardholders.push(id);
					return Promise.resolve();
				},
			},
			cards: {
				create: () => Promise.reject(new Error("card create failed")),
			},
		},
	};

	await assert.rejects(
		adapter.provision("agt_123", buildIssueCardPayload()),
		/card create failed/,
	);
	assert.deepStrictEqual(deactivatedCardholders, ["ich_fail_123"]);
});

void test("StripeAdapter.createCardDetailsSession uses the nonce and pinned API version", async () => {
	const adapter = new StripeAdapter("sk_test_123", "whsec_test_123");
	let ephemeralKeyParams: Stripe.EphemeralKeyCreateParams | undefined;
	let ephemeralKeyOptions: Stripe.RequestOptions | undefined;

	(
		adapter as unknown as {
			stripe: {
				ephemeralKeys: {
					create: (
						params: Stripe.EphemeralKeyCreateParams,
						options?: Stripe.RequestOptions,
					) => Promise<{ secret?: string; expires: number; livemode: boolean }>;
				};
			};
		}
	).stripe = {
		ephemeralKeys: {
			create: (params, options) => {
				ephemeralKeyParams = params;
				ephemeralKeyOptions = options;
				return Promise.resolve({
					secret: "ephkey_test_secret",
					expires: 1_800_000_000,
					livemode: false,
				});
			},
		},
	};

	const session = await adapter.createCardDetailsSession(
		buildCardResourceRecord(),
		"nonce_123",
	);

	assert.deepStrictEqual(ephemeralKeyParams, {
		issuing_card: "ic_test123",
		nonce: "nonce_123",
	});
	assert.deepStrictEqual(ephemeralKeyOptions, {
		apiVersion: STRIPE_API_VERSION,
	});
	assert.deepStrictEqual(session, {
		cardId: "ic_test123",
		ephemeralKeySecret: "ephkey_test_secret",
		expiresAt: 1_800_000_000,
		livemode: false,
		apiVersion: STRIPE_API_VERSION,
	});
});

void test("ResourceManager.provision deprovisions a Stripe card when DB activation fails", async () => {
	const fakeAdapter: ProviderAdapter = {
		providerName: "stripe",
		provision: () =>
			Promise.resolve({
				providerRef: "ic_test123",
				config: {
					cardholder_id: "ich_test123",
					last4: "4242",
					exp_month: 12,
					exp_year: 2027,
					currency: "usd",
				},
			}),
		deprovision: () => Promise.resolve({}),
		performAction: () => Promise.resolve({}),
		verifyWebhook: () => Promise.resolve(true),
		parseWebhook: () => Promise.resolve([]),
	};

	let deprovisionCalls = 0;
	fakeAdapter.deprovision = () => {
		deprovisionCalls += 1;
		return Promise.resolve({});
	};

	const fakeDal = {
		resources: {
			findById: () => Promise.resolve(null),
			insert: () =>
				Promise.resolve(
					buildCardResourceRecord({
						id: "res_card_123",
						state: "provisioning",
						providerRef: null,
						config: buildIssueCardPayload(),
					}),
				),
			updateById: () =>
				Promise.reject(new Error("forced resource activation failure")),
		},
	} as unknown as DalFactory;

	const manager = new ResourceManager(new Map([["stripe", fakeAdapter]]));
	await assert.rejects(
		manager.provision(
			fakeDal,
			"agt_123",
			"card",
			"stripe",
			buildIssueCardPayload(),
		),
		/forced resource activation failure/,
	);
	assert.strictEqual(deprovisionCalls, 1);
});

void test("StripeAdapter.parseWebhook preserves refund sign and transaction metadata", async () => {
	const adapter = new StripeAdapter("sk_test_123", "whsec_test_123");
	const payload = JSON.stringify({
		id: "evt_txn_refund_123",
		type: "issuing_transaction.created",
		created: Math.floor(FIXED_TIMESTAMP.getTime() / 1000),
		data: {
			object: {
				id: "ipi_refund_123",
				card: "ic_test123",
				amount: -2500,
				currency: "usd",
				authorization: "iauth_123",
				type: "refund",
			},
		},
	});

	const [event] = await adapter.parseWebhook(
		Buffer.from(payload),
		buildStripeWebhookHeaders(payload, "whsec_test_123"),
	);

	assert.deepStrictEqual(event, {
		resourceRef: "ic_test123",
		provider: "stripe",
		providerEventId: "evt_txn_refund_123",
		eventType: EVENT_TYPES.PAYMENT_CARD_SETTLED,
		occurredAt: FIXED_TIMESTAMP,
		data: {
			transaction_id: "ipi_refund_123",
			authorization_id: "iauth_123",
			amount: -2500,
			currency: "USD",
			transaction_type: "refund",
		},
	});
});

void test("StripeAdapter.parseWebhook emits payment.card.declined for issuing_authorization.created with approved:false", async () => {
	const adapter = new StripeAdapter("sk_test_123", "whsec_test_123");
	const payload = JSON.stringify({
		id: "evt_declined_123",
		type: "issuing_authorization.created",
		created: Math.floor(FIXED_TIMESTAMP.getTime() / 1000),
		data: {
			object: {
				id: "iauth_declined_123",
				card: "ic_test123",
				amount: 1500,
				currency: "usd",
				approved: false,
			},
		},
	});

	const [event] = await adapter.parseWebhook(
		Buffer.from(payload),
		buildStripeWebhookHeaders(payload, "whsec_test_123"),
	);

	assert.strictEqual(event.eventType, EVENT_TYPES.PAYMENT_CARD_DECLINED);
	assert.deepStrictEqual(event, {
		resourceRef: "ic_test123",
		provider: "stripe",
		providerEventId: "evt_declined_123",
		eventType: EVENT_TYPES.PAYMENT_CARD_DECLINED,
		occurredAt: FIXED_TIMESTAMP,
		data: {
			authorization_id: "iauth_declined_123",
			amount: 1500,
			currency: "USD",
		},
	});
});

void test("POST /agents/:id/actions/issue_card response does not contain PAN or CVC fields", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildCardResourceRecord({
		config: {
			cardholder_id: "ich_test",
			last4: "4242",
			exp_month: 12,
			exp_year: 2027,
			currency: "usd",
		},
	});
	const event = buildEventRecord({
		eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
		agentId: agent.id,
		resourceId: resource.id,
		provider: "stripe",
		data: { card_id: "ic_test123" },
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findById: () => Promise.resolve(null),
	});
	const restoreEvents = installEventsDalMock({
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	// Ensure stripeAdapter is present so the route does not short-circuit with 500
	const restoreAdapter = installStripeAdapterMock(server, {});
	const restoreManager = installResourceManagerMock(server, {
		provision: () =>
			Promise.resolve({
				resource,
				reusedExisting: false,
			}),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => Promise.resolve({ event, wasCreated: true }),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: `/agents/${agent.id}/actions/issue_card`,
			headers: { authorization: authorizationHeader },
			payload: buildIssueCardPayload(),
		});

		assert.strictEqual(response.statusCode, 200);
		const body = response.json<{
			card: Record<string, unknown>;
		}>();
		assert.strictEqual(body.card.number, undefined);
		assert.strictEqual(body.card.cvc, undefined);
		assert.strictEqual(body.card.last4, "4242");
		assert.strictEqual(body.card.exp_month, 12);
		assert.strictEqual(body.card.exp_year, 2027);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreAdapter();
		restoreManager();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/stripe returns 401 for invalid signatures", async () => {
	const server = await buildServer();
	const restoreAdapter = installStripeAdapterMock(server, {
		verifyWebhook: () => Promise.resolve(false),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/stripe",
			headers: { "content-type": "application/json" },
			payload: "{}",
		});

		assert.strictEqual(response.statusCode, 401);
	} finally {
		restoreAdapter();
		await server.close();
	}
});

void test("POST /webhooks/stripe returns 200 when a verified webhook cannot be matched to a card resource", async () => {
	const server = await buildServer();
	const body = JSON.stringify({ id: "evt_missing_resource" });
	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	let writeEventCalls = 0;

	systemDal.findResourceByProviderRef = () => Promise.resolve(null);
	const restoreAdapter = installStripeAdapterMock(server, {
		verifyWebhook: () => Promise.resolve(true),
		parseWebhook: () =>
			Promise.resolve([
				{
					resourceRef: "ic_missing_123",
					provider: "stripe",
					providerEventId: "evt_missing_resource",
					eventType: EVENT_TYPES.PAYMENT_CARD_AUTHORIZED,
					occurredAt: FIXED_TIMESTAMP,
					data: {
						authorization_id: "iauth_missing_123",
						amount: 5000,
						currency: "USD",
					},
				} satisfies ParsedWebhookEvent,
			]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			return Promise.reject(
				new Error("writeEvent should not be called for unmatched webhooks"),
			);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/stripe",
			headers: buildStripeWebhookHeaders(body, "whsec_test_123"),
			payload: body,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.deepStrictEqual(response.json(), { ok: true });
		assert.strictEqual(writeEventCalls, 0);
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/stripe returns 500 when persistence fails after verification", async () => {
	const server = await buildServer();
	const body = JSON.stringify({ id: "evt_write_failure_123" });
	const resource = buildCardResourceRecord();
	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);

	systemDal.findResourceByProviderRef = () => Promise.resolve(resource);
	const restoreAdapter = installStripeAdapterMock(server, {
		verifyWebhook: () => Promise.resolve(true),
		parseWebhook: () =>
			Promise.resolve([
				{
					resourceRef: "ic_test123",
					provider: "stripe",
					providerEventId: "evt_write_failure_123",
					eventType: EVENT_TYPES.PAYMENT_CARD_AUTHORIZED,
					occurredAt: FIXED_TIMESTAMP,
					data: {
						authorization_id: "iauth_write_failure_123",
						amount: 5000,
						currency: "USD",
					},
				} satisfies ParsedWebhookEvent,
			]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => Promise.reject(new Error("forced webhook write failure")),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/stripe",
			headers: buildStripeWebhookHeaders(body, "whsec_test_123"),
			payload: body,
		});

		assert.strictEqual(response.statusCode, 500);
		assert.deepStrictEqual(response.json(), {
			message: "Webhook processing failed",
		});
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});
