import crypto from 'node:crypto';

import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import agentsRoutes from './routes/agents';
import eventsRoutes from './routes/events';
import healthRoutes from './routes/health';
import orgRoutes from './routes/orgs';
import authPlugin from '../plugins/auth';
import { getServerConfig } from '../config';
import dbPlugin from '../plugins/db';
import eventServicesPlugin from '../plugins/event-services';

export async function buildServer() {
  const config = getServerConfig(process.env);
  const server = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    requestIdHeader: 'x-correlation-id',
    requestIdLogLabel: 'reqId',
    genReqId: () => {
      return crypto.randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ message: error.message });
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({ message: error.message });
    }

    request.log.error({ err: error }, 'Unhandled server error');
    return reply.code(500).send({ message: 'Internal Server Error' });
  });
  server.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ message: 'Not Found' });
  });

  await server.register(dbPlugin);
  await server.register(authPlugin);
  await server.register(eventServicesPlugin);

  server.addHook('onSend', async (request, reply, _payload) => {
    reply.header('x-correlation-id', request.id);
  });

  await server.register(healthRoutes);
  await server.register(orgRoutes);
  await server.register(agentsRoutes);
  await server.register(eventsRoutes);

  return server;
}

export async function start() {
  const server = await buildServer();
  try {
    const config = getServerConfig(process.env);
    await server.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
