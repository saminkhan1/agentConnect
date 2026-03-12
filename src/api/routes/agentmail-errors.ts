import { AgentMailError } from 'agentmail';
import type { FastifyReply } from 'fastify';

import { OUTBOUND_ACTION_REJECTED_STATUSES } from '../../domain/outbound-actions';

type SerializedAgentMailError = {
  statusCode: number;
  message: string;
};

function extractAgentMailErrorMessage(error: AgentMailError, fallbackMessage: string) {
  const body =
    typeof error.body === 'object' && error.body !== null
      ? (error.body as Record<string, unknown>)
      : null;

  const candidates = [body?.['message'], body?.['error'], body?.['detail']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return fallbackMessage;
}

function serializeClientAgentMailError(
  error: unknown,
  fallbackMessage: string,
): SerializedAgentMailError | null {
  if (!(error instanceof AgentMailError)) {
    return null;
  }

  const message = extractAgentMailErrorMessage(error, fallbackMessage);
  const statusCode = error.statusCode;
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return { statusCode, message };
  }

  return null;
}

export function replyFromAgentMailError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string,
) {
  const serialized = serializeClientAgentMailError(error, fallbackMessage);
  if (!serialized) {
    return false;
  }

  reply.code(serialized.statusCode).send({ message: serialized.message });
  return true;
}

export function serializeDefinitiveAgentMailError(error: unknown, fallbackMessage: string) {
  const serialized = serializeClientAgentMailError(error, fallbackMessage);
  if (!serialized || !OUTBOUND_ACTION_REJECTED_STATUSES.has(serialized.statusCode)) {
    return null;
  }

  return serialized;
}

export function serializeRetryableAgentMailError(error: unknown, fallbackMessage: string) {
  const serialized = serializeClientAgentMailError(error, fallbackMessage);
  if (!serialized || OUTBOUND_ACTION_REJECTED_STATUSES.has(serialized.statusCode)) {
    return null;
  }

  return serialized;
}

export function replyFromSerializedAgentMailError(
  reply: FastifyReply,
  error: { statusCode: number; message: string },
) {
  reply.code(error.statusCode).send({ message: error.message });
}
