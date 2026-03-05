import Fastify from 'fastify';
import crypto from 'node:crypto';

export async function buildServer() {
    const server = Fastify({
        logger: {
            level: 'info',
        },
        // Allows the client to pass in a correlation id.
        // Falls back to genReqId if not provided.
        requestIdHeader: 'x-correlation-id',
        requestIdLogLabel: 'reqId',
        genReqId: () => {
            return crypto.randomUUID();
        },
    });

    // Attach the request id to the response headers
    server.addHook('onSend', async (request, reply, _payload) => {
        reply.header('x-correlation-id', request.id);
    });

    server.get('/health', async (_request, _reply) => {
        return { status: 'ok', timestamp: new Date().toISOString() };
    });

    return server;
}

export async function start() {
    const server = await buildServer();
    try {
        const port = parseInt(process.env.PORT || '3000', 10);
        const host = process.env.HOST || '0.0.0.0';
        await server.listen({ port, host });
        // Fastify's logger already logs the listening address
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}

// Start the server if this file is run directly
if (require.main === module) {
    start().catch((err: unknown) => {
        console.error(err);
        process.exit(1);
    });
}
