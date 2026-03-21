import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { buildServer } from "../src/api/server";
import { db } from "../src/db";
import { agents, apiKeys, orgs } from "../src/db/schema";
import { generateApiKeyMaterial } from "../src/domain/api-keys";

async function cleanupOrg(orgId: string): Promise<void> {
	await db.delete(agents).where(eq(agents.orgId, orgId));
	await db.delete(apiKeys).where(eq(apiKeys.orgId, orgId));
	await db.delete(orgs).where(eq(orgs.id, orgId));
}

void test("integration: agent CRUD uses real DB and enforces org isolation", async () => {
	const server = await buildServer();

	const primaryOrgId = `org_int_${crypto.randomUUID()}`;
	const secondaryOrgId = `org_int_${crypto.randomUUID()}`;
	const primaryRootKey = await generateApiKeyMaterial();
	const secondaryRootKey = await generateApiKeyMaterial();

	const primaryAuthorization = `Bearer ${primaryRootKey.plaintextKey}`;
	const secondaryAuthorization = `Bearer ${secondaryRootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: primaryOrgId,
				name: "Integration Primary Org",
			},
			apiKey: {
				id: primaryRootKey.id,
				keyType: "root",
				keyHash: primaryRootKey.keyHash,
			},
		});

		await server.systemDal.createOrgWithApiKey({
			org: {
				id: secondaryOrgId,
				name: "Integration Secondary Org",
			},
			apiKey: {
				id: secondaryRootKey.id,
				keyType: "root",
				keyHash: secondaryRootKey.keyHash,
			},
		});

		const createResponse = await server.inject({
			method: "POST",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
			payload: {
				name: "Integration Agent",
			},
		});

		assert.strictEqual(createResponse.statusCode, 201);
		const createPayload: unknown = JSON.parse(createResponse.payload);
		assert.ok(createPayload && typeof createPayload === "object");
		assert.ok("agent" in (createPayload as Record<string, unknown>));

		const createdAgent = (
			createPayload as { agent: { id: string; orgId: string } }
		).agent;
		assert.match(createdAgent.id, /^agt_/);
		assert.strictEqual(createdAgent.orgId, primaryOrgId);

		const listDefaultResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(listDefaultResponse.statusCode, 200);
		const listDefaultPayload = JSON.parse(listDefaultResponse.payload) as {
			agents: Array<{ id: string; isArchived: boolean }>;
		};
		assert.strictEqual(listDefaultPayload.agents.length, 1);
		assert.strictEqual(listDefaultPayload.agents[0].id, createdAgent.id);
		assert.strictEqual(listDefaultPayload.agents[0].isArchived, false);

		const patchResponse = await server.inject({
			method: "PATCH",
			url: `/agents/${createdAgent.id}`,
			headers: {
				authorization: primaryAuthorization,
			},
			payload: {
				name: "Integration Agent Updated",
				isArchived: true,
			},
		});
		assert.strictEqual(patchResponse.statusCode, 200);
		const patchPayload = JSON.parse(patchResponse.payload) as {
			agent: { id: string; name: string; isArchived: boolean };
		};
		assert.strictEqual(patchPayload.agent.id, createdAgent.id);
		assert.strictEqual(patchPayload.agent.name, "Integration Agent Updated");
		assert.strictEqual(patchPayload.agent.isArchived, true);

		const listAfterArchiveResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(listAfterArchiveResponse.statusCode, 200);
		const listAfterArchivePayload = JSON.parse(
			listAfterArchiveResponse.payload,
		) as {
			agents: Array<{ id: string }>;
		};
		assert.strictEqual(listAfterArchivePayload.agents.length, 0);

		const listWithArchivedResponse = await server.inject({
			method: "GET",
			url: "/agents?includeArchived=true",
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(listWithArchivedResponse.statusCode, 200);
		const listWithArchivedPayload = JSON.parse(
			listWithArchivedResponse.payload,
		) as {
			agents: Array<{ id: string; isArchived: boolean }>;
		};
		assert.strictEqual(listWithArchivedPayload.agents.length, 1);
		assert.strictEqual(listWithArchivedPayload.agents[0].id, createdAgent.id);
		assert.strictEqual(listWithArchivedPayload.agents[0].isArchived, true);

		const getByIdResponse = await server.inject({
			method: "GET",
			url: `/agents/${createdAgent.id}`,
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(getByIdResponse.statusCode, 200);
		const getByIdPayload = JSON.parse(getByIdResponse.payload) as {
			agent: { id: string; isArchived: boolean };
		};
		assert.strictEqual(getByIdPayload.agent.id, createdAgent.id);
		assert.strictEqual(getByIdPayload.agent.isArchived, true);

		const crossOrgResponse = await server.inject({
			method: "GET",
			url: `/agents/${createdAgent.id}`,
			headers: {
				authorization: secondaryAuthorization,
			},
		});
		assert.strictEqual(crossOrgResponse.statusCode, 404);

		const firstDeleteResponse = await server.inject({
			method: "DELETE",
			url: `/agents/${createdAgent.id}`,
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(firstDeleteResponse.statusCode, 200);

		const secondDeleteResponse = await server.inject({
			method: "DELETE",
			url: `/agents/${createdAgent.id}`,
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(secondDeleteResponse.statusCode, 200);

		const dbLookup = await db
			.select()
			.from(agents)
			.where(
				and(eq(agents.orgId, primaryOrgId), eq(agents.id, createdAgent.id)),
			)
			.limit(1);
		assert.strictEqual(dbLookup.length, 1);
		assert.strictEqual(dbLookup[0].isArchived, true);
	} finally {
		await cleanupOrg(primaryOrgId);
		await cleanupOrg(secondaryOrgId);
		await server.close();
	}
});
