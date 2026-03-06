import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  listAgentEventsParamsSchema,
  listAgentEventsQuerySchema,
  listAgentEventsResponseSchema,
} from '../schemas/events';
import { errorResponseSchema } from '../schemas/common';
import { events as eventsTable } from '../../db/schema';
import { requireScope } from '../../plugins/auth';

type EventRecord = typeof eventsTable.$inferSelect;

const cursorSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

function encodeCursor(event: Pick<EventRecord, 'id' | 'occurredAt'>) {
  return Buffer.from(
    JSON.stringify({
      occurredAt: event.occurredAt.toISOString(),
      id: event.id,
    }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const parsedCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const parsedCursorResult = cursorSchema.safeParse(parsedCursor);
    if (!parsedCursorResult.success) {
      return null;
    }

    const occurredAt = new Date(parsedCursorResult.data.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      return null;
    }

    return {
      occurredAt,
      id: parsedCursorResult.data.id,
    };
  } catch {
    return null;
  }
}

function serializeEvent(event: EventRecord) {
  return {
    id: event.id,
    orgId: event.orgId,
    agentId: event.agentId,
    resourceId: event.resourceId ?? null,
    provider: event.provider,
    providerEventId: event.providerEventId ?? null,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    idempotencyKey: event.idempotencyKey ?? null,
    data: event.data,
    ingestedAt: event.ingestedAt.toISOString(),
  };
}

const eventsRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
  server.get(
    '/agents/:id/events',
    {
      preHandler: [requireScope('agents:read')],
      schema: {
        params: listAgentEventsParamsSchema,
        querystring: listAgentEventsQuerySchema,
        response: {
          200: listAgentEventsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.code(401).send({
          message: 'Unauthorized',
        });
      }

      const dal = request.dalFactory(request.auth.org_id);
      const existingAgent = await dal.agents.findById(request.params.id);
      if (!existingAgent) {
        return reply.code(404).send({
          message: 'Agent not found',
        });
      }

      const decodedCursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      if (request.query.cursor && !decodedCursor) {
        return reply.code(400).send({
          message: 'Invalid cursor',
        });
      }

      const pageSize = request.query.limit;
      const events = await dal.events.listByAgent(request.params.id, {
        eventType: request.query.type,
        since: request.query.since ? new Date(request.query.since) : undefined,
        until: request.query.until ? new Date(request.query.until) : undefined,
        cursor: decodedCursor ?? undefined,
        limit: pageSize + 1,
      });

      const hasMore = events.length > pageSize;
      const pagedEvents = hasMore ? events.slice(0, pageSize) : events;
      const nextCursor = hasMore ? encodeCursor(pagedEvents[pagedEvents.length - 1]) : null;

      return reply.code(200).send({
        events: pagedEvents.map(serializeEvent),
        nextCursor,
      });
    },
  );
  done();
};

export default eventsRoutes;
