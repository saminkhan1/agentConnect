import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

import { pool } from '../db';
import { DalFactory, systemDal } from '../db/dal';

let isPoolClosed = false;

declare module 'fastify' {
  interface FastifyInstance {
    systemDal: typeof systemDal;
  }

  interface FastifyRequest {
    dalFactory: (orgId: string) => DalFactory;
  }
}

const dbPlugin: FastifyPluginCallback = (server, _opts, done) => {
  // Keep write/read access to org-scoped data behind DAL instances.
  server.decorate('systemDal', systemDal);

  // Provide a helper on the request to instantiate an org-scoped DAL
  server.decorateRequest('dalFactory', function dalFactory(orgId: string) {
    return new DalFactory(orgId);
  });

  server.addHook('onClose', async () => {
    if (isPoolClosed) {
      return;
    }
    // Close the postgres pool when the app is tearing down
    await pool.end();
    isPoolClosed = true;
  });

  done();
};

export default fp(dbPlugin, { name: 'db' });
