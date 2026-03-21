import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { redactStaticHeaders } from "../../domain/outbound-webhooks";
import { requireKeyType } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";
import {
	createWebhookSubscriptionBodySchema,
	createWebhookSubscriptionResponseSchema,
	listWebhookDeliveriesResponseSchema,
	webhookSubscriptionDeliveriesParamsSchema,
	webhookSubscriptionDeliveriesQuerySchema,
} from "../schemas/webhook-subscriptions";

const webhookSubscriptionRoutes: FastifyPluginCallbackZod = (
	server,
	_opts,
	done,
) => {
	server.post(
		"/webhook-subscriptions",
		{
			preHandler: [requireKeyType("root")],
			schema: {
				body: createWebhookSubscriptionBodySchema,
				response: {
					201: createWebhookSubscriptionResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const dal = request.dalFactory(request.auth.org_id);
			const { subscription, signingSecret } =
				await server.outboundWebhookService.createSubscription(
					dal,
					request.body,
				);

			return reply.code(201).send({
				subscription: {
					id: subscription.id,
					orgId: subscription.orgId,
					url: subscription.url,
					eventTypes: subscription.eventTypes,
					deliveryMode: subscription.deliveryMode,
					deliveryConfig: subscription.deliveryConfig,
					staticHeaders: redactStaticHeaders(subscription.staticHeaders),
					status: subscription.status,
					createdAt: subscription.createdAt.toISOString(),
					updatedAt: subscription.updatedAt.toISOString(),
				},
				signingSecret,
			});
		},
	);

	server.get(
		"/webhook-subscriptions/:id/deliveries",
		{
			preHandler: [requireKeyType("root")],
			schema: {
				params: webhookSubscriptionDeliveriesParamsSchema,
				querystring: webhookSubscriptionDeliveriesQuerySchema,
				response: {
					200: listWebhookDeliveriesResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const dal = request.dalFactory(request.auth.org_id);
			const deliveries = await server.outboundWebhookService.listDeliveries(
				dal,
				request.params.id,
				{
					limit: request.query.limit,
				},
			);

			return reply.code(200).send({
				deliveries: deliveries.map((delivery) => ({
					id: delivery.id,
					subscriptionId: delivery.subscriptionId,
					eventId: delivery.eventId,
					eventType: delivery.eventType,
					agentId: delivery.agentId,
					resourceId: delivery.resourceId ?? null,
					occurredAt: delivery.occurredAt.toISOString(),
					attemptCount: delivery.attemptCount,
					lastStatus: delivery.lastStatus,
					nextAttemptAt: delivery.nextAttemptAt.toISOString(),
					lastResponseStatusCode: delivery.lastResponseStatusCode ?? null,
					lastResponseBody: delivery.lastResponseBody ?? null,
					lastRequestHeaders: delivery.lastRequestHeaders,
					lastPayload: delivery.lastPayload ?? null,
					lastError: delivery.lastError ?? null,
					deliveredAt: delivery.deliveredAt
						? delivery.deliveredAt.toISOString()
						: null,
					createdAt: delivery.createdAt.toISOString(),
					updatedAt: delivery.updatedAt.toISOString(),
				})),
			});
		},
	);

	done();
};

export default webhookSubscriptionRoutes;
