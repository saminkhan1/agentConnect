import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

import { getServerConfig } from "../config";
import { type BillingService, createBillingService } from "../domain/billing";

declare module "fastify" {
	interface FastifyInstance {
		billingService?: BillingService;
		billingWebhookSecret?: string;
	}
}

const billingServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
	const config = getServerConfig(process.env);
	const billing = createBillingService(config);

	if (billing) {
		server.decorate("billingService", billing);
	}

	if (config.STRIPE_BILLING_WEBHOOK_SECRET) {
		server.decorate(
			"billingWebhookSecret",
			config.STRIPE_BILLING_WEBHOOK_SECRET,
		);
	}

	done();
};

export default fp(billingServicesPlugin, {
	name: "billing-services",
	dependencies: ["db"],
});
