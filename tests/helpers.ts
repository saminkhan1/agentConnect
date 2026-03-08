import { buildServer } from '../src/api/server';
import { DalFactory } from '../src/db/dal';
import { generateApiKeyMaterial } from '../src/domain/api-keys';

export const FIXED_TIMESTAMP = new Date('2026-03-01T00:00:00.000Z');

export type AgentRecord = {
  id: string;
  orgId: string;
  name: string;
  isArchived: boolean;
  createdAt: Date;
};

export type ResourceRecord = {
  id: string;
  orgId: string;
  agentId: string;
  type: 'email_inbox' | 'card';
  provider: string;
  providerRef: string | null;
  providerOrgId: string | null;
  config: Record<string, unknown>;
  state: 'provisioning' | 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
};

export function buildAgentRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'agt_123',
    orgId: 'org_123',
    name: 'Agent One',
    isArchived: false,
    createdAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

export async function installAuthApiKey(
  server: Awaited<ReturnType<typeof buildServer>>,
  options?: { orgId?: string; keyType?: 'root' | 'service'; isRevoked?: boolean },
) {
  const keyMaterial = await generateApiKeyMaterial();
  const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(server.systemDal);

  server.systemDal.getApiKeyById = (_id) =>
    Promise.resolve({
      id: keyMaterial.id,
      orgId: options?.orgId ?? 'org_123',
      keyType: options?.keyType ?? 'root',
      keyHash: keyMaterial.keyHash,
      isRevoked: options?.isRevoked ?? false,
      createdAt: FIXED_TIMESTAMP,
    });

  return {
    authorizationHeader: `Bearer ${keyMaterial.plaintextKey}`,
    restore: () => {
      server.systemDal.getApiKeyById = originalGetApiKeyById;
    },
  };
}

export function installAgentsDalMock(methods: {
  findById?: (id: string) => Promise<AgentRecord | null>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'agents');
  Object.defineProperty(DalFactory.prototype, 'agents', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'agents', originalDescriptor);
    }
  };
}
