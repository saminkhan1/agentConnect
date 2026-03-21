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

void test("integration: auth + agent e2e covers valid/invalid/revoked keys and cross-org isolation", async () => {
	const server = await buildServer();

	const primaryOrgId = `org_auth_${crypto.randomUUID()}`;
	const secondaryOrgId = `org_auth_${crypto.randomUUID()}`;
	const primaryRootKey = await generateApiKeyMaterial();
	const secondaryRootKey = await generateApiKeyMaterial();

	const primaryAuthorization = `Bearer ${primaryRootKey.plaintextKey}`;
	const secondaryAuthorization = `Bearer ${secondaryRootKey.plaintextKey}`;

	try {
		await server.systemDal.createOrgWithApiKey({
			org: {
				id: primaryOrgId,
				name: "Auth Integration Primary Org",
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
				name: "Auth Integration Secondary Org",
			},
			apiKey: {
				id: secondaryRootKey.id,
				keyType: "root",
				keyHash: secondaryRootKey.keyHash,
			},
		});

		// Valid key can create and read protected resources.
		const createAgentResponse = await server.inject({
			method: "POST",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
			payload: {
				name: "Auth E2E Agent",
			},
		});
		assert.strictEqual(createAgentResponse.statusCode, 201);
		const createAgentPayload = JSON.parse(createAgentResponse.payload) as {
			agent: { id: string; orgId: string };
		};
		assert.strictEqual(createAgentPayload.agent.orgId, primaryOrgId);

		const validGetResponse = await server.inject({
			method: "GET",
			url: `/agents/${createAgentPayload.agent.id}`,
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(validGetResponse.statusCode, 200);

		// Invalid keys are rejected.
		const malformedBearerResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: "Bearer malformed-key",
			},
		});
		assert.strictEqual(malformedBearerResponse.statusCode, 401);

		const unknownKeyResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: "Bearer sk_key_missing.secret",
			},
		});
		assert.strictEqual(unknownKeyResponse.statusCode, 401);

		const wrongSecretResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: `Bearer sk_${primaryRootKey.id}.wrong-secret`,
			},
		});
		assert.strictEqual(wrongSecretResponse.statusCode, 401);

		// Cross-org access is isolated.
		const crossOrgAgentLookupResponse = await server.inject({
			method: "GET",
			url: `/agents/${createAgentPayload.agent.id}`,
			headers: {
				authorization: secondaryAuthorization,
			},
		});
		assert.strictEqual(crossOrgAgentLookupResponse.statusCode, 404);

		const crossOrgApiKeyCreateResponse = await server.inject({
			method: "POST",
			url: `/orgs/${secondaryOrgId}/api-keys`,
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(crossOrgApiKeyCreateResponse.statusCode, 403);

		// Revoked keys are rejected after revocation.
		const preRevokeResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(preRevokeResponse.statusCode, 200);

		await db
			.update(apiKeys)
			.set({ isRevoked: true })
			.where(
				and(eq(apiKeys.orgId, primaryOrgId), eq(apiKeys.id, primaryRootKey.id)),
			);

		const revokedKeyResponse = await server.inject({
			method: "GET",
			url: "/agents",
			headers: {
				authorization: primaryAuthorization,
			},
		});
		assert.strictEqual(revokedKeyResponse.statusCode, 401);
	} finally {
		await cleanupOrg(primaryOrgId);
		await cleanupOrg(secondaryOrgId);
		await server.close();
	}
});
