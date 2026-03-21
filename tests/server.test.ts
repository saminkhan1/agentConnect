import assert from "node:assert";
import test from "node:test";
import { z } from "zod";

import { buildServer } from "../src/api/server";
import { DalFactory } from "../src/db/dal";
import { generateApiKeyMaterial } from "../src/domain/api-keys";

const healthResponseSchema = z.object({
	status: z.literal("ok"),
	timestamp: z.iso.datetime(),
});

const createOrgResponseSchema = z.object({
	org: z.object({
		id: z.string(),
		name: z.string(),
		createdAt: z.iso.datetime(),
	}),
	apiKey: z.object({
		id: z.string(),
		orgId: z.string(),
		keyType: z.literal("root"),
		key: z.string(),
		createdAt: z.iso.datetime(),
	}),
});

const createServiceApiKeyResponseSchema = z.object({
	apiKey: z.object({
		id: z.string(),
		orgId: z.string(),
		keyType: z.literal("service"),
		key: z.string(),
		createdAt: z.iso.datetime(),
	}),
});

const capturedCreateOrgInputSchema = z.object({
	org: z.object({
		id: z.string(),
		name: z.string(),
	}),
	apiKey: z.object({
		id: z.string(),
		keyType: z.enum(["root", "service"]),
		keyHash: z.string(),
	}),
});

const capturedServiceInsertSchema = z.object({
	id: z.string(),
	keyType: z.literal("service"),
	keyHash: z.string(),
});

const errorResponseSchema = z.object({
	message: z.string(),
});

void test("health endpoint returns ok", async () => {
	const server = await buildServer();
	try {
		const response = await server.inject({
			method: "GET",
			url: "/health",
		});

		assert.strictEqual(response.statusCode, 200);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = healthResponseSchema.parse(rawPayload);
		assert.strictEqual(payload.status, "ok");
		assert.ok(payload.timestamp);
	} finally {
		await server.close();
	}
});

void test("subsequent requests include x-correlation-id", async () => {
	const server = await buildServer();
	try {
		const response1 = await server.inject({
			method: "GET",
			url: "/health",
		});

		const correlationId1 = response1.headers["x-correlation-id"];
		assert.ok(correlationId1);

		const response2 = await server.inject({
			method: "GET",
			url: "/health",
			headers: {
				"x-correlation-id": "my-custom-id",
			},
		});

		const correlationId2 = response2.headers["x-correlation-id"];
		assert.strictEqual(correlationId2, "my-custom-id");
	} finally {
		await server.close();
	}
});

void test("POST /orgs creates an org and returns a root key once", async () => {
	const server = await buildServer();
	const originalCreateOrgWithApiKey = server.systemDal.createOrgWithApiKey.bind(
		server.systemDal,
	);

	const capturedInputs: Array<z.infer<typeof capturedCreateOrgInputSchema>> =
		[];

	server.systemDal.createOrgWithApiKey = (data) => {
		const parsedInput = capturedCreateOrgInputSchema.parse(data);
		capturedInputs.push(parsedInput);
		const createdAt = new Date("2026-03-01T00:00:00.000Z");
		return Promise.resolve({
			org: {
				id: parsedInput.org.id,
				name: parsedInput.org.name,
				createdAt,
			},
			apiKey: {
				id: parsedInput.apiKey.id,
				orgId: parsedInput.org.id,
				keyType: parsedInput.apiKey.keyType,
				keyHash: parsedInput.apiKey.keyHash,
				isRevoked: false,
				createdAt,
			},
		});
	};

	try {
		const response = await server.inject({
			method: "POST",
			url: "/orgs",
			payload: {
				name: "Acme AI",
			},
		});

		assert.strictEqual(response.statusCode, 201);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = createOrgResponseSchema.parse(rawPayload);

		assert.strictEqual(payload.org.name, "Acme AI");
		assert.strictEqual(payload.apiKey.orgId, payload.org.id);
		assert.match(payload.apiKey.key, /^sk_/);

		assert.strictEqual(capturedInputs.length, 1);
		const capturedInput = capturedInputs[0];
		assert.strictEqual(capturedInput.apiKey.keyType, "root");
		assert.match(capturedInput.apiKey.keyHash, /^scrypt\$/);
		assert.notStrictEqual(capturedInput.apiKey.keyHash, payload.apiKey.key);
	} finally {
		server.systemDal.createOrgWithApiKey = originalCreateOrgWithApiKey;
		await server.close();
	}
});

