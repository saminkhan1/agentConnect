import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { closeDbPool, ensureDbIsReady, withAdvisoryLock } from '../db';
import { DalFactory, systemDal } from '../db/dal';

let activeServerCount = 0;

declare module 'fastify' {
  interface FastifyInstance {
    systemDal: typeof systemDal;
    withAdvisoryLock<T>(lockKey: string, callback: () => Promise<T>): Promise<T>;
  }

  interface FastifyRequest {
    dalFactory: (orgId: string) => DalFactory;
  }
}

const dbPlugin: FastifyPluginCallback = (server, _opts, done) => {
  ensureDbIsReady();
  activeServerCount += 1;

  // Keep write/read access to org-scoped data behind DAL instances.
  server.decorate('systemDal', systemDal);
  server.decorate('withAdvisoryLock', withAdvisoryLock);

  // Provide a helper on the request to instantiate an org-scoped DAL
  server.decorateRequest('dalFactory', function dalFactory(orgId: string) {
    return new DalFactory(orgId);
  });

  server.addHook('onClose', async () => {
    activeServerCount = Math.max(0, activeServerCount - 1);
    if (activeServerCount === 0) {
      // Close pool when the last Fastify instance in this process is closed.
      await closeDbPool();
    }
  });

  done();
};

export default fp(dbPlugin, { name: 'db' });
