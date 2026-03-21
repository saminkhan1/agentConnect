import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { resources as resourcesTable } from "../../db/schema";
import type { PlanTier } from "../../domain/billing";
import { enforceInboxLimit } from "../../domain/billing-limits";
import { AppError } from "../../domain/errors";
import { requireScope } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";
import {
	createResourceBodySchema,
	createResourceResponseSchema,
	listResourcesResponseSchema,
	resourceIdParamsSchema,
	resourceParamsSchema,
} from "../schemas/resources";

type ResourceRecord = typeof resourcesTable.$inferSelect;

export function serializeResource(r: ResourceRecord) {
	return {
		id: r.id,
		orgId: r.orgId,
		agentId: r.agentId,
		type: r.type,
		provider: r.provider,
		providerRef: r.providerRef ?? null,
		config: r.config,
		state: r.state,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	};
}

const resourceRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.post(
		"/agents/:id/resources",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: resourceParamsSchema,
				body: createResourceBodySchema,
				response: {
					201: createResourceResponseSchema,
					400: errorResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					422: errorResponseSchema,
					500: errorResponseSchema,
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

			if (request.body.type === "card" && request.body.provider === "stripe") {
				if (!server.stripeAdapter) {
					return reply.code(422).send({
						message: "Card capabilities are not currently available",
					});
				}
				return reply.code(400).send({
					message:
						"Stripe cards must be issued via POST /agents/:id/actions/issue_card",
				});
			}

			if (request.body.type === "email_inbox") {
				const org = await server.systemDal.getOrg(request.auth.org_id);
				if (
					org?.subscriptionStatus === "active" ||
					org?.subscriptionStatus === "trialing"
				) {
					await enforceInboxLimit(
						request.auth.org_id,
						org.planTier as PlanTier,
					);
				}
			}

			try {
				const { resource } = await server.resourceManager.provision(
					dal,
					request.params.id,
					request.body.type,
					request.body.provider,
					request.body.config,
				);
				return await reply
					.code(201)
					.send({ resource: serializeResource(resource) });
			} catch (err) {
				if (err instanceof AppError) {
					return reply
						.code(err.httpStatus as 400 | 404 | 500)
						.send({ message: err.message });
				}
				throw err;
			}
		},
	);

	server.get(
		"/agents/:id/resources",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				params: resourceParamsSchema,
				response: {
					200: listResourcesResponseSchema,
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
			const agent = await dal.agents.findById(request.params.id);
			if (!agent) {
				return reply.code(404).send({ message: "Agent not found" });
			}

			const agentResources = await dal.resources.findByAgentId(
				request.params.id,
			);
			return reply
				.code(200)
				.send({ resources: agentResources.map(serializeResource) });
		},
	);

	server.delete(
		"/agents/:id/resources/:rid",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: resourceIdParamsSchema,
				response: {
					200: createResourceResponseSchema,
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
			const agent = await dal.agents.findById(request.params.id);
			if (!agent) {
				return reply.code(404).send({ message: "Agent not found" });
			}

			try {
				const resource = await server.resourceManager.deprovision(
					dal,
					request.params.rid,
					request.params.id,
				);
				return await reply
					.code(200)
					.send({ resource: serializeResource(resource) });
			} catch (err) {
				if (err instanceof AppError) {
					return reply.code(404).send({ message: err.message });
				}
				throw err;
			}
		},
	);

	done();
};

export default resourceRoutes;
