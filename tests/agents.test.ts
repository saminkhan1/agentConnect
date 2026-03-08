import assert from 'node:assert';
import test from 'node:test';
import { z } from 'zod';

import { buildServer } from '../src/api/server';
import { DalFactory } from '../src/db/dal';
import { AgentRecord, buildAgentRecord, installAuthApiKey } from './helpers';

const errorResponseSchema = z.object({
  message: z.string(),
});

const agentResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  isArchived: z.boolean(),
  createdAt: z.iso.datetime(),
});

const singleAgentResponseSchema = z.object({
  agent: agentResponseSchema,
});

const listAgentsResponseSchema = z.object({
  agents: z.array(agentResponseSchema),
});

function installAgentsDalMock(methods: {
  insert?: (data: unknown) => Promise<AgentRecord>;
  findMany?: (options?: { includeArchived?: boolean }) => Promise<AgentRecord[]>;
  findById?: (id: string) => Promise<AgentRecord | null>;
  updateById?: (
    id: string,
    data: Partial<Pick<AgentRecord, 'name' | 'isArchived'>>,
  ) => Promise<AgentRecord | null>;
  archiveById?: (id: string) => Promise<AgentRecord | null>;
}) {
  const originalAgentsDescriptor = Object.getOwnPropertyDescriptor(DalFactory.prototype, 'agents');
  Object.defineProperty(DalFactory.prototype, 'agents', {
    configurable: true,
    get() {
      return methods;
    },
  });

  return () => {
    if (originalAgentsDescriptor) {
      Object.defineProperty(DalFactory.prototype, 'agents', originalAgentsDescriptor);
    }
  };
}

void test('GET /agents returns 401 when API key is revoked', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server, {
    isRevoked: true,
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(response.statusCode, 401);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = errorResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.message, 'Unauthorized');
  } finally {
    restore();
    await server.close();
  }
});

