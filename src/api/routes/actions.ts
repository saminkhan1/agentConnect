import crypto from 'node:crypto';

import type { InferSelectModel } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import fp from 'fastify-plugin';

import {
  sendEmailBodySchema,
  sendEmailParamsSchema,
  sendEmailResponseSchema,
} from '../schemas/actions';
import { errorResponseSchema } from '../schemas/common';
import { events as eventsTable } from '../../db/schema';
import { requireScope } from '../../plugins/auth';
import { enforceEmailPolicy } from '../../domain/policy';
import { EVENT_TYPES } from '../../domain/events';

type EventRecord = InferSelectModel<typeof eventsTable>;

function serializeEvent(e: EventRecord) {
  return {
    id: e.id,
    orgId: e.orgId,
    agentId: e.agentId,
    resourceId: e.resourceId,
    provider: e.provider,
    providerEventId: e.providerEventId,
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    idempotencyKey: e.idempotencyKey,
    data: e.data,
    ingestedAt: e.ingestedAt.toISOString(),
  };
}

const actionsRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
  server.post(
    '/agents/:id/actions/send_email',
    {
      preHandler: [requireScope('agents:write')],
      schema: {
        params: sendEmailParamsSchema,
        body: sendEmailBodySchema,
        response: {
          200: sendEmailResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.code(401).send({ message: 'Unauthorized' });
      }

      const { org_id: orgId } = request.auth;
      const dal = request.dalFactory(orgId);
      const agentId = request.params.id;

      const agent = await dal.agents.findById(agentId);
      if (!agent || agent.isArchived) {
        return reply.code(404).send({ message: 'Agent not found' });
      }

      const emailResource = await dal.resources.findActiveByAgentIdAndType(
        agentId,
        'email_inbox',
        'agentmail',
      );
      if (!emailResource) {
        return reply.code(404).send({ message: 'No active agentmail email inbox found for agent' });
      }

      const { to, subject, text, html, cc, bcc, reply_to, idempotency_key } = request.body;
      const policyResult = enforceEmailPolicy(emailResource.config, { to, cc, bcc });
      if (!policyResult.allowed) {
        return reply.code(403).send({ message: policyResult.reasons.join('; ') });
      }

      const adapter = server.agentMailAdapter;
      if (!adapter) {
        return reply.code(500).send({ message: 'AgentMail adapter not configured' });
      }

      const actionResult = await adapter.performAction(emailResource, 'send_email', {
        to,
        subject,
        text,
        html,
        cc,
        bcc,
        replyTo: reply_to,
      });

      const { event } = await server.eventWriter.writeEvent({
        orgId,
        agentId,
        resourceId: emailResource.id,
        provider: 'agentmail',
        eventType: EVENT_TYPES.EMAIL_SENT,
        idempotencyKey: idempotency_key,
        data: {
          message_id: (actionResult['message_id'] as string) || crypto.randomUUID(),
          from: emailResource.providerRef,
          to,
          subject,
        },
      });

      return reply.code(200).send({ event: serializeEvent(event) });
    },
  );

  done();
};

export default fp(actionsRoutes, { name: 'actions-routes' });
