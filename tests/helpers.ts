import type { AgentMailAdapter } from '../src/adapters/agentmail-adapter';
import { buildServer } from '../src/api/server';
import type { StripeAdapter } from '../src/adapters/stripe-adapter';
import { DalFactory } from '../src/db/dal';
import { generateApiKeyMaterial } from '../src/domain/api-keys';
import type { EventWriter } from '../src/domain/event-writer';
import { EVENT_TYPES, type EventType } from '../src/domain/events';
import type { ResourceManager } from '../src/domain/resource-manager';
import type { TimelineItem } from '../src/domain/timeline';

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

export function buildResourceRecord(overrides?: Partial<ResourceRecord>): ResourceRecord {
  return {
    id: 'res_123',
    orgId: 'org_123',
    agentId: 'agt_123',
    type: 'email_inbox',
    provider: 'agentmail',
    providerRef: 'agent@agentmail.to',
    providerOrgId: 'pod_test',
    config: {},
    state: 'active',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

export function buildCardResourceRecord(overrides?: Partial<ResourceRecord>): ResourceRecord {
  return {
    id: 'res_card_123',
    orgId: 'org_123',
    agentId: 'agt_123',
    type: 'card',
    provider: 'stripe',
    providerRef: 'ic_test123',
    providerOrgId: null,
    config: { cardholder_id: 'ich_test', last4: '4242', exp_month: 12, exp_year: 2027 },
    state: 'active',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

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

export function installAdvisoryLockMock(server: Awaited<ReturnType<typeof buildServer>>) {
  const original = server.withAdvisoryLock.bind(server);
  const pendingLocks = new Map<string, { tail: Promise<void>; waiters: number }>();

  server.withAdvisoryLock = async <T>(lockKey: string, callback: () => Promise<T>) => {
    const state = pendingLocks.get(lockKey) ?? { tail: Promise.resolve(), waiters: 0 };
    state.waiters += 1;

    const previous = state.tail;
    let release = () => {};
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    pendingLocks.set(lockKey, state);

    await previous;

    try {
      return await callback();
    } finally {
      release();
      state.waiters -= 1;
      if (state.waiters === 0) {
        pendingLocks.delete(lockKey);
      }
    }
  };

  return () => {
    server.withAdvisoryLock = original;
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

export function installResourcesDalMock(methods: {
  findActiveByAgentIdAndType?: (
    agentId: string,
    type: string,
    provider: string,
  ) => Promise<ResourceRecord | null>;
  findById?: (id: string) => Promise<ResourceRecord | null>;
  findByAgentId?: (agentId: string) => Promise<ResourceRecord[]>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'resources');
  Object.defineProperty(DalFactory.prototype, 'resources', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'resources', originalDescriptor);
    }
  };
}

export type EventRecord = {
  id: string;
  orgId: string;
  agentId: string;
  resourceId: string | null;
  provider: string;
  providerEventId: string | null;
  eventType: EventType;
  occurredAt: Date;
  idempotencyKey: string | null;
  data: Record<string, unknown>;
  ingestedAt: Date;
};

export function buildEventRecord(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org_123',
    agentId: 'agt_123',
    resourceId: null,
    provider: 'agentmail',
    providerEventId: 'evt_provider_1',
    eventType: EVENT_TYPES.EMAIL_DELIVERED,
    occurredAt: FIXED_TIMESTAMP,
    idempotencyKey: null,
    data: { message_id: 'msg_1', thread_id: 'thread_1' },
    ingestedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

export function installEventsDalMock(methods: {
  listByAgent?: (
    agentId: string,
    options: {
      eventType?: EventType;
      since?: Date;
      until?: Date;
      cursor?: { occurredAt: Date; id: string };
      limit: number;
    },
  ) => Promise<EventRecord[]>;
  listTimelineByAgent?: (
    agentId: string,
    options: {
      since?: Date;
      until?: Date;
      cursor?: { occurredAt: Date; id: string };
      limit: number;
    },
  ) => Promise<TimelineItem[]>;
  findById?: (id: string) => Promise<EventRecord | null>;
  findByIdempotencyKey?: (key: string) => Promise<EventRecord | null>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'events');
  Object.defineProperty(DalFactory.prototype, 'events', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'events', originalDescriptor);
    }
  };
}

export function installAgentMailAdapterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<AgentMailAdapter>,
) {
  const original = server.agentMailAdapter;
  server.agentMailAdapter = methods as AgentMailAdapter;
  return () => {
    server.agentMailAdapter = original;
  };
}

export function installEventWriterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<EventWriter>,
) {
  const originalWriter = server.eventWriter;
  const originalWebhookProcessor = server.webhookProcessor;
  server.eventWriter = methods as EventWriter;
  server.webhookProcessor = new (server.webhookProcessor.constructor as new (
    ew: EventWriter,
  ) => typeof server.webhookProcessor)(server.eventWriter);
  return () => {
    server.eventWriter = originalWriter;
    server.webhookProcessor = originalWebhookProcessor;
  };
}

export function installStripeAdapterMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<StripeAdapter>,
) {
  const original = server.stripeAdapter;
  server.stripeAdapter = methods as StripeAdapter;
  return () => {
    server.stripeAdapter = original;
  };
}

