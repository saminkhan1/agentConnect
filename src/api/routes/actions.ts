import crypto from 'node:crypto';

import type { InferSelectModel } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import fp from 'fastify-plugin';

import {
  issueCardBodySchema,
  issueCardParamsSchema,
  issueCardResponseSchema,
  sendEmailBodySchema,
  sendEmailParamsSchema,
  sendEmailResponseSchema,
} from '../schemas/actions';
import { errorResponseSchema } from '../schemas/common';
import type { DalFactory } from '../../db/dal';
import { events as eventsTable, resources as resourcesTable } from '../../db/schema';
import { requireScope } from '../../plugins/auth';
import { enforceEmailPolicy } from '../../domain/policy';
import { redactSensitive } from '../../domain/redact';
import { EVENT_TYPES } from '../../domain/events';
import { serializeResource } from './resources';

type EventRecord = InferSelectModel<typeof eventsTable>;
type ResourceRecord = InferSelectModel<typeof resourcesTable>;

const MSG_IDEMPOTENCY_DIFFERENT_ACTION = 'Idempotency key already used for a different action';

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

function buildIdempotentCardResourceId(orgId: string, idempotencyKey: string) {
  const digest = crypto
    .createHash('sha256')
    .update(`issue_card:${orgId}:${idempotencyKey}`)
    .digest('hex');
  return `res_${digest}`;
}

function normalizeSpendingLimits(value: unknown) {
  const parsed = Array.isArray(value) ? value : [];
  return parsed
    .flatMap((entry) => {
      const candidate =
        typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null;
      if (
        !candidate ||
        typeof candidate['amount'] !== 'number' ||
        typeof candidate['interval'] !== 'string'
      ) {
        return [];
      }

      return [{ amount: candidate['amount'], interval: candidate['interval'] }];
    })
    .sort(
      (left, right) => left.amount - right.amount || left.interval.localeCompare(right.interval),
    );
}

function normalizeStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .sort((left, right) => left.localeCompare(right));
}

function normalizeCardIssuanceConfig(config: Record<string, unknown>) {
  return {
    billing_name: typeof config['billing_name'] === 'string' ? config['billing_name'] : '',
    spending_limits: normalizeSpendingLimits(config['spending_limits']),
    allowed_categories: normalizeStringArray(config['allowed_categories']),
    allowed_merchant_countries: normalizeStringArray(config['allowed_merchant_countries']),
  };
}

function matchesCardIssuanceConfig(resource: ResourceRecord, config: Record<string, unknown>) {
  if (resource.type !== 'card' || resource.provider !== 'stripe') {
    return false;
  }

  return (
    JSON.stringify(normalizeCardIssuanceConfig(resource.config)) ===
    JSON.stringify(normalizeCardIssuanceConfig(config))
  );
}

function isStripeCardResourceForAgent(resource: ResourceRecord, agentId: string) {
  return resource.type === 'card' && resource.provider === 'stripe' && resource.agentId === agentId;
}

function isIssuedCardEventForResource(event: EventRecord, agentId: string, resourceId: string) {
  return (
    event.eventType === EVENT_TYPES.PAYMENT_CARD_ISSUED &&
    event.agentId === agentId &&
    event.resourceId === resourceId
  );
}

function buildReplayableCard(resource: ResourceRecord, sensitiveData?: Record<string, unknown>) {
  const source = sensitiveData ?? resource.config;
  return {
    number: typeof source['number'] === 'string' ? source['number'] : null,
    cvc: typeof source['cvc'] === 'string' ? source['cvc'] : null,
    exp_month: typeof source['exp_month'] === 'number' ? source['exp_month'] : 0,
    exp_year: typeof source['exp_year'] === 'number' ? source['exp_year'] : 0,
    last4: typeof source['last4'] === 'string' ? source['last4'] : '',
  };
}

