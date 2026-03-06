import crypto from 'node:crypto';

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  agentIdParamsSchema,
  createAgentBodySchema,
  createAgentResponseSchema,
  createApiKeyParamsSchema,
  createOrgBodySchema,
  createOrgResponseSchema,
  createServiceApiKeyResponseSchema,
  errorResponseSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  updateAgentBodySchema,
} from './schemas';
import { generateApiKeyMaterial } from '../domain/api-keys';
import authPlugin, { requireScope } from '../plugins/auth';
import dbPlugin from '../plugins/db';

type AgentRecord = {
  id: string;
  orgId: string;
  name: string;
  isArchived: boolean;
  createdAt: Date;
};

function serializeAgent(agent: AgentRecord) {
  return {
    id: agent.id,
    orgId: agent.orgId,
    name: agent.name,
    isArchived: agent.isArchived,
    createdAt: agent.createdAt.toISOString(),
  };
}

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
      const rootKey = await generateApiKeyMaterial();

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

      const serviceKey = await generateApiKeyMaterial();
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

  server.post(
    '/agents',
    {
      preHandler: [requireScope('agents:write')],
      schema: {
        body: createAgentBodySchema,
        response: {
          201: createAgentResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.code(401).send({
          message: 'Unauthorized',
        });
      }

      const createdAgent = await request.dalFactory(request.auth.org_id).agents.insert({
        id: `agt_${crypto.randomUUID()}`,
        name: request.body.name,
      });

      return reply.code(201).send({
        agent: serializeAgent(createdAgent),
      });
    },
  );

  server.get(
    '/agents',
    {
      preHandler: [requireScope('agents:read')],
      schema: {
        querystring: listAgentsQuerySchema,
        response: {
          200: listAgentsResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.code(401).send({
          message: 'Unauthorized',
        });
      }

      const existingAgents = await request
        .dalFactory(request.auth.org_id)
        .agents.findMany({ includeArchived: request.query.includeArchived });

      return reply.code(200).send({
        agents: existingAgents.map(serializeAgent),
      });
    },
  );

  server.get(
    '/agents/:id',
    {
      preHandler: [requireScope('agents:read')],
      schema: {
        params: agentIdParamsSchema,
        response: {
          200: createAgentResponseSchema,
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

      const existingAgent = await request
        .dalFactory(request.auth.org_id)
        .agents.findById(request.params.id);
      if (!existingAgent) {
        return reply.code(404).send({
          message: 'Agent not found',
        });
      }

      return reply.code(200).send({
        agent: serializeAgent(existingAgent),
      });
    },
  );

  server.patch(
    '/agents/:id',
    {
      preHandler: [requireScope('agents:write')],
      schema: {
        params: agentIdParamsSchema,
        body: updateAgentBodySchema,
        response: {
          200: createAgentResponseSchema,
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

      const updates: { name?: string; isArchived?: boolean } = {};
      if (request.body.name !== undefined) {
        updates.name = request.body.name;
      }
      if (request.body.isArchived !== undefined) {
        updates.isArchived = request.body.isArchived;
      }

      const updatedAgent = await request
        .dalFactory(request.auth.org_id)
        .agents.updateById(request.params.id, updates);

      if (!updatedAgent) {
        return reply.code(404).send({
          message: 'Agent not found',
        });
      }

      return reply.code(200).send({
        agent: serializeAgent(updatedAgent),
      });
    },
  );

  server.delete(
    '/agents/:id',
    {
      preHandler: [requireScope('agents:write')],
      schema: {
        params: agentIdParamsSchema,
        response: {
          200: createAgentResponseSchema,
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

      const archivedAgent = await request
        .dalFactory(request.auth.org_id)
        .agents.archiveById(request.params.id);
      if (!archivedAgent) {
        return reply.code(404).send({
          message: 'Agent not found',
        });
      }

      return reply.code(200).send({
        agent: serializeAgent(archivedAgent),
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
