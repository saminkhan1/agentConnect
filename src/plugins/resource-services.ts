import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { MockAdapter } from '../adapters/mock-adapter';
import { ResourceManager } from '../domain/resource-manager';

declare module 'fastify' {
  interface FastifyInstance {
    resourceManager: ResourceManager;
  }
}

const resourceServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
  const adapters = new Map([['mock', new MockAdapter()]]);
  server.decorate('resourceManager', new ResourceManager(adapters));
  done();
};

export default fp(resourceServicesPlugin, {
  name: 'resource-services',
  dependencies: ['db'],
});
