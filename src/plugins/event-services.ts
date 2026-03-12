import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { EventWriter } from '../domain/event-writer';

declare module 'fastify' {
  interface FastifyInstance {
    eventWriter: EventWriter;
  }
}

const eventServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
  const eventWriter = new EventWriter({
    onEventCreated: async (dbExecutor, event) => {
      await server.outboundWebhookService.enqueueDeliveriesForEvent(dbExecutor, event);
    },
  });

  server.decorate('eventWriter', eventWriter);

  done();
};

export default fp(eventServicesPlugin, {
  name: 'event-services',
  dependencies: ['db', 'outbound-webhook-services'],
});
