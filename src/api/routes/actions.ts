import crypto from "node:crypto";

import type { InferSelectModel } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import fp from "fastify-plugin";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

import type { AgentMailAdapter } from "../../adapters/agentmail-adapter";
import { sleep, withTimeout } from "../../adapters/provider-client";
import type { DalFactory } from "../../db/dal";
import type {
	events as eventsTable,
	resources as resourcesTable,
} from "../../db/schema";
import type { PlanTier } from "../../domain/billing";
import { enforceCardLimit } from "../../domain/billing-limits";
import { AppError } from "../../domain/errors";
import { EVENT_TYPES } from "../../domain/events";
import { requireKeyType, requireScope } from "../../plugins/auth";
import {
	createCardDetailsSessionBodySchema,
	createCardDetailsSessionParamsSchema,
	createCardDetailsSessionResponseSchema,
	issueCardBodySchema,
	issueCardParamsSchema,
	issueCardResponseSchema,
	issuedCardMetadataSchema,
	replyEmailBodySchema,
	replyEmailParamsSchema,
	replyEmailResponseSchema,
	sendEmailBodySchema,
	sendEmailParamsSchema,
	sendEmailResponseSchema,
} from "../schemas/actions";
import { errorResponseSchema } from "../schemas/common";
import { replyFromAgentMailError } from "./agentmail-errors";
import {
	normalizeEmailAddress,
	normalizeEmailAddressArray,
	normalizeOptionalString,
	normalizeSortedStringArray,
	readStringArray,
} from "./email-utils";
import { serializeEvent } from "./events";
import {
	executeOutboundEmailAction,
	MSG_IDEMPOTENCY_DIFFERENT_ACTION,
	type PrepareInitialRequestDataResult,
} from "./outbound-email-actions";
import { serializeResource } from "./resources";
import { replyFromStripeError } from "./stripe-errors";

type EventRecord = InferSelectModel<typeof eventsTable>;
type ResourceRecord = InferSelectModel<typeof resourcesTable>;
type EmailAddressInput = string | string[];
type AgentMailSendResult = {
	message_id: string;
	thread_id?: string;
};
type SendEmailActionRequestData = {
	to: string[];
	subject: string;
	text: string;
	html?: string;
	cc?: string[];
	bcc?: string[];
	reply_to?: EmailAddressInput;
};
type ReplyEmailActionRequestData = {
	message_id: string;
	text: string;
	html?: string;
	cc?: string[];
	bcc?: string[];
	reply_to?: EmailAddressInput;
	subject?: string;
	reply_recipients: string[];
};

const ADAPTER_TIMEOUT_MS = 30_000;

const MSG_IDEMPOTENCY_DIFFERENT_EMAIL =
	"Idempotency key already used with different email parameters";
const MSG_IDEMPOTENCY_DIFFERENT_REPLY =
	"Idempotency key already used with different reply parameters";

function buildIdempotentCardResourceId(orgId: string, idempotencyKey: string) {
	const digest = crypto
		.createHash("sha256")
		.update(`issue_card:${orgId}:${idempotencyKey}`)
		.digest("hex");
	return `res_${digest}`;
}

function normalizeSpendingLimits(value: unknown) {
	const parsed = Array.isArray(value) ? value : [];
	return parsed
		.flatMap((entry) => {
			const candidate =
				typeof entry === "object" && entry !== null
					? (entry as Record<string, unknown>)
					: null;
			if (
				!candidate ||
				typeof candidate.amount !== "number" ||
				typeof candidate.interval !== "string"
			) {
				return [];
			}

			const categories = normalizeSortedStringArray(candidate.categories);
			return [
				{
					amount: candidate.amount,
					interval: candidate.interval,
					...(categories.length > 0 ? { categories } : {}),
				},
			];
		})
		.sort(
			(left, right) =>
				left.amount - right.amount ||
				left.interval.localeCompare(right.interval) ||
				JSON.stringify(left.categories ?? []).localeCompare(
					JSON.stringify(right.categories ?? []),
				),
		);
}

