import crypto from 'node:crypto';

import type { ProviderAdapter, ProvisionResult, Resource } from '../adapters/provider-adapter';
import type { DalFactory } from '../db/dal';
import { AppError } from './errors';
import { resourceConfigSchema } from './policy';

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
  ): Promise<Resource> {
    const adapter = this.getAdapter(provider);
    const id = `res_${crypto.randomUUID()}`;

    await dal.resources.insert({
      id,
      agentId,
      type,
      provider,
      config,
      state: 'provisioning',
    });

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
      throw new AppError(
        'INTERNAL',
        500,
        `Adapter '${provider}' returned invalid config: ${parsedConfig.error.message}`,
      );
    }
    const updated = await dal.resources.updateById(id, {
      providerRef: result.providerRef,
      config: parsedConfig.data,
      state: 'active',
    });
    if (!updated) throw new AppError('INTERNAL', 500, 'Resource update failed unexpectedly');
    return updated;
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
