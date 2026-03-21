import { sleep } from "../adapters/provider-client";
import { getServerConfig } from "../config";
import { closeDbPool, ensureDbIsReady } from "../db";
import {
	OutboundWebhookWorker,
	parseOutboundWebhookAllowedHosts,
} from "../domain/outbound-webhooks";

async function run() {
	const config = getServerConfig(process.env);
	const worker = new OutboundWebhookWorker({
		requestTimeoutMs: config.OUTBOUND_WEBHOOK_REQUEST_TIMEOUT_MS,
		allowlistedHosts: parseOutboundWebhookAllowedHosts(
			config.OUTBOUND_WEBHOOK_ALLOWED_HOSTS,
		),
		nodeEnv: config.NODE_ENV,
	});

	ensureDbIsReady();

	for (;;) {
		const processedCount = await worker.drainOnce();
		if (processedCount === 0) {
			await sleep(config.OUTBOUND_WEBHOOK_WORKER_POLL_MS);
		}
	}
}

if (require.main === module) {
	run().catch(async (error: unknown) => {
		console.error(error);
		await closeDbPool().catch(() => {});
		process.exit(1);
	});
}
