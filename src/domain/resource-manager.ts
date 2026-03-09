import crypto from 'node:crypto';

import type { ProviderAdapter, ProvisionResult, Resource } from '../adapters/provider-adapter';
import type { DalFactory } from '../db/dal';
import { AppError } from './errors';
import { resourceConfigSchema } from './policy';

type ProvisionOptions = {
  resourceId?: string;
};

type ProvisionOutcome = {
  resource: Resource;
  sensitiveData?: Record<string, unknown>;
  reusedExisting?: boolean;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

async function cleanupProvisionedResource(
  adapter: ProviderAdapter,
  resource: Resource,
  result: ProvisionResult,
  config: Record<string, unknown>,
): Promise<void> {
  await adapter
    .deprovision({
      ...resource,
      providerRef: result.providerRef,
      providerOrgId: result.providerOrgId ?? null,
      config,
      state: 'active',
    })
    .catch(() => {});
}

export class ResourceManager {
  constructor(private readonly adapters: Map<string, ProviderAdapter>) {}

  private getAdapter(provider: string): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new AppError('ADAPTER_NOT_FOUND', 404, `No adapter for provider: ${provider}`);
    }
    return adapter;
  }

  async provision(
    dal: DalFactory,
    agentId: string,
    type: 'email_inbox' | 'card',
    provider: string,
    config: Record<string, unknown>,
    options?: ProvisionOptions,
  ): Promise<ProvisionOutcome> {
    const adapter = this.getAdapter(provider);
    const id = options?.resourceId ?? `res_${crypto.randomUUID()}`;
    let provisioningResource: Resource;

    const existing = options?.resourceId ? await dal.resources.findById(id) : null;
    if (existing) {
      if (existing.state !== 'deleted') {
        return { resource: existing, reusedExisting: true };
      }

      const reset = await dal.resources.updateById(id, {
        providerRef: null,
        providerOrgId: null,
        config,
        state: 'provisioning',
      });
      if (!reset) {
        throw new AppError('INTERNAL', 500, 'Failed to reset idempotent resource state');
      }
      provisioningResource = reset;
    } else {
      try {
        provisioningResource = await dal.resources.insert({
          id,
          agentId,
          type,
          provider,
          config,
          state: 'provisioning',
        });
      } catch (err) {
        if (options?.resourceId && isUniqueViolation(err)) {
          const duplicated = await dal.resources.findById(id);
          if (duplicated) {
            return { resource: duplicated, reusedExisting: true };
          }
        }
        throw err;
      }
    }

    let result: ProvisionResult;
    try {
      result = await adapter.provision(agentId, config);
    } catch (err) {
      await dal.resources.updateById(id, { state: 'deleted' });
      throw err;
    }

    // Adapter output takes precedence over user config for provider-managed fields
    const mergedConfig = { ...config, ...(result.config ?? {}) };
    const parsedConfig = resourceConfigSchema.safeParse(mergedConfig);
    if (!parsedConfig.success) {
      await cleanupProvisionedResource(adapter, provisioningResource, result, mergedConfig);
      await dal.resources.updateById(id, { state: 'deleted' }).catch(() => {});
      throw new AppError(
        'INTERNAL',
        500,
        `Adapter '${provider}' returned invalid config: ${parsedConfig.error.message}`,
      );
    }

    let updated: Resource | null;
    try {
      updated = await dal.resources.updateById(id, {
        providerRef: result.providerRef,
        providerOrgId: result.providerOrgId,
        config: parsedConfig.data,
        state: 'active',
      });
    } catch (updateErr) {
      await cleanupProvisionedResource(adapter, provisioningResource, result, parsedConfig.data);
      await dal.resources.updateById(id, { state: 'deleted' }).catch(() => {});
      throw updateErr;
    }

    if (!updated) {
      await cleanupProvisionedResource(adapter, provisioningResource, result, parsedConfig.data);
      await dal.resources.updateById(id, { state: 'deleted' }).catch(() => {});
      throw new AppError('INTERNAL', 500, 'Resource update failed unexpectedly');
    }
    return { resource: updated, sensitiveData: result.sensitiveData };
  }

  async deprovision(dal: DalFactory, resourceId: string, agentId: string): Promise<Resource> {
    const resource = await dal.resources.findById(resourceId);
    if (!resource || resource.state === 'deleted' || resource.agentId !== agentId) {
      throw new AppError('NOT_FOUND', 404, 'Resource not found');
    }

    const adapter = this.getAdapter(resource.provider);
    await adapter.deprovision(resource);

    const updated = await dal.resources.updateById(resourceId, { state: 'deleted' });
    if (!updated) throw new AppError('INTERNAL', 500, 'Resource update failed unexpectedly');
    return updated;
  }
}