function serializeIssueCardResponse(
  resource: ResourceRecord,
  event: EventRecord,
  sensitiveData?: Record<string, unknown>,
) {
  return {
    resource: serializeResource(resource),
    card: buildReplayableCard(resource, sensitiveData),
    event: serializeEvent(event),
  };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForIssuedCardReplay(
  dal: DalFactory,
  resourceId: string,
  idempotencyKey: string,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [event, resource] = await Promise.all([
      dal.events.findByIdempotencyKey(idempotencyKey),
      dal.resources.findById(resourceId),
    ]);

    if (
      event &&
      event.eventType === EVENT_TYPES.PAYMENT_CARD_ISSUED &&
      event.resourceId === resourceId &&
      resource &&
      resource.state === 'active'
    ) {
      return { event, resource };
    }

    if (!resource || resource.state === 'deleted') {
      return null;
    }

    await wait(100);
  }

  return null;
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
          message_id: (actionResult['message_id'] as string) || '',
          from: emailResource.providerRef,
          to,
          subject,
        },
      });

      return reply.code(200).send({ event: serializeEvent(event) });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /agents/:id/actions/issue_card
  // ---------------------------------------------------------------------------

  server.post(
    '/agents/:id/actions/issue_card',
    {
      preHandler: [requireScope('agents:write')],
      schema: {
        params: issueCardParamsSchema,
        body: issueCardBodySchema,
        response: {
          200: issueCardResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
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

      if (!server.stripeAdapter) {
        return reply.code(500).send({ message: 'Stripe adapter not configured' });
      }

      const { spending_limits, allowed_categories, allowed_merchant_countries, idempotency_key } =
        request.body;

      const config: Record<string, unknown> = {
        billing_name: agent.name,
        spending_limits,
        ...(allowed_categories !== undefined ? { allowed_categories } : {}),
        ...(allowed_merchant_countries !== undefined ? { allowed_merchant_countries } : {}),
      };
      const idempotentResourceId = idempotency_key
        ? buildIdempotentCardResourceId(orgId, idempotency_key)
        : undefined;

      if (idempotency_key) {
        const existingEvent = await dal.events.findByIdempotencyKey(idempotency_key);
        if (existingEvent) {
          if (
            existingEvent.eventType !== EVENT_TYPES.PAYMENT_CARD_ISSUED ||
            existingEvent.agentId !== agentId ||
            !existingEvent.resourceId
          ) {
            return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
          }

          const existingResource = await dal.resources.findById(existingEvent.resourceId);
          if (!existingResource || existingResource.state !== 'active') {
            return reply
              .code(409)
              .send({ message: 'Idempotency replay found an incomplete card issuance' });
          }

          if (!matchesCardIssuanceConfig(existingResource, config)) {
            return reply
              .code(409)
              .send({ message: 'Idempotency key already used with different card parameters' });
          }

          return reply.code(200).send(serializeIssueCardResponse(existingResource, existingEvent));
        }

        if (idempotentResourceId) {
          const existingResource = await dal.resources.findById(idempotentResourceId);
          if (existingResource) {
            if (!isStripeCardResourceForAgent(existingResource, agentId)) {
              return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
            }

            if (!matchesCardIssuanceConfig(existingResource, config)) {
              return reply
                .code(409)
                .send({ message: 'Idempotency key already used with different card parameters' });
            }
          }
        }
      }

      const { resource, sensitiveData, reusedExisting } = await server.resourceManager.provision(
        dal,
        agentId,
        'card',
        'stripe',
        config,
        { resourceId: idempotentResourceId },
      );

      if (reusedExisting) {
        if (!idempotency_key) {
          return reply.code(500).send({ message: 'Idempotent replay missing idempotency key' });
        }

        if (!isStripeCardResourceForAgent(resource, agentId)) {
          return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
        }

        if (!matchesCardIssuanceConfig(resource, config)) {
          return reply
            .code(409)
            .send({ message: 'Idempotency key already used with different card parameters' });
        }

        const existingEvent = await dal.events.findByIdempotencyKey(idempotency_key);
        if (existingEvent) {
          if (!isIssuedCardEventForResource(existingEvent, agentId, resource.id)) {
            return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
          }

          return reply.code(200).send(serializeIssueCardResponse(resource, existingEvent));
        }

        if (resource.state === 'provisioning') {
          const replay = await waitForIssuedCardReplay(dal, resource.id, idempotency_key);
          if (replay) {
            if (
              !isStripeCardResourceForAgent(replay.resource, agentId) ||
              !isIssuedCardEventForResource(replay.event, agentId, replay.resource.id)
            ) {
              return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
            }

            return reply.code(200).send(serializeIssueCardResponse(replay.resource, replay.event));
          }

          return reply
            .code(409)
            .send({ message: 'Card issuance already in progress for this idempotency key' });
        }

        if (resource.state !== 'active') {
          return reply
            .code(409)
            .send({ message: 'Idempotency replay found a non-active card resource' });
        }

        const recovered = await server.eventWriter.writeEvent({
          orgId,
          agentId,
          resourceId: resource.id,
          provider: 'stripe',
          eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
          idempotencyKey: idempotency_key,
          data: { card_id: resource.providerRef ?? resource.id },
        });

        if (!isIssuedCardEventForResource(recovered.event, agentId, resource.id)) {
          return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
        }

        return reply.code(200).send(serializeIssueCardResponse(resource, recovered.event));
      }

      // Log provisioned resource without sensitive fields
      request.log.info(
        { resourceId: resource.id, providerRef: resource.providerRef },
        'Card resource provisioned',
      );

      const { event } = await server.eventWriter.writeEvent({
        orgId,
        agentId,
        resourceId: resource.id,
        provider: 'stripe',
        eventType: EVENT_TYPES.PAYMENT_CARD_ISSUED,
        idempotencyKey: idempotency_key,
        data: { card_id: resource.providerRef ?? resource.id },
      });

      if (idempotency_key && !isIssuedCardEventForResource(event, agentId, resource.id)) {
        return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
      }

      // Redact before any further logging; actual values returned to caller once
      request.log.debug({ card: redactSensitive(sensitiveData ?? {}) }, 'Card details issued');

      return reply.code(200).send(serializeIssueCardResponse(resource, event, sensitiveData));
    },
  );

  done();
};

export default fp(actionsRoutes, { name: 'actions-routes' });
