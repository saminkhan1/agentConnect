import { z } from 'zod';

import { resourceStateEnum, resourceTypeEnum } from '../../db/schema';
import { resourceConfigSchema } from '../../domain/policy';

export const createResourceBodySchema = z.object({
  type: z.enum(resourceTypeEnum.enumValues),
  provider: z.string().min(1),
  config: resourceConfigSchema.optional().default({}),
});

export const resourceParamsSchema = z.object({ id: z.string().min(1) });

export const resourceIdParamsSchema = z.object({
  id: z.string().min(1),
  rid: z.string().min(1),
});

export const resourceResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string(),
  type: z.enum(resourceTypeEnum.enumValues),
  provider: z.string(),
  providerRef: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  state: z.enum(resourceStateEnum.enumValues),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createResourceResponseSchema = z.object({
  resource: resourceResponseSchema,
});

export const listResourcesResponseSchema = z.object({
  resources: z.array(resourceResponseSchema),
});