function normalizeBillingAddress(value: unknown) {
	if (!isObjectRecord(value)) {
		return {
			line1: "",
			line2: "",
			city: "",
			state: "",
			postal_code: "",
			country: "",
		};
	}

	return {
		line1: normalizeOptionalString(value.line1),
		line2: normalizeOptionalString(value.line2),
		city: normalizeOptionalString(value.city),
		state: normalizeOptionalString(value.state),
		postal_code: normalizeOptionalString(value.postal_code),
		country: normalizeOptionalString(value.country).toUpperCase(),
	};
}

function normalizeCurrency(value: unknown) {
	return normalizeOptionalString(value).toLowerCase();
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readEmailAddressInput(value: unknown): EmailAddressInput | null {
	if (typeof value === "string") {
		return value;
	}

	const addresses = readStringArray(value);
	return addresses.length > 0 ? addresses : null;
}

function normalizeReplyToHashValue(value: EmailAddressInput | undefined) {
	if (value === undefined) {
		return [];
	}

	return normalizeSortedStringArray(
		typeof value === "string" ? [value] : value,
	);
}

function parseSendEmailActionRequestData(
	value: unknown,
): SendEmailActionRequestData | null {
	if (!isObjectRecord(value)) {
		return null;
	}

	const to = readStringArray(value.to);
	const subject = typeof value.subject === "string" ? value.subject : null;
	const text = typeof value.text === "string" ? value.text : null;
	if (to.length === 0 || !subject || text === null) {
		return null;
	}

	const replyTo = readEmailAddressInput(value.reply_to);

	return {
		to,
		subject,
		text,
		...(typeof value.html === "string" ? { html: value.html } : {}),
		...(readStringArray(value.cc).length > 0
			? { cc: readStringArray(value.cc) }
			: {}),
		...(readStringArray(value.bcc).length > 0
			? { bcc: readStringArray(value.bcc) }
			: {}),
		...(replyTo !== null ? { reply_to: replyTo } : {}),
	};
}

function parseReplyEmailActionRequestData(
	value: unknown,
): ReplyEmailActionRequestData | null {
	if (!isObjectRecord(value)) {
		return null;
	}

	const messageId =
		typeof value.message_id === "string" ? value.message_id : null;
	const text = typeof value.text === "string" ? value.text : null;
	const replyRecipients = readStringArray(value.reply_recipients);
	if (!messageId || text === null || replyRecipients.length === 0) {
		return null;
	}

	const replyTo = readEmailAddressInput(value.reply_to);

	return {
		message_id: messageId,
		text,
		reply_recipients: replyRecipients,
		...(typeof value.html === "string" ? { html: value.html } : {}),
		...(readStringArray(value.cc).length > 0
			? { cc: readStringArray(value.cc) }
			: {}),
		...(readStringArray(value.bcc).length > 0
			? { bcc: readStringArray(value.bcc) }
			: {}),
		...(replyTo !== null ? { reply_to: replyTo } : {}),
		...(typeof value.subject === "string" ? { subject: value.subject } : {}),
	};
}

function buildSendEmailRequestHash(
	resource: ResourceRecord,
	payload: {
		to: string[];
		subject: string;
		text: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		reply_to?: EmailAddressInput;
	},
) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				from: resource.providerRef ?? "",
				to: normalizeSortedStringArray(payload.to),
				cc: normalizeSortedStringArray(payload.cc),
				bcc: normalizeSortedStringArray(payload.bcc),
				subject: payload.subject,
				text: payload.text,
				html: normalizeOptionalString(payload.html),
				reply_to: normalizeReplyToHashValue(payload.reply_to),
			}),
		)
		.digest("hex");
}

