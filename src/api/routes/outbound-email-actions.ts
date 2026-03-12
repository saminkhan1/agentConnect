import crypto from 'node:crypto';

import type { InferSelectModel } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  events as eventsTable,
  outboundActions as outboundActionsTable,
  resources as resourcesTable,
} from '../../db/schema';
import type { DalFactory } from '../../db/dal';
import { withTimeout } from '../../adapters/provider-client';
import { EVENT_TYPES } from '../../domain/events';
import { enforceEmailPolicy } from '../../domain/policy';
import {
  type OutboundActionType,
  isOutboundActionConflict,
  parseCachedProviderError,
} from '../../domain/outbound-actions';
import {
  replyFromAgentMailError,
  replyFromSerializedAgentMailError,
  serializeDefinitiveAgentMailError,
  serializeRetryableAgentMailError,
} from './agentmail-errors';
import { serializeEvent } from './events';

type EventRecord = InferSelectModel<typeof eventsTable>;
type OutboundActionRecord = InferSelectModel<typeof outboundActionsTable>;
type ResourceRecord = InferSelectModel<typeof resourcesTable>;
type AgentMailSendResult = {
  message_id: string;
  thread_id?: string;
};

const ADAPTER_TIMEOUT_MS = 30_000;
export const MSG_IDEMPOTENCY_DIFFERENT_ACTION =
  'Idempotency key already used for a different action';
const MSG_IDEMPOTENCY_AMBIGUOUS =
  'A previous email attempt may already have been dispatched for this idempotency key';
const MSG_OUTBOUND_ACTION_INCOMPLETE =
  'Stored outbound action is incomplete and cannot be replayed';

type EmailRecipients = {
  to: string[];
  cc?: string[];
  bcc?: string[];
};

export type PrepareInitialRequestDataResult<TRequestData> =
  | { kind: 'ok'; requestData: TRequestData }
  | { kind: 'response_sent' };

export type OutboundEmailActionConfig<
  TInput extends { idempotency_key?: string },
  TRequestData extends Record<string, unknown>,
> = {
  actionType: OutboundActionType;
  conflictMessage: string;
  dispatchFailureMessage: string;
  buildRequestHash: (resource: ResourceRecord, input: TInput) => string;
  prepareInitialRequestData: (args: {
    request: FastifyRequest;
    reply: FastifyReply;
    resource: ResourceRecord;
    input: TInput;
    adapter: NonNullable<FastifyRequest['server']['agentMailAdapter']>;
  }) =>
    | PrepareInitialRequestDataResult<TRequestData>
    | Promise<PrepareInitialRequestDataResult<TRequestData>>;
  parseStoredRequestData: (value: unknown) => TRequestData | null;
  getPolicyRecipients: (requestData: TRequestData) => EmailRecipients;
  buildAdapterPayload: (requestData: TRequestData) => Record<string, unknown>;
  buildEventData: (
    resource: ResourceRecord,
    requestData: TRequestData,
    providerResult: AgentMailSendResult,
    requestHash: string,
  ) => Record<string, unknown>;
};

export async function executeOutboundEmailAction<
  TInput extends { idempotency_key?: string },
  TRequestData extends Record<string, unknown>,