void test("POST /orgs/:id/api-keys returns 401 for invalid auth variants", async () => {
	const knownRootKey = await generateApiKeyMaterial();
	const cases = [
		{
			name: "missing auth header",
			headers: undefined,
			setup: (_server: Awaited<ReturnType<typeof buildServer>>) => () => {},
		},
		{
			name: "malformed auth header",
			headers: { authorization: "Bearer malformed-key" },
			setup: (_server: Awaited<ReturnType<typeof buildServer>>) => () => {},
		},
		{
			name: "unknown key id",
			headers: { authorization: "Bearer sk_key_missing.secret" },
			setup: (server: Awaited<ReturnType<typeof buildServer>>) => {
				const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(
					server.systemDal,
				);
				server.systemDal.getApiKeyById = (_id) => Promise.resolve(null);
				return () => {
					server.systemDal.getApiKeyById = originalGetApiKeyById;
				};
			},
		},
		{
			name: "invalid key secret",
			headers: {
				authorization: `Bearer sk_${knownRootKey.id}.wrong-secret`,
			},
			setup: (server: Awaited<ReturnType<typeof buildServer>>) => {
				const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(
					server.systemDal,
				);
				server.systemDal.getApiKeyById = (_id) =>
					Promise.resolve({
						id: knownRootKey.id,
						orgId: "org_123",
						keyType: "root",
						keyHash: knownRootKey.keyHash,
						isRevoked: false,
						createdAt: new Date("2026-03-01T00:00:00.000Z"),
					});
				return () => {
					server.systemDal.getApiKeyById = originalGetApiKeyById;
				};
			},
		},
	] as const;

	for (const testCase of cases) {
		const server = await buildServer();
		const restore = testCase.setup(server);

		try {
			const response = await server.inject({
				method: "POST",
				url: "/orgs/org_123/api-keys",
				...(testCase.headers ? { headers: testCase.headers } : {}),
			});

			assert.strictEqual(response.statusCode, 401, testCase.name);
			const rawPayload: unknown = JSON.parse(response.payload);
			const payload = errorResponseSchema.parse(rawPayload);
			assert.strictEqual(payload.message, "Unauthorized", testCase.name);
		} finally {
			restore();
			await server.close();
		}
	}
});

void test("POST /orgs/:id/api-keys returns 403 when scope is missing", async () => {
	const server = await buildServer();
	const serviceKey = await generateApiKeyMaterial();
	const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(
		server.systemDal,
	);
	server.systemDal.getApiKeyById = (_id) =>
		Promise.resolve({
			id: serviceKey.id,
			orgId: "org_123",
			keyType: "service",
			keyHash: serviceKey.keyHash,
			isRevoked: false,
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
		});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/orgs/org_123/api-keys",
			headers: {
				authorization: `Bearer ${serviceKey.plaintextKey}`,
			},
		});

		assert.strictEqual(response.statusCode, 403);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = errorResponseSchema.parse(rawPayload);
		assert.strictEqual(payload.message, "Forbidden");
	} finally {
		server.systemDal.getApiKeyById = originalGetApiKeyById;
		await server.close();
	}
});