function buildReplyEmailRequestHash(
	resource: ResourceRecord,
	payload: {
		message_id: string;
		text: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		reply_to?: EmailAddressInput;
	},
) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				from: resource.providerRef ?? "",
				message_id: payload.message_id,
				text: payload.text,
				html: normalizeOptionalString(payload.html),
				cc: normalizeSortedStringArray(payload.cc),
				bcc: normalizeSortedStringArray(payload.bcc),
				reply_to: normalizeReplyToHashValue(payload.reply_to),
			}),
		)
		.digest("hex");
}

function resolveReplyRecipients(
	message: Record<string, unknown>,
	resource: ResourceRecord,
) {
	const replyTo = normalizeEmailAddressArray(message.reply_to);
	if (replyTo.length > 0) {
		return replyTo;
	}

	const from = normalizeEmailAddress(message.from);
	const normalizedProviderRef = normalizeEmailAddress(resource.providerRef);
	const normalizedConfigAddress = normalizeEmailAddress(
		resource.config.email_address,
	);
	const resourceEmailAddresses = new Set(
		[normalizedProviderRef, normalizedConfigAddress]
			.filter((value): value is string => value !== null)
			.map((value) => value.toLowerCase()),
	);

	if (from && !resourceEmailAddresses.has(from.toLowerCase())) {
		return [from];
	}

	const to = normalizeEmailAddressArray(message.to);
	if (to.length > 0) {
		return to;
	}

	return from ? [from] : [];
}

function normalizeCardIssuanceConfig(config: Record<string, unknown>) {
	return {
		cardholder_name: normalizeOptionalString(config.cardholder_name),
		billing_address: normalizeBillingAddress(config.billing_address),
		currency: normalizeCurrency(config.currency),
		spending_limits: normalizeSpendingLimits(config.spending_limits),
		allowed_categories: normalizeSortedStringArray(config.allowed_categories),
		blocked_categories: normalizeSortedStringArray(config.blocked_categories),
		allowed_merchant_countries: normalizeSortedStringArray(
			config.allowed_merchant_countries,
		),
		blocked_merchant_countries: normalizeSortedStringArray(
			config.blocked_merchant_countries,
		),
	};
}

function matchesCardIssuanceConfig(
	resource: ResourceRecord,
	config: Record<string, unknown>,
) {
	if (resource.type !== "card" || resource.provider !== "stripe") {
		return false;
	}

	return (
		JSON.stringify(normalizeCardIssuanceConfig(resource.config)) ===
		JSON.stringify(normalizeCardIssuanceConfig(config))
	);
}

function isStripeCardResourceForAgent(
	resource: ResourceRecord,
	agentId: string,
) {
	return (
		resource.type === "card" &&
		resource.provider === "stripe" &&
		resource.agentId === agentId
	);
}

function isIssuedCardEventForResource(
	event: EventRecord,
	agentId: string,
	resourceId: string,
) {
	return (
		event.eventType === EVENT_TYPES.PAYMENT_CARD_ISSUED &&
		event.agentId === agentId &&
		event.resourceId === resourceId
	);
}

function buildSendEmailEventData(
	emailResource: ResourceRecord,
	requestData: SendEmailActionRequestData,
	providerResult: AgentMailSendResult,
	requestHash: string,
) {
	return {
		message_id: providerResult.message_id,
		...(providerResult.thread_id
			? { thread_id: providerResult.thread_id }
			: {}),
		from: emailResource.providerRef,
		to: requestData.to,
		...(requestData.cc ? { cc: requestData.cc } : {}),
		...(requestData.bcc ? { bcc: requestData.bcc } : {}),
		subject: requestData.subject,
		request_hash: requestHash,
	};
}

function buildReplyEmailEventData(
	emailResource: ResourceRecord,
	requestData: ReplyEmailActionRequestData,
	providerResult: AgentMailSendResult,
	requestHash: string,
) {
	return {
		message_id: providerResult.message_id,
		...(providerResult.thread_id
			? { thread_id: providerResult.thread_id }
			: {}),
		from: emailResource.providerRef,
		to: requestData.reply_recipients,
		in_reply_to_message_id: requestData.message_id,
		...(requestData.cc ? { cc: requestData.cc } : {}),
		...(requestData.bcc ? { bcc: requestData.bcc } : {}),
		...(requestData.subject ? { subject: requestData.subject } : {}),
		request_hash: requestHash,
	};
}

