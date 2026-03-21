import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./api/server.js";
import { getServerConfig } from "./config.js";
import { buildMcpServer } from "./mcp/server.js";
import { resolveAuthContext } from "./plugins/auth.js";

async function main() {
	const fastify = await buildServer();
	let transport: StdioServerTransport | null = null;
	let mcp: ReturnType<typeof buildMcpServer> | null = null;

	try {
		await fastify.ready();
		const config = getServerConfig();
		const authorizationHeader = config.AGENTINFRA_API_KEY
			? `Bearer ${config.AGENTINFRA_API_KEY}`
			: null;
		const auth = authorizationHeader
			? await resolveAuthContext(fastify.systemDal, authorizationHeader)
			: null;

		if (authorizationHeader && !auth) {
			throw new Error("AGENTINFRA_API_KEY is invalid or revoked");
		}

		mcp = buildMcpServer(fastify, {
			auth,
			authorizationHeader: auth ? authorizationHeader : null,
			allowToolAuthorizationFallback: true,
		});
		transport = new StdioServerTransport();
		await mcp.connect(transport);
	} catch (error) {
		await transport?.close().catch(() => {});
		await mcp?.close().catch(() => {});
		await fastify.close().catch(() => {});
		throw error;
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
