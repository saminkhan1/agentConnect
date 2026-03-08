import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { WebhookProcessor } from '../domain/webhook-processor';

declare module 'fastify' {
  interface FastifyInstance {
    webhookProcessor: WebhookProcessor;
  }
}

const webhookServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
  server.decorate('webhookProcessor', new WebhookProcessor(server.eventWriter));
  done();
};

export default fp(webhookServicesPlugin, {
  name: 'webhook-services',
  dependencies: ['event-services'],
});