function buildSendEmailAdapterPayload(requestData: SendEmailActionRequestData) {
	return {
		to: requestData.to,
		subject: requestData.subject,
		text: requestData.text,
		html: requestData.html,
		cc: requestData.cc,
		bcc: requestData.bcc,
		...(requestData.reply_to !== undefined
			? { replyTo: requestData.reply_to }
			: {}),
	};
}

function buildReplyEmailAdapterPayload(
	requestData: ReplyEmailActionRequestData,
) {
	return {
		message_id: requestData.message_id,
		text: requestData.text,
		html: requestData.html,
		cc: requestData.cc,
		bcc: requestData.bcc,
		reply_recipients: requestData.reply_recipients,
		...(requestData.reply_to !== undefined
			? { replyTo: requestData.reply_to }
			: {}),
	};
}

async function prepareReplyEmailRequestData(
	reply: FastifyReply,
	adapter: AgentMailAdapter,
	resource: ResourceRecord,
	input: {
		message_id: string;
		text: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		reply_to?: EmailAddressInput;
	},
): Promise<PrepareInitialRequestDataResult<ReplyEmailActionRequestData>> {
	let originalMessage: Record<string, unknown>;
	try {
		originalMessage = await withTimeout(
			(signal) =>
				adapter.performAction(
					resource,
					"get_message",
					{
						message_id: input.message_id,
					},
					{ abortSignal: signal },
				),
			ADAPTER_TIMEOUT_MS,
		);
	} catch (error) {
		if (
			replyFromAgentMailError(reply, error, "Failed to load original message")
		) {
			return { kind: "response_sent" };
		}

		throw error;
	}

	const replyRecipients = resolveReplyRecipients(originalMessage, resource);
	if (replyRecipients.length === 0) {
		reply.code(500).send({
			message: "Unable to resolve reply recipients for policy enforcement",
		});
		return { kind: "response_sent" };
	}

	return {
		kind: "ok",
		requestData: {
			message_id: input.message_id,
			text: input.text,
			reply_recipients: replyRecipients,
			...(input.html !== undefined ? { html: input.html } : {}),
			...(input.cc !== undefined ? { cc: input.cc } : {}),
			...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
			...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
			...(typeof originalMessage.subject === "string"
				? { subject: originalMessage.subject }
				: {}),
		},
	};
}

function buildIssuedCardMetadata(resource: ResourceRecord) {
	const parsedMetadata = issuedCardMetadataSchema.safeParse(resource.config);
	if (!parsedMetadata.success) {
		throw new AppError(
			"INTERNAL",
			500,
			`Stored Stripe card metadata is invalid for resource ${resource.id}`,
		);
	}

	return parsedMetadata.data;
}

function serializeIssueCardResponse(
	resource: ResourceRecord,
	event: EventRecord,
) {
	return {
		resource: serializeResource(resource),
		card: buildIssuedCardMetadata(resource),
		event: serializeEvent(event),
	};
}

function serializeCardDetailsSessionResponse(
	resource: ResourceRecord,
	session: {
		cardId: string;
		ephemeralKeySecret: string;
		expiresAt: number;
		livemode: boolean;
		apiVersion: string;
	},
) {
	return {
		session: {
			resource_id: resource.id,
			card_id: session.cardId,
			ephemeral_key_secret: session.ephemeralKeySecret,
			expires_at: session.expiresAt,
			livemode: session.livemode,
			stripe_api_version: session.apiVersion,
		},
	};
}