export function installResourceManagerMock(
  server: Awaited<ReturnType<typeof buildServer>>,
  methods: Partial<ResourceManager>,
) {
  const original = server.resourceManager;
  server.resourceManager = methods as ResourceManager;
  return () => {
    server.resourceManager = original;
  };
}

export type OutboundActionType = 'send_email' | 'reply_email';
export type OutboundActionState =
  | 'ready'
  | 'dispatching'
  | 'rejected'
  | 'provider_succeeded'
  | 'completed'
  | 'ambiguous';

export type OutboundActionRecord = {
  id: string;
  orgId: string;
  agentId: string;
  resourceId: string;
  provider: string;
  action: OutboundActionType;
  idempotencyKey: string;
  requestHash: string;
  requestData: Record<string, unknown>;
  providerResult: Record<string, unknown> | null;
  eventId: string | null;
  lastError: Record<string, unknown> | null;
  state: OutboundActionState;
  createdAt: Date;
  updatedAt: Date;
};

export type OutboundActionCreateReadyInput = {
  id: string;
  agentId: string;
  resourceId: string;
  provider: string;
  action: OutboundActionType;
  idempotencyKey: string;
  requestHash: string;
  requestData: Record<string, unknown>;
};

export type OutboundActionTransitionUpdates = {
  requestData?: Record<string, unknown>;
  providerResult?: Record<string, unknown> | null;
  eventId?: string | null;
  lastError?: Record<string, unknown> | null;
};

export function buildOutboundActionRecord(
  overrides?: Partial<OutboundActionRecord>,
): OutboundActionRecord {
  return {
    id: 'oa_123',
    orgId: 'org_123',
    agentId: 'agt_123',
    resourceId: 'res_123',
    provider: 'agentmail',
    action: 'send_email',
    idempotencyKey: 'idem_123',
    requestHash: 'request-hash-123',
    requestData: {},
    providerResult: null,
    eventId: null,
    lastError: null,
    state: 'ready',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

export function installOutboundActionsDalMock(methods: {
  findByIdempotencyKey?: (key: string) => Promise<OutboundActionRecord | null>;
  createReady?: (input: OutboundActionCreateReadyInput) => Promise<OutboundActionRecord>;
  transitionState?: (
    id: string,
    state: OutboundActionState,
    updates?: OutboundActionTransitionUpdates,
  ) => Promise<OutboundActionRecord | null>;
}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    DalFactory.prototype,
    'outboundActions',
  );
  Object.defineProperty(DalFactory.prototype, 'outboundActions', {
    configurable: true,
    get() {
      return methods;
    },
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'outboundActions', originalDescriptor);
    }
  };
}

export function createMemoryOutboundActionsDal(options?: {
  initialAction?: OutboundActionRecord | null;
  onFindByIdempotencyKey?: (key: string) => void | Promise<void>;
  onCreateReady?: (input: OutboundActionCreateReadyInput) => void | Promise<void>;
  onTransitionState?: (
    action: OutboundActionRecord,
    state: OutboundActionState,
    updates?: OutboundActionTransitionUpdates,
  ) => void | Promise<void>;
}) {
  let currentAction = options?.initialAction ?? null;

  return {
    getCurrentAction() {
      return currentAction;
    },
    setCurrentAction(action: OutboundActionRecord | null) {
      currentAction = action;
    },
    methods: {
      findByIdempotencyKey: async (key: string) => {
        await options?.onFindByIdempotencyKey?.(key);
        return currentAction;
      },
      createReady: async (input: OutboundActionCreateReadyInput) => {
        await options?.onCreateReady?.(input);
        currentAction = buildOutboundActionRecord({
          id: input.id,
          agentId: input.agentId,
          resourceId: input.resourceId,
          provider: input.provider,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          requestData: input.requestData,
        });
        return currentAction;
      },
      transitionState: async (
        id: string,
        state: OutboundActionState,
        updates?: OutboundActionTransitionUpdates,
      ) => {
        if (!currentAction || currentAction.id !== id) {
          return null;
        }

        await options?.onTransitionState?.(currentAction, state, updates);

        currentAction = {
          ...currentAction,
          state,
          requestData: updates?.requestData ?? currentAction.requestData,
          providerResult: updates?.providerResult ?? currentAction.providerResult,
          eventId: updates?.eventId ?? currentAction.eventId,
          lastError: updates?.lastError ?? currentAction.lastError,
          updatedAt: new Date(),
        };
        return currentAction;
      },
    },
  };
}