void test('POST /agents creates an agent with agt_ id prefix', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);

  const capturedInserts: Array<{ id: string; name: string }> = [];
  const restoreAgentsDal = installAgentsDalMock({
    insert: (data) => {
      const parsedData = z
        .object({
          id: z.string(),
          name: z.string(),
        })
        .parse(data);
      capturedInserts.push(parsedData);
      return Promise.resolve(
        buildAgentRecord({
          id: parsedData.id,
          name: parsedData.name,
        }),
      );
    },
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: {
        authorization: authorizationHeader,
      },
      payload: {
        name: '  Agent Alpha  ',
      },
    });

    assert.strictEqual(response.statusCode, 201);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = singleAgentResponseSchema.parse(rawPayload);
    assert.match(payload.agent.id, /^agt_/);
    assert.strictEqual(payload.agent.name, 'Agent Alpha');

    assert.strictEqual(capturedInserts.length, 1);
    assert.match(capturedInserts[0].id, /^agt_/);
    assert.strictEqual(capturedInserts[0].name, 'Agent Alpha');
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('GET /agents excludes archived by default and includes with includeArchived=true', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);

  const capturedOptions: Array<{ includeArchived?: boolean } | undefined> = [];
  const activeAgent = buildAgentRecord({ id: 'agt_active', isArchived: false });
  const archivedAgent = buildAgentRecord({ id: 'agt_archived', isArchived: true });
  const restoreAgentsDal = installAgentsDalMock({
    findMany: (options) => {
      capturedOptions.push(options);
      if (options?.includeArchived) {
        return Promise.resolve([activeAgent, archivedAgent]);
      }
      return Promise.resolve([activeAgent]);
    },
  });

  try {
    const defaultListResponse = await server.inject({
      method: 'GET',
      url: '/agents',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(defaultListResponse.statusCode, 200);
    const defaultListPayload = listAgentsResponseSchema.parse(
      JSON.parse(defaultListResponse.payload),
    );
    assert.strictEqual(defaultListPayload.agents.length, 1);
    assert.strictEqual(defaultListPayload.agents[0].id, 'agt_active');

    const includeArchivedResponse = await server.inject({
      method: 'GET',
      url: '/agents?includeArchived=true',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(includeArchivedResponse.statusCode, 200);
    const includeArchivedPayload = listAgentsResponseSchema.parse(
      JSON.parse(includeArchivedResponse.payload),
    );
    assert.strictEqual(includeArchivedPayload.agents.length, 2);
    assert.strictEqual(includeArchivedPayload.agents[1].id, 'agt_archived');

    assert.strictEqual(capturedOptions.length, 2);
    assert.deepStrictEqual(capturedOptions[0], { includeArchived: false });
    assert.deepStrictEqual(capturedOptions[1], { includeArchived: true });
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('GET /agents/:id returns archived agents', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const archivedAgent = buildAgentRecord({
    id: 'agt_archived',
    isArchived: true,
  });
  const restoreAgentsDal = installAgentsDalMock({
    findById: (_id) => Promise.resolve(archivedAgent),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_archived',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(response.statusCode, 200);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = singleAgentResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.agent.id, 'agt_archived');
    assert.strictEqual(payload.agent.isArchived, true);
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('GET /agents/:id returns 404 for a cross-org lookup', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server, { orgId: 'org_123' });
  const restoreAgentsDal = installAgentsDalMock({
    findById: (_id) => Promise.resolve(null),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_other_org',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(response.statusCode, 404);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = errorResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.message, 'Agent not found');
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('PATCH /agents/:id updates name and isArchived', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const capturedUpdates: Array<{
    id: string;
    data: Partial<Pick<AgentRecord, 'name' | 'isArchived'>>;
  }> = [];
  const restoreAgentsDal = installAgentsDalMock({
    updateById: (id, data) => {
      capturedUpdates.push({ id, data });
      return Promise.resolve(
        buildAgentRecord({
          id,
          name: data.name ?? 'Agent One',
          isArchived: data.isArchived ?? false,
        }),
      );
    },
  });

  try {
    const response = await server.inject({
      method: 'PATCH',
      url: '/agents/agt_patch',
      headers: {
        authorization: authorizationHeader,
      },
      payload: {
        name: 'Agent Updated',
        isArchived: true,
      },
    });

    assert.strictEqual(response.statusCode, 200);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = singleAgentResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.agent.id, 'agt_patch');
    assert.strictEqual(payload.agent.name, 'Agent Updated');
    assert.strictEqual(payload.agent.isArchived, true);

    assert.strictEqual(capturedUpdates.length, 1);
    assert.deepStrictEqual(capturedUpdates[0], {
      id: 'agt_patch',
      data: {
        name: 'Agent Updated',
        isArchived: true,
      },
    });
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('PATCH /agents/:id returns 400 when body is empty', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const restoreAgentsDal = installAgentsDalMock({
    updateById: (_id, _data) => Promise.resolve(null),
  });

  try {
    const response = await server.inject({
      method: 'PATCH',
      url: '/agents/agt_patch',
      headers: {
        authorization: authorizationHeader,
      },
      payload: {},
    });

    assert.strictEqual(response.statusCode, 400);
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});

void test('DELETE /agents/:id soft-archives and returns wrapped agent', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const restoreAgentsDal = installAgentsDalMock({
    archiveById: (id) =>
      Promise.resolve(
        buildAgentRecord({
          id,
          isArchived: true,
        }),
      ),
  });

  try {
    const response = await server.inject({
      method: 'DELETE',
      url: '/agents/agt_delete',
      headers: {
        authorization: authorizationHeader,
      },
    });

    assert.strictEqual(response.statusCode, 200);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = singleAgentResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.agent.id, 'agt_delete');
    assert.strictEqual(payload.agent.isArchived, true);
  } finally {
    restore();
    restoreAgentsDal();
    await server.close();
  }
});
