import crypto from "node:crypto";

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { agents as agentsTable } from "../../db/schema";
import { requireScope } from "../../plugins/auth";
import {
	agentIdParamsSchema,
	createAgentBodySchema,
	createAgentResponseSchema,
	listAgentsQuerySchema,
	listAgentsResponseSchema,
	updateAgentBodySchema,
} from "../schemas/agents";
import { errorResponseSchema } from "../schemas/common";

type AgentRecord = typeof agentsTable.$inferSelect;

function serializeAgent(agent: AgentRecord) {
	return {
		id: agent.id,
		orgId: agent.orgId,
		name: agent.name,
		isArchived: agent.isArchived,
		createdAt: agent.createdAt.toISOString(),
	};
}

const agentsRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.post(
		"/agents",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				body: createAgentBodySchema,
				response: {
					201: createAgentResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({
					message: "Unauthorized",
				});
			}

			const createdAgent = await request
				.dalFactory(request.auth.org_id)
				.agents.insert({
					id: `agt_${crypto.randomUUID()}`,
					name: request.body.name.trim(),
				});

			return reply.code(201).send({
				agent: serializeAgent(createdAgent),
			});
		},
	);

	server.get(
		"/agents",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				querystring: listAgentsQuerySchema,
				response: {
					200: listAgentsResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({
					message: "Unauthorized",
				});
			}

			const existingAgents = await request
				.dalFactory(request.auth.org_id)
				.agents.findMany({ includeArchived: request.query.includeArchived });

			return reply.code(200).send({
				agents: existingAgents.map(serializeAgent),
			});
		},
	);

	server.get(
		"/agents/:id",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				params: agentIdParamsSchema,
				response: {
					200: createAgentResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({
					message: "Unauthorized",
				});
			}

			const existingAgent = await request
				.dalFactory(request.auth.org_id)
				.agents.findById(request.params.id);
			if (!existingAgent) {
				return reply.code(404).send({
					message: "Agent not found",
				});
			}

			return reply.code(200).send({
				agent: serializeAgent(existingAgent),
			});
		},
	);

	server.patch(
		"/agents/:id",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: agentIdParamsSchema,
				body: updateAgentBodySchema,
				response: {
					200: createAgentResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({
					message: "Unauthorized",
				});
			}

			const updates: { name?: string; isArchived?: boolean } = {};
			if (request.body.name !== undefined) {
				updates.name = request.body.name;
			}
			if (request.body.isArchived !== undefined) {
				updates.isArchived = request.body.isArchived;
			}

			const updatedAgent = await request
				.dalFactory(request.auth.org_id)
				.agents.updateById(request.params.id, updates);

			if (!updatedAgent) {
				return reply.code(404).send({
					message: "Agent not found",
				});
			}

			return reply.code(200).send({
				agent: serializeAgent(updatedAgent),
			});
		},
	);

	server.delete(
		"/agents/:id",
		{
			preHandler: [requireScope("agents:write")],
			schema: {
				params: agentIdParamsSchema,
				response: {
					200: createAgentResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({
					message: "Unauthorized",
				});
			}

			const archivedAgent = await request
				.dalFactory(request.auth.org_id)
				.agents.archiveById(request.params.id);
			if (!archivedAgent) {
				return reply.code(404).send({
					message: "Agent not found",
				});
			}

			return reply.code(200).send({
				agent: serializeAgent(archivedAgent),
			});
		},
	);
	done();
};

export default agentsRoutes;
