import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import {
  ApiScope,
  getScopesForApiKeyType,
  parseApiKeyFromAuthorizationHeader,
  verifyApiKeySecret,
} from '../domain/api-keys';

export type AuthContext = {
  org_id: string;
  key_id: string;
  scopes: ApiScope[];
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send({ message: 'Unauthorized' });
}

export function requireScope(...requiredScopes: ApiScope[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) {
      return reply.code(401).send({ message: 'Unauthorized' });
    }

    const grantedScopes = new Set(auth.scopes);
    const hasRequiredScopes = requiredScopes.every((scope) => grantedScopes.has(scope));
    if (!hasRequiredScopes) {
      return reply.code(403).send({ message: 'Forbidden' });
    }
  };
}

const authPlugin: FastifyPluginCallback = (server, _opts, done) => {
  server.decorateRequest('auth', null);

  server.addHook('onRequest', async (request, reply) => {
    request.auth = null;

    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader === undefined) {
      return;
    }

    if (Array.isArray(authorizationHeader)) {
      return sendUnauthorized(reply);
    }

    const parsedApiKey = parseApiKeyFromAuthorizationHeader(authorizationHeader);
    if (!parsedApiKey) {
      return sendUnauthorized(reply);
    }

    const apiKey = await server.systemDal.getApiKeyById(parsedApiKey.keyId);
    if (!apiKey) {
      return sendUnauthorized(reply);
    }

    if (apiKey.isRevoked) {
      return sendUnauthorized(reply);
    }

    const isValidSecret = await verifyApiKeySecret(parsedApiKey.secret, apiKey.keyHash);
    if (!isValidSecret) {
      return sendUnauthorized(reply);
    }

    request.auth = {
      org_id: apiKey.orgId,
      key_id: apiKey.id,
      scopes: getScopesForApiKeyType(apiKey.keyType),
    };
  });

  done();
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['db'],
});
