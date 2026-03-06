import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import {
  EventWriter,
  type IngestProviderEventInput,
  type WriteEventResult,
} from '../domain/event-writer';

declare module 'fastify' {
  interface FastifyInstance {
    eventWriter: EventWriter;
    ingestProviderEvents: (
      provider: string,
      events: IngestProviderEventInput[],
    ) => Promise<WriteEventResult[]>;
  }
}

const eventServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
  const eventWriter = new EventWriter();

  server.decorate('eventWriter', eventWriter);
  server.decorate('ingestProviderEvents', eventWriter.ingestProviderEvents.bind(eventWriter));

  done();
};

export default fp(eventServicesPlugin, {
  name: 'event-services',
  dependencies: ['db'],
});
