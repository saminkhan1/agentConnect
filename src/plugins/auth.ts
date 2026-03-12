import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import {
  ApiKeyType,
  ApiScope,
  getScopesForApiKeyType,
  parseApiKeyFromAuthorizationHeader,
  verifyApiKeySecret,
} from '../domain/api-keys';

export type AuthContext = {
  org_id: string;
  key_id: string;
  key_type: ApiKeyType;
  scopes: ApiScope[];
};

type AuthApiKeyRecord = {
  id: string;
  orgId: string;
  keyType: ApiKeyType;
  keyHash: string;
  isRevoked: boolean;
};

type AuthApiKeyLookup = {
  getApiKeyById(id: string): Promise<AuthApiKeyRecord | null>;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send({ message: 'Unauthorized' });
}

export async function resolveAuthContext(
  apiKeys: AuthApiKeyLookup,
  authorizationHeader: string,
): Promise<AuthContext | null> {
  const parsedApiKey = parseApiKeyFromAuthorizationHeader(authorizationHeader);
  if (!parsedApiKey) {
    return null;
  }

  const apiKey = await apiKeys.getApiKeyById(parsedApiKey.keyId);
  if (!apiKey || apiKey.isRevoked) {
    return null;
  }

  const isValidSecret = await verifyApiKeySecret(parsedApiKey.secret, apiKey.keyHash);
  if (!isValidSecret) {
    return null;
  }

  return {
    org_id: apiKey.orgId,
    key_id: apiKey.id,
    key_type: apiKey.keyType,
    scopes: getScopesForApiKeyType(apiKey.keyType),
  };
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

export function requireKeyType(...requiredKeyTypes: ApiKeyType[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) {
      return reply.code(401).send({ message: 'Unauthorized' });
    }

    if (!requiredKeyTypes.includes(auth.key_type)) {
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

    const auth = await resolveAuthContext(server.systemDal, authorizationHeader);
    if (!auth) {
      return sendUnauthorized(reply);
    }

    request.auth = auth;
  });

  done();
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['db'],
});
