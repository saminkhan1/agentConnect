import type { InferSelectModel } from 'drizzle-orm';
import type { resources } from '../db/schema.js';
import type { WriteEventInput } from '../domain/event-writer.js';

export type Resource = InferSelectModel<typeof resources>;

export type ProvisionResult = {
  providerRef: string;
  providerOrgId?: string;
  config?: Record<string, unknown>;
  /** Sensitive fields (e.g. PAN, CVC) returned to the caller once. NEVER persisted. */
  sensitiveData?: Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type DeprovisionResult = {};

export type ParsedWebhookEvent = Omit<WriteEventInput, 'orgId' | 'agentId'> & {
  resourceRef?: string; // provider_ref to find the resource
  providerOrgId?: string; // provider-side org identifier for tenant-scoped lookup
};

export interface ProviderAdapter {
  readonly providerName: string;
  provision(agentId: string, config: Record<string, unknown>): Promise<ProvisionResult>;
  deprovision(resource: Resource): Promise<DeprovisionResult>;
  performAction(
    resource: Resource,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<boolean>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<ParsedWebhookEvent[]>;
}