>(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  agentId: string;
  input: TInput;
  config: OutboundEmailActionConfig<TInput, TRequestData>;
}) {
  const { request, reply, agentId, input, config } = args;
  if (!request.auth) {
    return reply.code(401).send({ message: 'Unauthorized' });
  }

  const { org_id: orgId } = request.auth;
  const dal = request.dalFactory(orgId);

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

  const adapter = request.server.agentMailAdapter;
  if (!adapter) {
    return reply.code(500).send({ message: 'AgentMail adapter not configured' });
  }

  const requestHash = config.buildRequestHash(emailResource, input);
  const idempotencyKey = input.idempotency_key;

  const executeDirectAction = async () => {
    const prepared = await config.prepareInitialRequestData({
      request,
      reply,
      resource: emailResource,
      input,
      adapter,
    });
    if (prepared.kind === 'response_sent') {
      return reply;
    }

    const policyError = getEmailPolicyError(
      emailResource,
      config.getPolicyRecipients(prepared.requestData),
    );
    if (policyError) {
      return reply.code(403).send({ message: policyError });
    }

    let actionResult: Record<string, unknown>;
    try {
      actionResult = await withTimeout(
        () =>
          adapter.performAction(
            emailResource,
            config.actionType,
            config.buildAdapterPayload(prepared.requestData),
          ),
        ADAPTER_TIMEOUT_MS,
      );
    } catch (error) {
      if (replyFromAgentMailError(reply, error, config.dispatchFailureMessage)) {
        return reply;
      }

      throw error;
    }

    const providerResult = parseAgentMailSendResult(actionResult);
    if (!providerResult) {
      throw new Error(MSG_OUTBOUND_ACTION_INCOMPLETE);
    }

    const { event } = await request.server.eventWriter.writeEvent({
      orgId,
      agentId,
      resourceId: emailResource.id,
      provider: 'agentmail',
      eventType: EVENT_TYPES.EMAIL_SENT,
      data: config.buildEventData(emailResource, prepared.requestData, providerResult, requestHash),
    });

    return reply.code(200).send({ event: serializeEvent(event) });
  };

  const executeIdempotentAction = async () => {
    if (!idempotencyKey) {
      throw new Error('Missing idempotency key');
    }

    const stableIdempotencyKey = idempotencyKey;
    let actionRow = await dal.outboundActions.findByIdempotencyKey(stableIdempotencyKey);
    if (actionRow) {
      if (!isOutboundActionForResource(actionRow, agentId, emailResource)) {
        return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
      }

      const conflict = isOutboundActionConflict(actionRow, config.actionType, requestHash);
      if (conflict === 'different_action') {
        return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
      }

      if (conflict === 'different_payload') {
        return reply.code(409).send({ message: config.conflictMessage });
      }
    }

    const hadExistingAction = actionRow !== null;
    if (!actionRow) {
      const prepared = await config.prepareInitialRequestData({
        request,
        reply,
        resource: emailResource,
        input,
        adapter,
      });
      if (prepared.kind === 'response_sent') {
        return reply;
      }

      const policyError = getEmailPolicyError(
        emailResource,
        config.getPolicyRecipients(prepared.requestData),
      );
      if (policyError) {
        return reply.code(403).send({ message: policyError });
      }

      actionRow = await dal.outboundActions.createReady({
        id: crypto.randomUUID(),
        agentId,
        resourceId: emailResource.id,
        provider: 'agentmail',
        action: config.actionType,
        idempotencyKey: stableIdempotencyKey,
        requestHash,
        requestData: prepared.requestData,
      });
    }

    const durableAction = actionRow;
    const dispatchRequestData = config.parseStoredRequestData(durableAction.requestData);
    if (!dispatchRequestData) {
      return reply.code(500).send({ message: MSG_OUTBOUND_ACTION_INCOMPLETE });
    }

    if (durableAction.state === 'rejected') {
      const cachedError = parseCachedProviderError(durableAction.lastError);
      if (!cachedError) {
        return reply.code(500).send({ message: MSG_OUTBOUND_ACTION_INCOMPLETE });
      }

      replyFromSerializedAgentMailError(reply, cachedError);
      return reply;
    }

    if (durableAction.state === 'completed' || durableAction.state === 'provider_succeeded') {
      return recoverFromStoredProviderResult({
        request,
        reply,
        dal,
        action: durableAction,
        orgId,
        agentId,
        resource: emailResource,
        idempotencyKey: stableIdempotencyKey,
        requestData: dispatchRequestData,
        buildEventData: config.buildEventData,
      });
    }

    if (durableAction.state === 'dispatching' || durableAction.state === 'ambiguous') {
      return reply.code(409).send({ message: MSG_IDEMPOTENCY_AMBIGUOUS });
    }

    if (hadExistingAction) {
      const policyError = getEmailPolicyError(
        emailResource,
        config.getPolicyRecipients(dispatchRequestData),
      );
      if (policyError) {
        return reply.code(403).send({ message: policyError });
      }
    }

    const dispatchingAction = await dal.outboundActions.transitionState(
      durableAction.id,
      'dispatching',
      { lastError: null },
    );
    if (!dispatchingAction) {
      return reply.code(500).send({ message: 'Unable to update outbound action state' });
    }

    let providerResponse: Record<string, unknown>;
    try {
      providerResponse = await withTimeout(
        () =>
          adapter.performAction(
            emailResource,
            config.actionType,
            config.buildAdapterPayload(dispatchRequestData),
          ),
        ADAPTER_TIMEOUT_MS,
      );
    } catch (error) {
      const definitiveError = serializeDefinitiveAgentMailError(
        error,
        config.dispatchFailureMessage,
      );
      if (definitiveError) {
        await dal.outboundActions
          .transitionState(actionRow.id, 'rejected', { lastError: definitiveError })
          .catch((err: unknown) => {
            request.log.warn({ err }, 'Failed to transition action state');
          });
        replyFromSerializedAgentMailError(reply, definitiveError);
        return reply;
      }

      const retryableError = serializeRetryableAgentMailError(error, config.dispatchFailureMessage);
      if (retryableError) {
        await dal.outboundActions
          .transitionState(actionRow.id, 'ready', { lastError: retryableError })
          .catch((err: unknown) => {
            request.log.warn({ err }, 'Failed to transition action state');
          });
        replyFromSerializedAgentMailError(reply, retryableError);
        return reply;
      }

      await dal.outboundActions
        .transitionState(actionRow.id, 'ambiguous', {
          lastError: serializeProviderFailure(error),
        })
        .catch((err: unknown) => {
          request.log.warn({ err }, 'Failed to transition action state');
        });
      throw error;
    }

    const providerResult = parseAgentMailSendResult(providerResponse);
    if (!providerResult) {
      await dal.outboundActions
        .transitionState(actionRow.id, 'ambiguous', {
          lastError: { message: MSG_OUTBOUND_ACTION_INCOMPLETE },
        })
        .catch((err: unknown) => {
          request.log.warn({ err }, 'Failed to transition action state');
        });
      throw new Error(MSG_OUTBOUND_ACTION_INCOMPLETE);
    }

    const providerSucceededAction = await dal.outboundActions.transitionState(
      actionRow.id,
      'provider_succeeded',
      { providerResult },
    );
    if (!providerSucceededAction) {
      return reply.code(500).send({ message: 'Unable to persist outbound action result' });
    }
    actionRow = providerSucceededAction;

    const { event } = await request.server.eventWriter.writeEvent({
      orgId,
      agentId,
      resourceId: emailResource.id,
      provider: 'agentmail',
      eventType: EVENT_TYPES.EMAIL_SENT,
      idempotencyKey: stableIdempotencyKey,
      data: config.buildEventData(emailResource, dispatchRequestData, providerResult, requestHash),
    });

    await dal.outboundActions
      .transitionState(actionRow.id, 'completed', { eventId: event.id })
      .catch((err: unknown) => {
        request.log.warn({ err }, 'Failed to transition action state');
      });

    return reply.code(200).send({ event: serializeEvent(event) });
  };

  if (!idempotencyKey) {
    return executeDirectAction();
  }

  return request.server.withAdvisoryLock(
    buildActionIdempotencyLockKey(orgId, idempotencyKey),
    executeIdempotentAction,
  );
}