async function waitForIssuedCardReplay(
	dal: DalFactory,
	resourceId: string,
	idempotencyKey: string,
) {
	const MAX_ATTEMPTS = 8;
	const BASE_DELAY_MS = 50;
	const MAX_DELAY_MS = 200;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const [event, resource] = await Promise.all([
			dal.events.findByIdempotencyKey(idempotencyKey),
			dal.resources.findById(resourceId),
		]);

		if (
			event &&
			event.eventType === EVENT_TYPES.PAYMENT_CARD_ISSUED &&
			event.resourceId === resourceId &&
			resource &&
			resource.state === "active"
		) {
			return { event, resource };
		}

		if (!resource || resource.state === "deleted") {
			return null;
		}

		const delay =
			Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) +
			Math.floor(Math.random() * BASE_DELAY_MS);
		await sleep(delay);
	}

	return null;
}

const actionsRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.post(
		"/agents/:id/actions/send_email",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: sendEmailParamsSchema,
				body: sendEmailBodySchema,
				response: {
					200: sendEmailResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					422: errorResponseSchema,
					409: errorResponseSchema,
					429: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			return executeOutboundEmailAction({
				request,
				reply,
				agentId: request.params.id,
				input: request.body,
				config: {
					actionType: "send_email",
					conflictMessage: MSG_IDEMPOTENCY_DIFFERENT_EMAIL,
					dispatchFailureMessage: "Failed to send email",
					buildRequestHash: buildSendEmailRequestHash,
					prepareInitialRequestData: ({ input }) => ({
						kind: "ok",
						requestData: {
							to: input.to,
							subject: input.subject,
							text: input.text,
							...(input.html !== undefined ? { html: input.html } : {}),
							...(input.cc !== undefined ? { cc: input.cc } : {}),
							...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
							...(input.reply_to !== undefined
								? { reply_to: input.reply_to }
								: {}),
						},
					}),
					parseStoredRequestData: parseSendEmailActionRequestData,
					getPolicyRecipients: (requestData) => ({
						to: requestData.to,
						cc: requestData.cc,
						bcc: requestData.bcc,
					}),
					buildAdapterPayload: buildSendEmailAdapterPayload,
					buildEventData: buildSendEmailEventData,
				},
			});
		},
	);

	// ---------------------------------------------------------------------------
	// POST /agents/:id/actions/issue_card
	// ---------------------------------------------------------------------------

	server.post(
		"/agents/:id/actions/issue_card",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: issueCardParamsSchema,
				body: issueCardBodySchema,
				response: {
					200: issueCardResponseSchema,
					202: errorResponseSchema,
					401: errorResponseSchema,
					409: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					422: errorResponseSchema,
					500: errorResponseSchema,
					502: errorResponseSchema,
					503: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const { org_id: orgId } = request.auth;
			const dal = request.dalFactory(orgId);
			const agentId = request.params.id;

			const agent = await dal.agents.findById(agentId);
			if (!agent || agent.isArchived) {
				return reply.code(404).send({ message: "Agent not found" });
			}

			const org = await server.systemDal.getOrg(orgId);
			if (
				org?.subscriptionStatus === "active" ||
				org?.subscriptionStatus === "trialing"
			) {
				await enforceCardLimit(orgId, org.planTier as PlanTier);
			}

			const {
				cardholder_name,
				billing_address,
				currency,
				spending_limits,
				allowed_categories,
				blocked_categories,
				allowed_merchant_countries,
				blocked_merchant_countries,
				idempotency_key,
			} = request.body;

			const config: Record<string, unknown> = {
				cardholder_name,
				billing_address,
				currency,
				...(spending_limits !== undefined ? { spending_limits } : {}),
				...(allowed_categories !== undefined ? { allowed_categories } : {}),
				...(blocked_categories !== undefined ? { blocked_categories } : {}),
				...(allowed_merchant_countries !== undefined
					? { allowed_merchant_countries }
					: {}),
				...(blocked_merchant_countries !== undefined
					? { blocked_merchant_countries }
					: {}),
			};
			const idempotentResourceId = idempotency_key
				? buildIdempotentCardResourceId(orgId, idempotency_key)
				: undefined;

			if (idempotency_key) {
				const existingEvent =
					await dal.events.findByIdempotencyKey(idempotency_key);
				if (existingEvent) {
					if (
						existingEvent.eventType !== EVENT_TYPES.PAYMENT_CARD_ISSUED ||
						existingEvent.agentId !== agentId ||
						!existingEvent.resourceId
					) {
						return reply
							.code(409)
							.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
					}

					const existingResource = await dal.resources.findById(
						existingEvent.resourceId,
					);
					if (!existingResource || existingResource.state !== "active") {
						return reply.code(409).send({
							message: "Idempotency replay found an incomplete card issuance",
						});
					}

					if (!matchesCardIssuanceConfig(existingResource, config)) {
						return reply.code(409).send({
							message:
								"Idempotency key already used with different card parameters",
						});
					}

					return reply
						.code(200)
						.send(serializeIssueCardResponse(existingResource, existingEvent));
				}

				if (idempotentResourceId) {
					const existingResource =
						await dal.resources.findById(idempotentResourceId);
					if (existingResource) {
						if (!isStripeCardResourceForAgent(existingResource, agentId)) {
							return reply
								.code(409)
								.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
						}

						if (!matchesCardIssuanceConfig(existingResource, config)) {
							return reply.code(409).send({
								message:
									"Idempotency key already used with different card parameters",
							});
						}
					}
				}
			}

			if (!server.stripeAdapter) {
				return reply
					.code(422)
					.send({ message: "Card capabilities are not currently available" });
			}

			let resource: ResourceRecord;
			let reusedExisting: boolean | undefined;
			try {
				const provisioned = await server.resourceManager.provision(
					dal,
					agentId,
					"card",
					"stripe",
					config,
					{ resourceId: idempotentResourceId },
				);
				resource = provisioned.resource;
				reusedExisting = provisioned.reusedExisting;
			} catch (error) {
				if (
					replyFromStripeError(reply, error, "Stripe card provisioning failed")
				) {
					return;
				}

				throw error;
			}

			if (reusedExisting) {
				if (!idempotency_key) {
					return reply
						.code(500)
						.send({ message: "Idempotent replay missing idempotency key" });
				}

				if (!isStripeCardResourceForAgent(resource, agentId)) {
					return reply
						.code(409)
						.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
				}

				if (!matchesCardIssuanceConfig(resource, config)) {
					return reply.code(409).send({
						message:
							"Idempotency key already used with different card parameters",
					});
				}

				const existingEvent =
					await dal.events.findByIdempotencyKey(idempotency_key);
				if (existingEvent) {
					if (
						!isIssuedCardEventForResource(existingEvent, agentId, resource.id)
					) {
						return reply
							.code(409)
							.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
					}

					return reply
						.code(200)
						.send(serializeIssueCardResponse(resource, existingEvent));
				}

				if (resource.state === "provisioning") {
					const replay = await waitForIssuedCardReplay(
						dal,
						resource.id,
						idempotency_key,
					);
					if (replay) {
						if (
							!isStripeCardResourceForAgent(replay.resource, agentId) ||
							!isIssuedCardEventForResource(
								replay.event,
								agentId,
								replay.resource.id,
							)
						) {
							return reply
								.code(409)
								.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
						}

						return reply
							.code(200)
							.send(serializeIssueCardResponse(replay.resource, replay.event));
					}

					return reply.code(202).send({
						message: `Card issuance in progress (resource: ${resource.id})`,
					});
				}

				if (resource.state !== "active") {
					return reply.code(409).send({
						message: "Idempotency replay found a non-active card resource",
					});
				}

				const recovered = await server.eventWriter.writeEvent({
					orgId,
					agentId,
					resourceId: resource.id,
					provider: "stripe",
					eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
					idempotencyKey: idempotency_key,
					data: { card_id: resource.providerRef ?? resource.id },
				});

				if (
					!isIssuedCardEventForResource(recovered.event, agentId, resource.id)
				) {
					return reply
						.code(409)
						.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
				}

				return reply
					.code(200)
					.send(serializeIssueCardResponse(resource, recovered.event));
			}

			// Log provisioned resource without sensitive fields
			request.log.info(
				{ resourceId: resource.id, providerRef: resource.providerRef },
				"Card resource provisioned",
			);

			const { event } = await server.eventWriter.writeEvent({
				orgId,
				agentId,
				resourceId: resource.id,
				provider: "stripe",
				eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
				idempotencyKey: idempotency_key,
				data: { card_id: resource.providerRef ?? resource.id },
			});

			if (
				idempotency_key &&
				!isIssuedCardEventForResource(event, agentId, resource.id)
			) {
				return reply
					.code(409)
					.send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
			}

			return reply.code(200).send(serializeIssueCardResponse(resource, event));
		},
	);

	server.post(
		"/agents/:id/actions/create_card_details_session",
		{
			preHandler: [requireScope("agents:write"), requireKeyType("root")],
			schema: {
				params: createCardDetailsSessionParamsSchema,
				body: createCardDetailsSessionBodySchema,
				response: {
					200: createCardDetailsSessionResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					422: errorResponseSchema,
					500: errorResponseSchema,
					502: errorResponseSchema,
					503: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const dal = request.dalFactory(request.auth.org_id);
			const agent = await dal.agents.findById(request.params.id);
			if (!agent || agent.isArchived) {
				return reply.code(404).send({ message: "Agent not found" });
			}

			const resource = await dal.resources.findById(request.body.resource_id);
			if (
				!resource ||
				!isStripeCardResourceForAgent(resource, request.params.id)
			) {
				return reply.code(404).send({ message: "Card resource not found" });
			}

			if (resource.state !== "active") {
				return reply.code(409).send({ message: "Card resource is not active" });
			}

			if (!server.stripeAdapter) {
				return reply
					.code(422)
					.send({ message: "Card capabilities are not currently available" });
			}

			try {
				const session = await server.stripeAdapter.createCardDetailsSession(
					resource,
					request.body.nonce,
				);

				request.log.info(
					{ resourceId: resource.id, expiresAt: session.expiresAt },
					"Created Stripe card details session",
				);

				return await reply
					.code(200)
					.send(serializeCardDetailsSessionResponse(resource, session));
			} catch (error) {
				if (
					replyFromStripeError(
						reply,
						error,
						"Stripe card details session failed",
					)
				) {
					return;
				}

				throw error;
			}
		},
	);

	// ---------------------------------------------------------------------------
	// POST /agents/:id/actions/reply_email
	// ---------------------------------------------------------------------------

	server.post(
		"/agents/:id/actions/reply_email",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: replyEmailParamsSchema,
				body: replyEmailBodySchema,
				response: {
					200: replyEmailResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					422: errorResponseSchema,
					409: errorResponseSchema,
					429: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			return executeOutboundEmailAction({
				request,
				reply,
				agentId: request.params.id,
				input: request.body,
				config: {
					actionType: "reply_email",
					conflictMessage: MSG_IDEMPOTENCY_DIFFERENT_REPLY,
					dispatchFailureMessage: "Failed to send reply",
					buildRequestHash: buildReplyEmailRequestHash,
					prepareInitialRequestData: ({ reply, adapter, resource, input }) =>
						prepareReplyEmailRequestData(reply, adapter, resource, input),
					parseStoredRequestData: parseReplyEmailActionRequestData,
					getPolicyRecipients: (requestData) => ({
						to: requestData.reply_recipients,
						cc: requestData.cc,
						bcc: requestData.bcc,
					}),
					buildAdapterPayload: buildReplyEmailAdapterPayload,
					buildEventData: buildReplyEmailEventData,
				},
			});
		},
	);

	done();
};

export default fp(actionsRoutes, { name: "actions-routes" });
