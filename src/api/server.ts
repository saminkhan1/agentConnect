import crypto from 'node:crypto';

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  createApiKeyParamsSchema,
  createOrgBodySchema,
  createOrgResponseSchema,
  createServiceApiKeyResponseSchema,
  errorResponseSchema,
} from './schemas';
import { generateApiKeyMaterial } from '../domain/api-keys';
import authPlugin, { requireScope } from '../plugins/auth';
import dbPlugin from '../plugins/db';

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
  }).withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Register DB plugin early
  await server.register(dbPlugin);
  await server.register(authPlugin);

  // Attach the request id to the response headers
  server.addHook('onSend', async (request, reply, _payload) => {
    reply.header('x-correlation-id', request.id);
  });

  server.get('/health', async (_request, _reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  server.post(
    '/orgs',
    {
      schema: {
        body: createOrgBodySchema,
        response: {
          201: createOrgResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = `org_${crypto.randomUUID()}`;
      const rootKey = generateApiKeyMaterial();

      const result = await server.systemDal.createOrgWithApiKey({
        org: {
          id: orgId,
          name: request.body.name.trim(),
        },
        apiKey: {
          id: rootKey.id,
          keyType: 'root',
          keyHash: rootKey.keyHash,
        },
      });

      return reply.code(201).send({
        org: {
          id: result.org.id,
          name: result.org.name,
          createdAt: result.org.createdAt.toISOString(),
        },
        apiKey: {
          id: result.apiKey.id,
          orgId: result.apiKey.orgId,
          keyType: 'root',
          key: rootKey.plaintextKey,
          createdAt: result.apiKey.createdAt.toISOString(),
        },
      });
    },
  );

  server.post(
    '/orgs/:id/api-keys',
    {
      preHandler: [requireScope('api_keys:write')],
      schema: {
        params: createApiKeyParamsSchema,
        response: {
          201: createServiceApiKeyResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.code(401).send({
          message: 'Unauthorized',
        });
      }

      if (request.auth.org_id !== request.params.id) {
        return reply.code(403).send({
          message: 'Forbidden',
        });
      }

      const org = await server.systemDal.getOrg(request.params.id);
      if (!org) {
        return reply.code(404).send({
          message: 'Organization not found',
        });
      }

      const serviceKey = generateApiKeyMaterial();
      const createdKey = await request.dalFactory(org.id).apiKeys.insert({
        id: serviceKey.id,
        keyType: 'service',
        keyHash: serviceKey.keyHash,
      });

      return reply.code(201).send({
        apiKey: {
          id: createdKey.id,
          orgId: createdKey.orgId,
          keyType: 'service',
          key: serviceKey.plaintextKey,
          createdAt: createdKey.createdAt.toISOString(),
        },
      });
    },
  );

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
