import fs from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance } from 'fastify';

import type { AuthContext } from '../plugins/auth.js';
import { registerTools } from './tools/index.js';

export function readPackageVersion(startDir = __dirname): string {
  let currentDir = startDir;

  for (;;) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        return parsed.version;
      }

      throw new Error(`package.json at ${packageJsonPath} is missing a valid version field`);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  throw new Error(`Unable to locate package.json from ${startDir}`);
}

const version = readPackageVersion(__dirname);

export type McpSessionContext = {
  auth: AuthContext | null;
  authorizationHeader: string | null;
  allowToolAuthorizationFallback?: boolean;
};

export function buildMcpServer(fastify: FastifyInstance, session: McpSessionContext): McpServer {
  const server = new McpServer({ name: 'agentinfra', version });
  registerTools(server, fastify, session);
  return server;
}
