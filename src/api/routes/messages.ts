import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import fp from 'fastify-plugin';

import { getMessageParamsSchema, getMessageResponseSchema } from '../schemas/messages';
import { errorResponseSchema } from '../schemas/common';
import { withTimeout } from '../../adapters/provider-client';
import { requireScope } from '../../plugins/auth';
import { replyFromAgentMailError } from './agentmail-errors';
import {
  normalizeEmailAddress,
  normalizeNullableNumber,
  normalizeNullableString,
  normalizeStringArray,
  normalizeUnknownRecord,
} from './email-utils';

const ADAPTER_TIMEOUT_MS = 30_000;

const messagesRoutes: FastifyPluginCallbackZod = (server, _opts, done) => {
  server.get(
    '/agents/:id/messages/:messageId',
    {
      preHandler: [requireScope('agents:read')],
      schema: {
        params: getMessageParamsSchema,
        response: {
          200: getMessageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
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

      const [agent, emailResource] = await Promise.all([
        dal.agents.findById(agentId),
        dal.resources.findActiveByAgentIdAndType(agentId, 'email_inbox', 'agentmail'),
      ]);

      if (!agent || agent.isArchived) {
        return reply.code(404).send({ message: 'Agent not found' });
      }
      if (!emailResource) {
        return reply.code(404).send({ message: 'No active agentmail email inbox found for agent' });
      }

      const adapter = server.agentMailAdapter;
      if (!adapter) {
        return reply.code(500).send({ message: 'AgentMail adapter not configured' });
      }

      let result: Record<string, unknown>;
      try {
        result = await withTimeout(
          () =>
            adapter.performAction(emailResource, 'get_message', {
              message_id: request.params.messageId,
            }),
          ADAPTER_TIMEOUT_MS,
        );
      } catch (error) {
        if (replyFromAgentMailError(reply, error, 'Failed to fetch message')) {
          return reply;
        }

        throw error;
      }

      return reply.code(200).send({
        message_id: (result['message_id'] as string) || '',
        thread_id: (result['thread_id'] as string) || '',
        from: normalizeEmailAddress(result['from']) ?? '',
        labels: normalizeStringArray(result['labels']),
        timestamp: normalizeNullableString(result['timestamp']),
        to: normalizeStringArray(result['to']),
        cc: normalizeStringArray(result['cc']),
        bcc: normalizeStringArray(result['bcc']),
        reply_to: normalizeStringArray(result['reply_to']),
        subject: normalizeNullableString(result['subject']),
        preview: normalizeNullableString(result['preview']),
        text: normalizeNullableString(result['text']),
        html: normalizeNullableString(result['html']),
        headers: normalizeUnknownRecord(result['headers']),
        in_reply_to: normalizeNullableString(result['in_reply_to']),
        references: normalizeStringArray(result['references']),
        size: normalizeNullableNumber(result['size']),
        created_at: normalizeNullableString(result['created_at']),
        updated_at: normalizeNullableString(result['updated_at']),
      });
    },
  );

  done();
};

export default fp(messagesRoutes, { name: 'messages-routes' });
