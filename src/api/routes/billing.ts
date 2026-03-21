import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireScope } from "../../plugins/auth";
import { errorResponseSchema } from "../schemas/common";

const checkoutBodySchema = z.object({
	plan_tier: z
		.enum(["starter", "personal", "power"])
		.optional()
		.default("starter"),
	success_url: z.string().url(),
	cancel_url: z.string().url(),
});

const checkoutResponseSchema = z.object({
	url: z.string(),
});

const portalBodySchema = z.object({
	return_url: z.string().url(),
});

const portalResponseSchema = z.object({
	url: z.string(),
});

const billingRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.post(
		"/billing/checkout",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				body: checkoutBodySchema,
				response: {
					200: checkoutResponseSchema,
					401: errorResponseSchema,
					404: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const billing = server.billingService;
			if (!billing) {
				return reply.code(500).send({ message: "Billing not configured" });
			}

			const org = await server.systemDal.getOrg(request.auth.org_id);
			if (!org) {
				return reply.code(404).send({ message: "Organization not found" });
			}

			const result = await billing.createCheckoutSession(
				org.id,
				org.name,
				request.body.plan_tier,
				request.body.success_url,
				request.body.cancel_url,
			);

			return reply.code(200).send(result);
		},
	);

	server.post(
		"/billing/portal",
		{
			preHandler: [requireScope("agents:read")],
			schema: {
				body: portalBodySchema,
				response: {
					200: portalResponseSchema,
					401: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!request.auth) {
				return reply.code(401).send({ message: "Unauthorized" });
			}

			const billing = server.billingService;
			if (!billing) {
				return reply.code(500).send({ message: "Billing not configured" });
			}

			const result = await billing.createPortalSession(
				request.auth.org_id,
				request.body.return_url,
			);

			return reply.code(200).send(result);
		},
	);

	done();
};

export default billingRoutes;
