import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

export const DEFAULT_MCP_CORS_HEADERS =
  'authorization, content-type, last-event-id, mcp-session-id';
export const MCP_CORS_METHODS = 'GET, POST, DELETE, OPTIONS';
export const MCP_ALLOWED_METHODS = 'POST, OPTIONS';

export function parseAllowedBrowserOrigins(value?: string) {
  return new Set(
    value
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [],
  );
}

export function getOriginHeader(headers: IncomingHttpHeaders): string | null {
  const origin = headers['origin'];
  return typeof origin === 'string' ? origin : null;
}

export function isAllowedBrowserOrigin(origin: string, allowedOrigins: Set<string>) {
  return allowedOrigins.has(origin);
}

export function applyCorsHeaders(
  response: ServerResponse,
  origin: string,
  requestedHeaders = DEFAULT_MCP_CORS_HEADERS,
) {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', MCP_CORS_METHODS);
  response.setHeader('Access-Control-Allow-Headers', requestedHeaders);
  response.setHeader('Access-Control-Max-Age', '3600');
  response.setHeader('Vary', 'Origin, Access-Control-Request-Headers');
}

export function maybeApplyCors(
  requestOrigin: string | null,
  allowedOrigins: Set<string>,
  reply: ServerResponse,
) {
  if (!requestOrigin) {
    return true;
  }

  if (!isAllowedBrowserOrigin(requestOrigin, allowedOrigins)) {
    return false;
  }

  applyCorsHeaders(reply, requestOrigin);
  return true;
}
