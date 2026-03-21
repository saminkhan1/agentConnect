import type { IncomingHttpHeaders } from "node:http";

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

function normalizeWebhookHeaders(
	headers: IncomingHttpHeaders,
): Record<string, string> {
	const normalized: Record<string, string> = {};

	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			normalized[key] = value;
			continue;
		}

		if (Array.isArray(value) && value.length > 0) {
			normalized[key] = value.join(",");
		}
	}

	return normalized;
}

// Do NOT wrap in fp() — must be encapsulated so content-type parser stays scoped
const webhookRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
	// Override JSON parsing for this scope only — gives raw Buffer as request.body
	server.addContentTypeParser(
		"application/json",
		{ parseAs: "buffer" },
		(_req, body, done_) => {
			done_(null, body);
		},
	);

	server.post("/webhooks/agentmail", {}, async (request, reply) => {
		const rawBody = request.body as Buffer;
		const headers = normalizeWebhookHeaders(request.headers);
		const adapter = server.agentMailAdapter;
		if (!adapter) {
			return reply.code(500).send({ message: "AgentMail not configured" });
		}

		const isValid = await adapter.verifyWebhook(rawBody, headers);
		if (!isValid) {
			request.log.warn("AgentMail webhook signature verification failed");
			return reply.code(401).send({ message: "Invalid webhook signature" });
		}

		try {
			const events = await adapter.parseWebhook(rawBody, headers);
			await server.webhookProcessor.processEvents("agentmail", events);
		} catch (err) {
			request.log.error({ err }, "AgentMail webhook processing error");
			return reply.code(500).send({ message: "Webhook processing failed" });
		}

		return reply.code(200).send({ ok: true });
	});

	server.post("/webhooks/stripe-billing", {}, async (request, reply) => {
		const rawBody = request.body as Buffer;
		const billing = server.billingService;
		if (!billing) {
			return reply.code(500).send({ message: "Billing not configured" });
		}

		const signature = request.headers["stripe-signature"];
		if (!signature || typeof signature !== "string") {
			return reply
				.code(401)
				.send({ message: "Missing stripe-signature header" });
		}

		const webhookSecret = server.billingWebhookSecret;
		if (!webhookSecret) {
			return reply
				.code(500)
				.send({ message: "Billing webhook secret not configured" });
		}

		try {
			const event = billing.constructEvent(rawBody, signature, webhookSecret);
			await billing.syncSubscription(event);
		} catch (err) {
			request.log.error({ err }, "Stripe billing webhook error");
			return reply.code(400).send({ message: "Webhook verification failed" });
		}

		return reply.code(200).send({ ok: true });
	});

	server.post("/webhooks/stripe", {}, async (request, reply) => {
		const rawBody = request.body as Buffer;
		const headers = normalizeWebhookHeaders(request.headers);
		const adapter = server.stripeAdapter;
		if (!adapter) {
			return reply.code(500).send({ message: "Stripe not configured" });
		}

		const isValid = await adapter.verifyWebhook(rawBody, headers);
		if (!isValid) {
			request.log.warn("Stripe webhook signature verification failed");
			return reply.code(401).send({ message: "Invalid webhook signature" });
		}

		try {
			const events = await adapter.parseWebhook(rawBody, headers);
			await server.webhookProcessor.processEvents("stripe", events);
		} catch (err) {
			request.log.error({ err }, "Stripe webhook processing error");
			return reply.code(500).send({ message: "Webhook processing failed" });
		}

		return reply.code(200).send({ ok: true });
	});

	done();
};

export default webhookRoutes;
