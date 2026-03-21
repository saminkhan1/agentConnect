import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

import { getServerConfig } from "../config";
import {
	OutboundWebhookService,
	OutboundWebhookWorker,
	parseOutboundWebhookAllowedHosts,
} from "../domain/outbound-webhooks";

declare module "fastify" {
	interface FastifyInstance {
		outboundWebhookService: OutboundWebhookService;
		outboundWebhookWorker: OutboundWebhookWorker;
	}
}

const outboundWebhookServicesPlugin: FastifyPluginCallback = (
	server,
	_opts,
	done,
) => {
	const config = getServerConfig(process.env);

	server.decorate(
		"outboundWebhookService",
		new OutboundWebhookService({
			allowlistedHosts: parseOutboundWebhookAllowedHosts(
				config.OUTBOUND_WEBHOOK_ALLOWED_HOSTS,
			),
			nodeEnv: config.NODE_ENV,
		}),
	);
	server.decorate(
		"outboundWebhookWorker",
		new OutboundWebhookWorker({
			requestTimeoutMs: config.OUTBOUND_WEBHOOK_REQUEST_TIMEOUT_MS,
			allowlistedHosts: parseOutboundWebhookAllowedHosts(
				config.OUTBOUND_WEBHOOK_ALLOWED_HOSTS,
			),
			nodeEnv: config.NODE_ENV,
		}),
	);

	done();
};

export default fp(outboundWebhookServicesPlugin, {
	name: "outbound-webhook-services",
	dependencies: ["db"],
});
