import crypto from "node:crypto";

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { generateApiKeyMaterial } from "../../domain/api-keys";
import { requireScope } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";
import {
	createApiKeyParamsSchema,
	createOrgBodySchema,
	createOrgResponseSchema,
	createServiceApiKeyResponseSchema,
} from "../schemas/orgs";

const orgRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.post(
		"/orgs",
		{
			schema: {
				body: createOrgBodySchema,
				response: {
					201: createOrgResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const orgId = `org_${crypto.randomUUID()}`;
			const rootKey = await generateApiKeyMaterial();

			const result = await server.systemDal.createOrgWithApiKey({
				org: {
					id: orgId,
					name: request.body.name.trim(),
				},
				apiKey: {
					id: rootKey.id,
					keyType: "root",
					keyHash: rootKey.keyHash,
				},
			});

			return reply.code(201).send({
				org: {
					id: result.org.id,
					name: result.org.name,
					createdAt: result.org.createdAt.toISOString(),
				},
				apiKey: {
					id: result.apiKey.id,
					orgId: result.apiKey.orgId,
					keyType: "root",
					key: rootKey.plaintextKey,
					createdAt: result.apiKey.createdAt.toISOString(),
				},
			});
		},
	);

	server.post(
		"/orgs/:id/api-keys",
		{
			preHandler: [requireScope("api_keys:write")],
			schema: {
				params: createApiKeyParamsSchema,
				response: {
					201: createServiceApiKeyResponseSchema,
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

			if (request.auth.org_id !== request.params.id) {
				return reply.code(403).send({
					message: "Forbidden",
				});
			}

			const org = await server.systemDal.getOrg(request.params.id);
			if (!org) {
				return reply.code(404).send({
					message: "Organization not found",
				});
			}

			const serviceKey = await generateApiKeyMaterial();
			const createdKey = await request.dalFactory(org.id).apiKeys.insert({
				id: serviceKey.id,
				keyType: "service",
				keyHash: serviceKey.keyHash,
			});

			return reply.code(201).send({
				apiKey: {
					id: createdKey.id,
					orgId: createdKey.orgId,
					keyType: "service",
					key: serviceKey.plaintextKey,
					createdAt: createdKey.createdAt.toISOString(),
				},
			});
		},
	);
	done();
};

export default orgRoutes;