void test("POST /orgs/:id/api-keys creates a service key for a matching root key org", async () => {
	const server = await buildServer();
	const rootKey = await generateApiKeyMaterial();
	const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(
		server.systemDal,
	);
	server.systemDal.getApiKeyById = (_id) =>
		Promise.resolve({
			id: rootKey.id,
			orgId: "org_123",
			keyType: "root",
			keyHash: rootKey.keyHash,
			isRevoked: false,
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
		});

	const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
	let lookedUpOrgId: string | undefined;
	server.systemDal.getOrg = (id) => {
		lookedUpOrgId = id;
		return Promise.resolve({
			id,
			name: "Acme AI",
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
		});
	};

	const capturedInserts: Array<z.infer<typeof capturedServiceInsertSchema>> =
		[];

	const originalApiKeysDescriptor = Object.getOwnPropertyDescriptor(
		DalFactory.prototype,
		"apiKeys",
	);
	Object.defineProperty(DalFactory.prototype, "apiKeys", {
		configurable: true,
		get() {
			return {
				insert: (data: unknown) => {
					const createdAt = new Date("2026-03-01T00:00:00.000Z");
					const parsedData = capturedServiceInsertSchema.parse(data);
					capturedInserts.push(parsedData);
					return Promise.resolve({
						...parsedData,
						orgId: "org_123",
						createdAt,
					});
				},
			};
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/orgs/org_123/api-keys",
			headers: {
				authorization: `bearer ${rootKey.plaintextKey}`,
			},
		});

		assert.strictEqual(response.statusCode, 201);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = createServiceApiKeyResponseSchema.parse(rawPayload);

		assert.strictEqual(payload.apiKey.orgId, "org_123");
		assert.strictEqual(payload.apiKey.keyType, "service");
		assert.match(payload.apiKey.key, /^sk_/);

		assert.strictEqual(lookedUpOrgId, "org_123");
		assert.strictEqual(capturedInserts.length, 1);
		const capturedInsert = capturedInserts[0];
		assert.strictEqual(capturedInsert.keyType, "service");
		assert.match(capturedInsert.keyHash, /^scrypt\$/);
		assert.notStrictEqual(capturedInsert.keyHash, payload.apiKey.key);
	} finally {
		server.systemDal.getApiKeyById = originalGetApiKeyById;
		server.systemDal.getOrg = originalGetOrg;
		if (originalApiKeysDescriptor) {
			Object.defineProperty(
				DalFactory.prototype,
				"apiKeys",
				originalApiKeysDescriptor,
			);
		}
		await server.close();
	}
});

void test("POST /orgs/:id/api-keys returns 403 when auth org does not match route org", async () => {
	const server = await buildServer();
	const rootKey = await generateApiKeyMaterial();
	const originalGetApiKeyById = server.systemDal.getApiKeyById.bind(
		server.systemDal,
	);
	server.systemDal.getApiKeyById = (_id) =>
		Promise.resolve({
			id: rootKey.id,
			orgId: "org_123",
			keyType: "root",
			keyHash: rootKey.keyHash,
			isRevoked: false,
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
		});

	const originalGetOrg = server.systemDal.getOrg.bind(server.systemDal);
	let lookedUpOrgId: string | undefined;
	server.systemDal.getOrg = (id) => {
		lookedUpOrgId = id;
		return Promise.resolve({
			id,
			name: "Acme AI",
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
		});
	};

	try {
		const response = await server.inject({
			method: "POST",
			url: "/orgs/org_999/api-keys",
			headers: {
				authorization: `Bearer ${rootKey.plaintextKey}`,
			},
		});

		assert.strictEqual(response.statusCode, 403);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = errorResponseSchema.parse(rawPayload);
		assert.strictEqual(payload.message, "Forbidden");
		assert.strictEqual(lookedUpOrgId, undefined);
	} finally {
		server.systemDal.getApiKeyById = originalGetApiKeyById;
		server.systemDal.getOrg = originalGetOrg;
		await server.close();
	}
});

void test("public routes fail closed when malformed authorization header is present", async () => {
	const server = await buildServer();
	try {
		const response = await server.inject({
			method: "GET",
			url: "/health",
			headers: {
				authorization: "Basic abc123",
			},
		});

		assert.strictEqual(response.statusCode, 401);
		const rawPayload: unknown = JSON.parse(response.payload);
		const payload = errorResponseSchema.parse(rawPayload);
		assert.strictEqual(payload.message, "Unauthorized");
	} finally {
		await server.close();
	}
});
