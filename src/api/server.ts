import crypto from "node:crypto";
import type { FastifyError } from "fastify";
import Fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { getServerConfig } from "../config";
import { AppError } from "../domain/errors";
import authPlugin from "../plugins/auth";
import billingServicesPlugin from "../plugins/billing-services";
import dbPlugin from "../plugins/db";
import eventServicesPlugin from "../plugins/event-services";
import outboundWebhookServicesPlugin from "../plugins/outbound-webhook-services";
import resourceServicesPlugin from "../plugins/resource-services";
import webhookServicesPlugin from "../plugins/webhook-services";
import actionsRoutes from "./routes/actions";
import agentsRoutes from "./routes/agents";
import billingRoutes from "./routes/billing";
import eventsRoutes from "./routes/events";
import healthRoutes from "./routes/health";
import mcpRoutes from "./routes/mcp";
import {
	applyCorsHeaders,
	getOriginHeader,
	isAllowedBrowserOrigin,
	parseAllowedBrowserOrigins,
} from "./routes/mcp-cors";
import messagesRoutes from "./routes/messages";
import orgRoutes from "./routes/orgs";
import resourceRoutes from "./routes/resources";
import timelineRoutes from "./routes/timeline";
import webhookSubscriptionRoutes from "./routes/webhook-subscriptions";
import webhookRoutes from "./routes/webhooks";

export async function buildServer() {
	const config = getServerConfig(process.env);
	const mcpAllowedOrigins = parseAllowedBrowserOrigins(
		config.MCP_ALLOWED_ORIGINS,
	);
	const server = Fastify({
		logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
		requestIdHeader: "x-correlation-id",
		requestIdLogLabel: "reqId",
		genReqId: () => {
			return crypto.randomUUID();
		},
	}).withTypeProvider<ZodTypeProvider>();

	server.setValidatorCompiler(validatorCompiler);
	server.setSerializerCompiler(serializerCompiler);
	server.setErrorHandler((error: FastifyError, request, reply) => {
		if (error.validation) {
			return reply.code(400).send({ message: error.message });
		}

		if (error instanceof AppError) {
			return reply.code(error.httpStatus).send({ message: error.message });
		}

		const statusCode = error.statusCode ?? 500;
		if (statusCode < 500) {
			return reply.code(statusCode).send({ message: error.message });
		}

		request.log.error({ err: error }, "Unhandled server error");
		return reply.code(500).send({ message: "Internal Server Error" });
	});
	server.setNotFoundHandler((_request, reply) => {
		return reply.code(404).send({ message: "Not Found" });
	});

	await server.register(dbPlugin);
	await server.register(authPlugin);
	await server.register(billingServicesPlugin);
	await server.register(outboundWebhookServicesPlugin);
	await server.register(eventServicesPlugin);
	await server.register(resourceServicesPlugin);
	await server.register(webhookServicesPlugin);

	// Subscription enforcement — only active when billing is configured (SIGNUP_SECRET set).
	// Exempt routes: health, webhooks, org creation, billing, MCP.
	if (config.SIGNUP_SECRET) {
		const SUBSCRIPTION_EXEMPT_PREFIXES = [
			"/health",
			"/webhooks/",
			"/orgs",
			"/billing/",
			"/mcp",
		];
		const ACTIVE_STATUSES = new Set(["active", "trialing"]);

		server.addHook("onRequest", async (request, reply) => {
			if (!request.auth) return;

			const url = request.url.split("?")[0];
			if (SUBSCRIPTION_EXEMPT_PREFIXES.some((p) => url.startsWith(p))) return;

			const org = await server.systemDal.getOrg(request.auth.org_id);
			if (org && !ACTIVE_STATUSES.has(org.subscriptionStatus)) {
				return reply.code(402).send({
					message:
						"Active subscription required. Visit /billing/checkout to subscribe.",
				});
			}
		});
	}

	server.addHook("onSend", async (request, reply, _payload) => {
		reply.header("x-correlation-id", request.id);

		if (
			config.MCP_HTTP_ENABLED &&
			request.url.startsWith("/mcp") &&
			!reply.hasHeader("Access-Control-Allow-Origin")
		) {
			const origin = getOriginHeader(request.headers);
			if (origin && isAllowedBrowserOrigin(origin, mcpAllowedOrigins)) {
				applyCorsHeaders(reply.raw, origin);
			}
		}
	});

	await server.register(webhookRoutes);
	await server.register(healthRoutes);
	await server.register(orgRoutes);
	await server.register(agentsRoutes);
	await server.register(eventsRoutes);
	await server.register(webhookSubscriptionRoutes);
	await server.register(timelineRoutes);
	await server.register(resourceRoutes);
	await server.register(actionsRoutes);
	await server.register(billingRoutes);
	await server.register(messagesRoutes);

	if (config.MCP_HTTP_ENABLED) {
		await server.register(mcpRoutes);
	}

	return server;
}

export async function start() {
	const server = await buildServer();
	try {
		const config = getServerConfig(process.env);
		await server.listen({ port: config.PORT, host: config.HOST });
	} catch (err) {
		server.log.error(err);
		process.exit(1);
	}

	const shutdown = async (signal: string) => {
		server.log.info(`Received ${signal}, shutting down gracefully`);
		try {
			await server.close();
			process.exit(0);
		} catch (err) {
			server.log.error({ err }, "Error during shutdown");
			process.exit(1);
		}
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
	start().catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
