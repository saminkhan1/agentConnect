import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { AgentMailAdapter } from '../adapters/agentmail-adapter';
import { MockAdapter } from '../adapters/mock-adapter';
import type { ProviderAdapter } from '../adapters/provider-adapter';
import { getServerConfig } from '../config';
import { ResourceManager } from '../domain/resource-manager';

declare module 'fastify' {
  interface FastifyInstance {
    resourceManager: ResourceManager;
    agentMailAdapter?: AgentMailAdapter;
  }
}

const resourceServicesPlugin: FastifyPluginCallback = (server, _opts, done) => {
  const config = getServerConfig(process.env);
  const adapters = new Map<string, ProviderAdapter>([['mock', new MockAdapter()]]);

  if (config.AGENTMAIL_API_KEY && config.AGENTMAIL_WEBHOOK_SECRET) {
    const agentMailAdapter = new AgentMailAdapter(
      config.AGENTMAIL_API_KEY,
      config.AGENTMAIL_WEBHOOK_SECRET,
    );
    adapters.set('agentmail', agentMailAdapter);
    server.decorate('agentMailAdapter', agentMailAdapter);
  }

  server.decorate('resourceManager', new ResourceManager(adapters));
  done();
};

export default fp(resourceServicesPlugin, {
  name: 'resource-services',
  dependencies: ['db'],
});
