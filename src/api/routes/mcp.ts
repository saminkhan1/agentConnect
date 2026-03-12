import type { ServerResponse } from 'node:http';

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getServerConfig } from '../../config.js';
import { buildMcpServer } from '../../mcp/server.js';
import {
  DEFAULT_MCP_CORS_HEADERS,
  MCP_ALLOWED_METHODS,
  applyCorsHeaders,
  getOriginHeader,
  isAllowedBrowserOrigin,
  maybeApplyCors,
  parseAllowedBrowserOrigins,
} from './mcp-cors.js';

const MCP_INTERNAL_ERROR = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32603, message: 'Internal server error' },
  id: null,
});

function sendMethodNotAllowed(reply: ServerResponse) {
  reply.statusCode = 405;
  reply.setHeader('Allow', MCP_ALLOWED_METHODS);
  reply.setHeader('content-type', 'application/json');
  reply.end(JSON.stringify({ message: 'Method Not Allowed' }));
}

function sendMcpInternalError(reply: ServerResponse) {
  if (reply.headersSent) {
    if (!reply.writableEnded) {
      reply.end();
    }
    return;
  }

  reply.statusCode = 500;
  reply.setHeader('content-type', 'application/json');
  reply.end(MCP_INTERNAL_ERROR);
}

const mcpRoutes: FastifyPluginCallback = (server, _opts, done) => {
  const config = getServerConfig();
  const allowedOrigins = parseAllowedBrowserOrigins(config.MCP_ALLOWED_ORIGINS);

  server.options('/mcp', async (request, reply) => {
    const origin = getOriginHeader(request.headers);
    if (!origin || !isAllowedBrowserOrigin(origin, allowedOrigins)) {
      return reply.code(403).send({ message: 'Origin not allowed' });
    }

    const requestedHeaders =
      typeof request.headers['access-control-request-headers'] === 'string'
        ? request.headers['access-control-request-headers']
        : DEFAULT_MCP_CORS_HEADERS;
    applyCorsHeaders(reply.raw, origin, requestedHeaders);
    return reply.code(204).send();
  });

  const handleMethodNotAllowed = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = getOriginHeader(request.headers);
    if (!maybeApplyCors(origin, allowedOrigins, reply.raw)) {
      return reply.code(403).send({ message: 'Origin not allowed' });
    }

    reply.hijack();
    sendMethodNotAllowed(reply.raw);
  };

  server.get('/mcp', handleMethodNotAllowed);
  server.delete('/mcp', handleMethodNotAllowed);

  server.post('/mcp', async (request, reply) => {
    // CORS origin check: browser-originated requests always require an explicit allowlist.
    // Server-to-server requests (no Origin header) pass through unconditionally.
    const origin = getOriginHeader(request.headers);
    if (!maybeApplyCors(origin, allowedOrigins, reply.raw)) {
      return reply.code(403).send({ message: 'Origin not allowed' });
    }

    const authorizationHeader =
      typeof request.headers['authorization'] === 'string'
        ? request.headers['authorization']
        : null;

    const mcp = buildMcpServer(server, {
      auth: request.auth,
      authorizationHeader: request.auth ? authorizationHeader : null,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await transport.close().catch(() => {});
      await mcp.close().catch(() => {});
    };

    reply.raw.on('close', () => {
      void cleanup();
    });
    reply.raw.on('finish', () => {
      void cleanup();
    });

    try {
      await mcp.connect(transport);

      // Hand off the raw Node.js streams to the MCP transport
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'MCP request failed');
      await cleanup();
      sendMcpInternalError(reply.raw);
    }
  });

  done();
};

export default fp(mcpRoutes, { name: 'mcp-routes' });
