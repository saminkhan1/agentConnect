import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
	status: z.literal("ok"),
	timestamp: z.iso.datetime(),
});

const healthRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	server.get(
		"/health",
		{
			schema: {
				response: {
					200: healthResponseSchema,
				},
			},
		},
		() => {
			return { status: "ok" as const, timestamp: new Date().toISOString() };
		},
	);
	done();
};

export default healthRoutes;
