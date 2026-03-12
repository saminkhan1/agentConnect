import { z } from 'zod';

import { outboundActionStateEnum, outboundActionTypeEnum } from '../db/schema';

export const OUTBOUND_ACTION_REJECTED_STATUSES = new Set([400, 403, 404, 409, 422]);

export const outboundActionTypeSchema = z.enum(outboundActionTypeEnum.enumValues);
export const outboundActionStateSchema = z.enum(outboundActionStateEnum.enumValues);

export type OutboundActionType = z.infer<typeof outboundActionTypeSchema>;
export type OutboundActionState = z.infer<typeof outboundActionStateSchema>;

export const cachedProviderErrorSchema = z.object({
  statusCode: z.number().int().min(400).max(499),
  message: z.string().min(1),
});

export type CachedProviderError = z.infer<typeof cachedProviderErrorSchema>;

export function parseCachedProviderError(value: unknown): CachedProviderError | null {
  const parsed = cachedProviderErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isOutboundActionConflict(
  action: { action: string; requestHash: string },
  expectedAction: OutboundActionType,
  expectedRequestHash: string,
) {
  if (action.action !== expectedAction) {
    return 'different_action' as const;
  }

  if (action.requestHash !== expectedRequestHash) {
    return 'different_payload' as const;
  }

  return null;
}
