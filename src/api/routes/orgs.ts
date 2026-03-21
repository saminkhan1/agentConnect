import crypto from "node:crypto";

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { getServerConfig } from "../../config";
import { generateApiKeyMaterial } from "../../domain/api-keys";
import {
	getConfiguredCheckoutPlanTiers,
	type PlanTier,
} from "../../domain/billing";
import { requireKeyType, requireScope } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";
import {
	createApiKeyParamsSchema,
	createOrgBodySchema,
	createOrgResponseSchema,
	createServiceApiKeyResponseSchema,
	revokeApiKeyParamsSchema,
	revokeApiKeyResponseSchema,
	rotateRootKeyParamsSchema,
	rotateRootKeyResponseSchema,
} from "../schemas/orgs";

function buildBillingCheckoutNextStepMessage(planTiers: PlanTier[]): string {
	if (planTiers.length === 1) {
		return `Use your API key to call POST /billing/checkout with plan_tier="${planTiers[0]}", success_url, and cancel_url to activate your subscription.`;
	}

	const supportedPlanTiers = planTiers.map((tier) => `"${tier}"`).join(", ");
	return `Use your API key to call POST /billing/checkout with plan_tier set to one of ${supportedPlanTiers}, plus success_url and cancel_url, to activate your subscription.`;
}

const orgRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	const config = getServerConfig(process.env);
	const apiKeyLifecycleLock = (orgId: string) =>
		`org:${orgId}:api-key-lifecycle`;

	server.post(
		"/orgs",
		{
			schema: {
				body: createOrgBodySchema,
				response: {
					201: createOrgResponseSchema,
					403: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (config.SIGNUP_SECRET) {
				const provided = request.headers["x-signup-secret"];
				if (provided !== config.SIGNUP_SECRET) {
					return reply.code(403).send({ message: "Invalid signup secret" });
				}
			}

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
			const checkoutPlanTiers = server.billingService
				? getConfiguredCheckoutPlanTiers(config)
				: [];

			return reply.code(201).send({
				org: {
					id: result.org.id,
					name: result.org.name,
					createdAt: result.org.createdAt.toISOString(),
				},
				apiKey: {
					id: result.apiKey.id,
					orgId: result.apiKey.orgId,
					keyType: "root" as const,
					key: rootKey.plaintextKey,
					createdAt: result.apiKey.createdAt.toISOString(),
				},
				...(checkoutPlanTiers.length > 0
					? {
							nextStep: {
								action: "POST /billing/checkout",
								message: buildBillingCheckoutNextStepMessage(checkoutPlanTiers),
							},
						}
					: {}),
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
	server.post(
		"/orgs/:id/api-keys/rotate-root",
		{
			preHandler: [requireScope("api_keys:write"), requireKeyType("root")],
			schema: {
				params: rotateRootKeyParamsSchema,
				response: {
					200: rotateRootKeyResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const auth = request.auth;
			if (!auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			if (auth.org_id !== request.params.id) {
				return reply.code(403).send({ message: "Forbidden" });
			}

			const org = await server.systemDal.getOrg(request.params.id);
			if (!org) {
				return reply.code(404).send({ message: "Organization not found" });
			}

			const dal = request.dalFactory(org.id);

			return await server.withAdvisoryLock(
				apiKeyLifecycleLock(org.id),
				async () => {
					const currentKey = await dal.apiKeys.findById(auth.key_id);
					if (
						!currentKey ||
						currentKey.isRevoked ||
						currentKey.keyType !== "root"
					) {
						return reply.code(401).send({ message: "Unauthorized" });
					}

					const newRootKey = await generateApiKeyMaterial();
					const createdKey = await dal.apiKeys.insert({
						id: newRootKey.id,
						keyType: "root",
						keyHash: newRootKey.keyHash,
					});

					return reply.code(200).send({
						apiKey: {
							id: createdKey.id,
							orgId: createdKey.orgId,
							keyType: "root" as const,
							key: newRootKey.plaintextKey,
							createdAt: createdKey.createdAt.toISOString(),
						},
						previousKeyId: currentKey.id,
						message:
							"New root key issued. Keep your current root key until the new key is safely stored, then revoke the previous key via POST /orgs/:id/api-keys/:keyId/revoke.",
					});
				},
			);
		},
	);

	server.post(
		"/orgs/:id/api-keys/:keyId/revoke",
		{
			preHandler: [requireScope("api_keys:write"), requireKeyType("root")],
			schema: {
				params: revokeApiKeyParamsSchema,
				response: {
					200: revokeApiKeyResponseSchema,
					401: errorResponseSchema,
					403: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const auth = request.auth;
			if (!auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			if (auth.org_id !== request.params.id) {
				return reply.code(403).send({ message: "Forbidden" });
			}

			const org = await server.systemDal.getOrg(request.params.id);
			if (!org) {
				return reply.code(404).send({ message: "Organization not found" });
			}

			const dal = request.dalFactory(org.id);

			return await server.withAdvisoryLock(
				apiKeyLifecycleLock(org.id),
				async () => {
					const actingKey = await dal.apiKeys.findById(auth.key_id);
					if (
						!actingKey ||
						actingKey.isRevoked ||
						actingKey.keyType !== "root"
					) {
						return reply.code(401).send({ message: "Unauthorized" });
					}

					const targetKey = await dal.apiKeys.findById(request.params.keyId);
					if (!targetKey) {
						return reply.code(404).send({ message: "API key not found" });
					}

					if (targetKey.isRevoked) {
						return reply.code(200).send({
							revokedKeyId: targetKey.id,
							message: "API key already revoked",
						});
					}

					if (targetKey.keyType === "root") {
						const activeRootKeys = (await dal.apiKeys.findMany()).filter(
							(key) => key.keyType === "root" && !key.isRevoked,
						);
						if (activeRootKeys.length <= 1) {
							return reply.code(409).send({
								message: "At least one active root key must remain",
							});
						}
					}

					const revokedKey = await dal.apiKeys.revokeById(request.params.keyId);
					if (!revokedKey) {
						return reply.code(404).send({ message: "API key not found" });
					}

					return reply.code(200).send({
						revokedKeyId: revokedKey.id,
						message: "API key revoked",
					});
				},
			);
		},
	);

	done();
};

export default orgRoutes;