function buildActionIdempotencyLockKey(orgId: string, idempotencyKey: string) {
  return `actions:${orgId}:idempotency:${idempotencyKey}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseAgentMailSendResult(value: unknown): AgentMailSendResult | null {
  if (!isObjectRecord(value) || typeof value['message_id'] !== 'string') {
    return null;
  }

  return {
    message_id: value['message_id'],
    ...(typeof value['thread_id'] === 'string' ? { thread_id: value['thread_id'] } : {}),
  };
}

function isSentEmailEventForResource(event: EventRecord, agentId: string, resourceId: string) {
  return (
    event.eventType === EVENT_TYPES.EMAIL_SENT &&
    event.agentId === agentId &&
    event.resourceId === resourceId
  );
}

function isOutboundActionForResource(
  action: OutboundActionRecord,
  agentId: string,
  resource: ResourceRecord,
) {
  return (
    action.agentId === agentId &&
    action.resourceId === resource.id &&
    action.provider === resource.provider
  );
}

function getEmailPolicyError(resource: ResourceRecord, recipients: EmailRecipients) {
  const policyResult = enforceEmailPolicy(resource.config, recipients);
  return policyResult.allowed ? null : policyResult.reasons.join('; ');
}

function serializeProviderFailure(error: unknown) {
  if (!isObjectRecord(error)) {
    return null;
  }

  const message = typeof error['message'] === 'string' ? error['message'] : null;
  return {
    ...(message ? { message } : {}),
    ...(typeof error['name'] === 'string' ? { name: error['name'] } : {}),
  };
}

async function resolveCompletedActionEvent(
  dal: DalFactory,
  action: OutboundActionRecord,
  options: {
    isExpectedEvent: (event: EventRecord) => boolean;
    recover: () => Promise<EventRecord>;
  },
) {
  if (action.eventId) {
    const storedEvent = await dal.events.findById(action.eventId);
    if (storedEvent) {
      return options.isExpectedEvent(storedEvent)
        ? ({ kind: 'event', event: storedEvent } as const)
        : ({ kind: 'conflict' } as const);
    }
  }

  const fallbackEvent = await dal.events.findByIdempotencyKey(action.idempotencyKey);
  if (fallbackEvent) {
    return options.isExpectedEvent(fallbackEvent)
      ? ({ kind: 'event', event: fallbackEvent } as const)
      : ({ kind: 'conflict' } as const);
  }

  const recoveredEvent = await options.recover();
  return options.isExpectedEvent(recoveredEvent)
    ? ({ kind: 'event', event: recoveredEvent } as const)
    : ({ kind: 'conflict' } as const);
}

async function recoverFromStoredProviderResult<TRequestData extends Record<string, unknown>>(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  dal: DalFactory;
  action: OutboundActionRecord;
  orgId: string;
  agentId: string;
  resource: ResourceRecord;
  idempotencyKey: string;
  requestData: TRequestData;
  buildEventData: (
    resource: ResourceRecord,
    requestData: TRequestData,
    providerResult: AgentMailSendResult,
    requestHash: string,
  ) => Record<string, unknown>;
}) {
  const { request, reply, dal, action, orgId, agentId, resource, idempotencyKey, requestData } =
    args;
  const providerResult = parseAgentMailSendResult(action.providerResult);
  if (!providerResult) {
    return reply.code(500).send({ message: MSG_OUTBOUND_ACTION_INCOMPLETE });
  }

  const resolvedEvent = await resolveCompletedActionEvent(dal, action, {
    isExpectedEvent: (event) => isSentEmailEventForResource(event, agentId, resource.id),
    recover: async () => {
      const { event: recoveredEvent } = await request.server.eventWriter.writeEvent({
        orgId,
        agentId,
        resourceId: resource.id,
        provider: 'agentmail',
        eventType: EVENT_TYPES.EMAIL_SENT,
        idempotencyKey,
        data: args.buildEventData(resource, requestData, providerResult, action.requestHash),
      });

      await dal.outboundActions
        .transitionState(action.id, 'completed', { eventId: recoveredEvent.id })
        .catch((err: unknown) => {
          request.log.warn({ err }, 'Failed to transition action state');
        });

      return recoveredEvent;
    },
  });
  if (resolvedEvent.kind === 'conflict') {
    return reply.code(409).send({ message: MSG_IDEMPOTENCY_DIFFERENT_ACTION });
  }
  const event = resolvedEvent.event;

  if (action.state !== 'completed') {
    await dal.outboundActions
      .transitionState(action.id, 'completed', { eventId: event.id })
      .catch((err: unknown) => {
        request.log.warn({ err }, 'Failed to transition action state');
      });
  }

  return reply.code(200).send({ event: serializeEvent(event) });
}
