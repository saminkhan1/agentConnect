import { and, count, inArray, lt, sql } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../../db";
import { webhookDeliveries } from "../../db/schema";

const healthResponseSchema = z.object({
	status: z.literal("ok"),
	timestamp: z.iso.datetime(),
	webhookDeliveryBacklog: z.number().int().optional(),
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

			let backlog = 0;
			try {
				const result = await db
					.select({ value: count() })
					.from(webhookDeliveries)
					.where(
						and(
							inArray(webhookDeliveries.lastStatus, [
								"pending",
								"retry_scheduled",
							]),
							lt(webhookDeliveries.nextAttemptAt, new Date()),
						),
					);
				backlog = result[0]?.value ?? 0;
			} catch {
				// Non-fatal — report health as ok even if backlog query fails
			}

			return {
				status: "ok" as const,
				timestamp: new Date().toISOString(),
				webhookDeliveryBacklog: backlog,
			};
		},
	);
	done();
};

export default healthRoutes;
