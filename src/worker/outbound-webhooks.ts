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

	let shuttingDown = false;

	const shutdown = async (signal: string) => {
		console.log(`Received ${signal}, finishing current work...`);
		shuttingDown = true;
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	while (!shuttingDown) {
		const processedCount = await worker.drainOnce();
		if (processedCount === 0) {
			await sleep(config.OUTBOUND_WEBHOOK_WORKER_POLL_MS);
		}
	}

	console.log("Worker shutdown complete");
	await closeDbPool().catch(() => {});
}

if (require.main === module) {
	run().catch(async (error: unknown) => {
		console.error(error);
		await closeDbPool().catch(() => {});
		process.exit(1);
	});
}
