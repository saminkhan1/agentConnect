import assert from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { buildServer } from '../src/api/server';
import { db } from '../src/db';
import { agents, apiKeys, orgs, resources } from '../src/db/schema';
import { generateApiKeyMaterial } from '../src/domain/api-keys';

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(resources).where(eq(resources.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
}

void test('integration: provision resource → DB state=active, providerRef stored', async () => {
  const server = await buildServer();
  const orgId = `org_res_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: { id: orgId, name: 'Resource Integration Org' },
      apiKey: { id: rootKey.id, keyType: 'root', keyHash: rootKey.keyHash },
    });

    const createAgentResponse = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization },
      payload: { name: 'Resource Agent' },
    });
    assert.strictEqual(createAgentResponse.statusCode, 201);
    const agentId = (JSON.parse(createAgentResponse.payload) as { agent: { id: string } }).agent.id;

    const provisionResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/resources`,
      headers: { authorization },
      payload: { type: 'email_inbox', provider: 'mock' },
    });
    assert.strictEqual(provisionResponse.statusCode, 201);
    const provisionPayload = JSON.parse(provisionResponse.payload) as {
      resource: { id: string; state: string; providerRef: string };
    };
    assert.strictEqual(provisionPayload.resource.state, 'active');
    assert.ok(provisionPayload.resource.providerRef);

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedResources[0].state, 'active');
    assert.ok(storedResources[0].providerRef);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: get resources list scoped to org', async () => {
  const server = await buildServer();
  const orgId = `org_res_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: { id: orgId, name: 'Resource List Org' },
      apiKey: { id: rootKey.id, keyType: 'root', keyHash: rootKey.keyHash },
    });

    const createAgentResponse = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization },
      payload: { name: 'List Agent' },
    });
    assert.strictEqual(createAgentResponse.statusCode, 201);
    const agentId = (JSON.parse(createAgentResponse.payload) as { agent: { id: string } }).agent.id;

    await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/resources`,
      headers: { authorization },
      payload: { type: 'email_inbox', provider: 'mock' },
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: `/agents/${agentId}/resources`,
      headers: { authorization },
    });
    assert.strictEqual(listResponse.statusCode, 200);
    const listPayload = JSON.parse(listResponse.payload) as {
      resources: Array<{ id: string; state: string; orgId: string }>;
    };
    assert.strictEqual(listPayload.resources.length, 1);
    assert.strictEqual(listPayload.resources[0].orgId, orgId);
    assert.strictEqual(listPayload.resources[0].state, 'active');
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: deprovision → state=deleted, not returned in GET', async () => {
  const server = await buildServer();
  const orgId = `org_res_${crypto.randomUUID()}`;
  const rootKey = await generateApiKeyMaterial();
  const authorization = `Bearer ${rootKey.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: { id: orgId, name: 'Deprovision Org' },
      apiKey: { id: rootKey.id, keyType: 'root', keyHash: rootKey.keyHash },
    });

    const createAgentResponse = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization },
      payload: { name: 'Deprovision Agent' },
    });
    assert.strictEqual(createAgentResponse.statusCode, 201);
    const agentId = (JSON.parse(createAgentResponse.payload) as { agent: { id: string } }).agent.id;

    const provisionResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentId}/resources`,
      headers: { authorization },
      payload: { type: 'email_inbox', provider: 'mock' },
    });
    assert.strictEqual(provisionResponse.statusCode, 201);
    const resourceId = (JSON.parse(provisionResponse.payload) as { resource: { id: string } })
      .resource.id;

    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/agents/${agentId}/resources/${resourceId}`,
      headers: { authorization },
    });
    assert.strictEqual(deleteResponse.statusCode, 200);
    const deletePayload = JSON.parse(deleteResponse.payload) as {
      resource: { id: string; state: string };
    };
    assert.strictEqual(deletePayload.resource.state, 'deleted');

    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedResources[0].state, 'deleted');

    const listResponse = await server.inject({
      method: 'GET',
      url: `/agents/${agentId}/resources`,
      headers: { authorization },
    });
    assert.strictEqual(listResponse.statusCode, 200);
    const listPayload = JSON.parse(listResponse.payload) as { resources: unknown[] };
    assert.strictEqual(listPayload.resources.length, 0);
  } finally {
    await cleanupOrg(orgId);
    await server.close();
  }
});

void test('integration: cross-org isolation: another org cannot deprovision first org resource', async () => {
  const server = await buildServer();
  const orgAId = `org_res_${crypto.randomUUID()}`;
  const orgBId = `org_res_${crypto.randomUUID()}`;
  const rootKeyA = await generateApiKeyMaterial();
  const rootKeyB = await generateApiKeyMaterial();
  const authorizationA = `Bearer ${rootKeyA.plaintextKey}`;
  const authorizationB = `Bearer ${rootKeyB.plaintextKey}`;

  try {
    await server.systemDal.createOrgWithApiKey({
      org: { id: orgAId, name: 'Org A' },
      apiKey: { id: rootKeyA.id, keyType: 'root', keyHash: rootKeyA.keyHash },
    });
    await server.systemDal.createOrgWithApiKey({
      org: { id: orgBId, name: 'Org B' },
      apiKey: { id: rootKeyB.id, keyType: 'root', keyHash: rootKeyB.keyHash },
    });

    // Org A creates an agent + resource
    const createAgentResponseA = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: authorizationA },
      payload: { name: 'Org A Agent' },
    });
    assert.strictEqual(createAgentResponseA.statusCode, 201);
    const agentAId = (JSON.parse(createAgentResponseA.payload) as { agent: { id: string } }).agent
      .id;

    const provisionResponse = await server.inject({
      method: 'POST',
      url: `/agents/${agentAId}/resources`,
      headers: { authorization: authorizationA },
      payload: { type: 'email_inbox', provider: 'mock' },
    });
    assert.strictEqual(provisionResponse.statusCode, 201);
    const resourceId = (JSON.parse(provisionResponse.payload) as { resource: { id: string } })
      .resource.id;

    // Org B creates its own agent
    const createAgentResponseB = await server.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: authorizationB },
      payload: { name: 'Org B Agent' },
    });
    assert.strictEqual(createAgentResponseB.statusCode, 201);
    const agentBId = (JSON.parse(createAgentResponseB.payload) as { agent: { id: string } }).agent
      .id;

    // Org B tries to deprovision Org A's resource using Org B's agent path
    const crossOrgDeleteResponse = await server.inject({
      method: 'DELETE',
      url: `/agents/${agentBId}/resources/${resourceId}`,
      headers: { authorization: authorizationB },
    });
    assert.strictEqual(crossOrgDeleteResponse.statusCode, 404);

    // Org A's resource is still active
    const storedResources = await db.select().from(resources).where(eq(resources.orgId, orgAId));
    assert.strictEqual(storedResources.length, 1);
    assert.strictEqual(storedResources[0].state, 'active');
  } finally {
    await cleanupOrg(orgAId);
    await cleanupOrg(orgBId);
    await server.close();
  }
});
