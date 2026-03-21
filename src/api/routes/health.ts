import { sql } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../../db";

const healthResponseSchema = z.object({
	status: z.literal("ok"),
	timestamp: z.iso.datetime(),
});

const healthErrorResponseSchema = z.object({
	status: z.literal("error"),
	timestamp: z.iso.datetime(),
});

const healthRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.get(
		"/health",
		{
			schema: {
				response: {
					200: healthResponseSchema,
					503: healthErrorResponseSchema,
				},
			},
		},
		async (_request, reply) => {
			try {
				await db.execute(sql`SELECT 1`);
			} catch {
				return reply.code(503).send({
					status: "error" as const,
					timestamp: new Date().toISOString(),
				});
			}
			return {
				status: "ok" as const,
				timestamp: new Date().toISOString(),
			};
		},
	);
	done();
};

export default healthRoutes;
