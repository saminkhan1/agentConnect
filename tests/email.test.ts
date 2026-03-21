import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";

import { AgentMailError } from "agentmail";

import { AgentMailAdapter } from "../src/adapters/agentmail-adapter";
import type { ParsedWebhookEvent } from "../src/adapters/provider-adapter";
import { buildServer } from "../src/api/server";
import { systemDal } from "../src/db/dal";
import type { WriteEventResult } from "../src/domain/event-writer";
import {
	buildAgentRecord,
	buildOutboundActionRecord,
	buildResourceRecord,
	createMemoryOutboundActionsDal,
	FIXED_TIMESTAMP,
	installAdvisoryLockMock,
	installAgentMailAdapterMock,
	installAgentsDalMock,
	installAuthApiKey,
	installEventsDalMock,
	installEventWriterMock,
	installOutboundActionsDalMock,
	installResourcesDalMock,
	type ResourceRecord,
} from "./helpers";

const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldHZhbHVlZm9ydGVzdHM="; // base64 of "testsecretvaluefortests"

function buildFakeEventRecord(overrides?: Record<string, unknown>) {
	return {
		id: crypto.randomUUID(),
		orgId: "org_123",
		agentId: "agt_123",
		resourceId: "res_123",
		provider: "agentmail",
		providerEventId: null,
		eventType: "email.sent" as const,
		occurredAt: FIXED_TIMESTAMP,
		idempotencyKey: null,
		data: {
			message_id: "",
			from: "agent@agentmail.to",
			to: ["user@example.com"],
			subject: "Hi",
		},
		ingestedAt: FIXED_TIMESTAMP,
		...overrides,
	};
}

type EventRecord = ReturnType<typeof buildFakeEventRecord>;

function normalizeReplyToHashValue(value?: string | string[]) {
	return [...(typeof value === "string" ? [value] : (value ?? []))].sort();
}

function buildSendEmailRequestHash(
	resource: ResourceRecord,
	payload: {
		to: string[];
		subject: string;
		text: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		reply_to?: string | string[];
	},
) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				from: resource.providerRef ?? "",
				to: [...payload.to].sort(),
				cc: [...(payload.cc ?? [])].sort(),
				bcc: [...(payload.bcc ?? [])].sort(),
				subject: payload.subject,
				text: payload.text,
				html: payload.html ?? "",
				reply_to: normalizeReplyToHashValue(payload.reply_to),
			}),
		)
		.digest("hex");
}

function buildReplyEmailRequestHash(
	resource: ResourceRecord,
	payload: {
		message_id: string;
		text: string;
		html?: string;
		cc?: string[];
		bcc?: string[];
		reply_to?: string | string[];
	},
) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				from: resource.providerRef ?? "",
				message_id: payload.message_id,
				text: payload.text,
				html: payload.html ?? "",
				cc: [...(payload.cc ?? [])].sort(),
				bcc: [...(payload.bcc ?? [])].sort(),
				reply_to: normalizeReplyToHashValue(payload.reply_to),
			}),
		)
		.digest("hex");
}

// Svix-compatible webhook signature generation
function signTestWebhook(
	secret: string,
	msgId: string,
	timestamp: string,
	body: string,
): string {
	const key = Buffer.from(secret.replace("whsec_", ""), "base64");
	const toSign = `${msgId}.${timestamp}.${body}`;
	const sig = crypto.createHmac("sha256", key).update(toSign).digest("base64");
	return `v1,${sig}`;
}

function buildWebhookHeaders(body: string, secret: string = WEBHOOK_SECRET) {
	const msgId = `msg_${crypto.randomUUID()}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = signTestWebhook(secret, msgId, timestamp, body);
	return {
		"svix-id": msgId,
		"svix-timestamp": timestamp,
		"svix-signature": signature,
		"content-type": "application/json",
	};
}

function buildWebhookAliasHeaders(
	body: string,
	secret: string = WEBHOOK_SECRET,
) {
	const msgId = `msg_${crypto.randomUUID()}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = signTestWebhook(secret, msgId, timestamp, body);
	return {
		"webhook-id": msgId,
		"webhook-timestamp": timestamp,
		"webhook-signature": signature,
		"content-type": "application/json",
	};
}

function buildWebhookThread(overrides?: Record<string, unknown>) {
	return {
		inbox_id: "agent@agentmail.to",
		thread_id: "thread_1",
		labels: ["unread"],
		timestamp: FIXED_TIMESTAMP.toISOString(),
		senders: ["sender@example.com"],
		recipients: ["agent@agentmail.to"],
		subject: "Hello",
		preview: "Hello",
		last_message_id: "msg_xyz",
		message_count: 1,
		size: 1024,
		updated_at: FIXED_TIMESTAMP.toISOString(),
		created_at: FIXED_TIMESTAMP.toISOString(),
		...overrides,
	};
}

function buildReceivedWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.received",
		event_id: "evt_abc123",
		message: {
			inbox_id: "agent@agentmail.to",
			message_id: "msg_xyz",
			thread_id: "thread_1",
			labels: ["unread"],
			from: "sender@example.com",
			reply_to: ["replyto@example.com"],
			to: ["agent@agentmail.to"],
			subject: "Hello",
			preview: "Hello",
			size: 1024,
			updated_at: FIXED_TIMESTAMP.toISOString(),
			created_at: FIXED_TIMESTAMP.toISOString(),
			timestamp: FIXED_TIMESTAMP.toISOString(),
		},
		thread: buildWebhookThread(),
		...overrides,
	});
}

function buildSentWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.sent",
		event_id: "evt_sent_123",
		send: {
			inbox_id: "agent@agentmail.to",
			thread_id: "thread_1",
			message_id: "msg_sent_123",
			timestamp: FIXED_TIMESTAMP.toISOString(),
			recipients: ["user@example.com"],
		},
		...overrides,
	});
}

function buildDeliveredWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.delivered",
		event_id: "evt_delivered_123",
		delivery: {
			inbox_id: "agent@agentmail.to",
			thread_id: "thread_1",
			message_id: "msg_delivered_123",
			timestamp: FIXED_TIMESTAMP.toISOString(),
			recipients: ["user@example.com"],
		},
		...overrides,
	});
}

function buildComplainedWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.complained",
		event_id: "evt_complained_123",
		complaint: {
			inbox_id: "agent@agentmail.to",
			thread_id: "thread_1",
			message_id: "msg_complained_123",
			timestamp: FIXED_TIMESTAMP.toISOString(),
			type: "abuse",
			sub_type: "complaint",
			recipients: ["user@example.com"],
		},
		...overrides,
	});
}

function buildBouncedWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.bounced",
		event_id: "evt_bounced_123",
		bounce: {
			inbox_id: "agent@agentmail.to",
			thread_id: "thread_1",
			message_id: "msg_bounced_123",
			timestamp: FIXED_TIMESTAMP.toISOString(),
			type: "Permanent",
			sub_type: "General",
			recipients: [{ address: "user@example.com", status: "5.1.1" }],
		},
		...overrides,
	});
}

function buildRejectedWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.rejected",
		event_id: "evt_rejected_123",
		reject: {
			inbox_id: "agent@agentmail.to",
			thread_id: "thread_1",
			message_id: "msg_rejected_123",
			timestamp: FIXED_TIMESTAMP.toISOString(),
			reason: "Suppressed destination",
		},
		...overrides,
	});
}

function buildLegacyWebhookPayload(overrides?: Record<string, unknown>) {
	return JSON.stringify({
		type: "event",
		event_type: "message.sent",
		event_id: "evt_legacy_123",
		organization_id: "org_legacy",
		inbox_id: "agent@agentmail.to",
		message: {
			inbox_id: "agent@agentmail.to",
			message_id: "msg_legacy_123",
			thread_id: "thread_legacy_123",
			from: "sender@example.com",
			to: ["agent@agentmail.to"],
			subject: "Legacy payload",
			timestamp: FIXED_TIMESTAMP.toISOString(),
		},
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// send_email action tests
// ---------------------------------------------------------------------------

void test("POST /agents/:id/actions/send_email returns 404 when agent is archived", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const archivedAgent = buildAgentRecord({ isArchived: true });

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(archivedAgent),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-archived",
			},
		});

		assert.strictEqual(response.statusCode, 404);
		const body = JSON.parse(response.payload) as { message: string };
		assert.strictEqual(body.message, "Agent not found");
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 404 when no active agentmail inbox", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-missing-resource",
			},
		});

		assert.strictEqual(response.statusCode, 404);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 403 when policy blocks recipient", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord({
		config: { allowed_domains: ["trusted.com"] },
	});

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["blocked@other.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-policy-blocked",
			},
		});

		assert.strictEqual(response.statusCode, 403);
		const body = JSON.parse(response.payload) as { message: string };
		assert.ok(body.message.includes("blocked@other.com"));
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 200 and emits email.sent event", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({ idempotencyKey: "my-idem-key" });

	const performActionCalls: unknown[] = [];
	const writeEventCalls: unknown[] = [];

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, _action, payload) => {
			performActionCalls.push(payload);
			return Promise.resolve({
				message_id: "msg_sent_123",
				thread_id: "thread_sent_123",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input);
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "my-idem-key",
			},
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(performActionCalls.length, 1);
		assert.strictEqual(writeEventCalls.length, 1);

		const input = writeEventCalls[0] as Record<string, unknown>;
		assert.strictEqual(input.eventType, "email.sent");
		assert.strictEqual(input.idempotencyKey, "my-idem-key");
		const data = input.data as Record<string, unknown>;
		assert.strictEqual(data.message_id, "msg_sent_123");
		assert.strictEqual(data.thread_id, "thread_sent_123");
		assert.strictEqual(data.from, "agent@agentmail.to");
		assert.deepStrictEqual(data.to, ["user@example.com"]);
		assert.strictEqual(data.subject, "Hi");
		assert.strictEqual(typeof data.request_hash, "string");

		const payload = JSON.parse(response.payload) as {
			event: { eventType: string };
		};
		assert.strictEqual(payload.event.eventType, "email.sent");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 400 when idempotency_key is missing", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
			},
		});

		assert.strictEqual(response.statusCode, 400);
		assert.match(
			response.json<{ message: string }>().message,
			/idempotency_key/i,
		);
	} finally {
		restore();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email accepts multiple reply_to addresses", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	const performActionCalls: unknown[] = [];

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, _action, payload) => {
			performActionCalls.push(payload);
			return Promise.resolve({
				message_id: "msg_sent_multi_reply_to",
				thread_id: "thread_sent_multi_reply_to",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) =>
			Promise.resolve({
				event: buildFakeEventRecord({
					data: input.data as Record<string, unknown>,
				}),
				wasCreated: true,
			} as WriteEventResult),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				reply_to: ["reply-one@example.com", "reply-two@example.com"],
				idempotency_key: "idem-send-multi-reply-to",
			},
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(performActionCalls.length, 1);

		const payload = performActionCalls[0] as Record<string, unknown>;
		assert.deepStrictEqual(payload.replyTo, [
			"reply-one@example.com",
			"reply-two@example.com",
		]);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email treats scalar and array reply_to as the same idempotent request", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	let storedEvent: EventRecord | null = null;
	let performActionCalls = 0;
	let writeEventCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_send_reply_to_equivalent",
				thread_id: "thread_send_reply_to_equivalent",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls += 1;
			storedEvent = buildFakeEventRecord({
				idempotencyKey: "idem-send-reply-to-equivalent",
				data: input.data as Record<string, unknown>,
			});
			return Promise.resolve({
				event: storedEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				reply_to: "reply@example.com",
				idempotency_key: "idem-send-reply-to-equivalent",
			},
		});
		assert.strictEqual(first.statusCode, 200);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				reply_to: ["reply@example.com"],
				idempotency_key: "idem-send-reply-to-equivalent",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns AgentMail validation errors directly", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () =>
			Promise.reject(
				new AgentMailError({
					message: "ValidationError",
					statusCode: 400,
					body: { message: "Invalid recipient" },
				}),
			),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-validation",
			},
		});

		assert.strictEqual(response.statusCode, 400);
		assert.deepStrictEqual(response.json(), { message: "Invalid recipient" });
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email keeps retryable AgentMail errors retryable", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({
		idempotencyKey: "idem-send-rate-limited",
	});

	let performActionCalls = 0;
	let storedEvent: EventRecord | null = null;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			if (performActionCalls === 1) {
				return Promise.reject(
					new AgentMailError({
						message: "RateLimitError",
						statusCode: 429,
						body: { message: "Try again later" },
					}),
				);
			}

			return Promise.resolve({
				message_id: "msg_sent_after_retry",
				thread_id: "thread_sent_after_retry",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-rate-limited",
			},
		});
		assert.strictEqual(first.statusCode, 429);
		assert.deepStrictEqual(first.json(), { message: "Try again later" });

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-rate-limited",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 2);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email retries after a provider 401 once credentials are fixed", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({
		idempotencyKey: "idem-send-auth-retry",
	});

	let performActionCalls = 0;
	let storedEvent: EventRecord | null = null;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			if (performActionCalls === 1) {
				return Promise.reject(
					new AgentMailError({
						message: "UnauthorizedError",
						statusCode: 401,
						body: { message: "AgentMail key is invalid" },
					}),
				);
			}

			return Promise.resolve({
				message_id: "msg_sent_after_auth_fix",
				thread_id: "thread_sent_after_auth_fix",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-auth-retry",
			},
		});
		assert.strictEqual(first.statusCode, 401);
		assert.deepStrictEqual(first.json(), {
			message: "AgentMail key is invalid",
		});
		assert.strictEqual(outboundActions.getCurrentAction()?.state, "ready");

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-auth-retry",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 2);
		assert.strictEqual(outboundActions.getCurrentAction()?.state, "completed");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email with the same idempotency key sends only once under concurrency", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreLock = installAdvisoryLockMock(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({
		idempotencyKey: "idem-send-concurrent",
		data: {
			message_id: "msg_sent_123",
			thread_id: "thread_sent_123",
			from: "agent@agentmail.to",
			to: ["user@example.com"],
			subject: "Hi",
		},
	});

	let storedEvent: EventRecord | null = null;
	let performActionCalls = 0;
	let writeEventCalls = 0;
	let resolveSendStarted = () => {};
	const sendStarted = new Promise<void>((resolve) => {
		resolveSendStarted = resolve;
	});
	let releaseSend = () => {};
	const sendCanFinish = new Promise<void>((resolve) => {
		releaseSend = resolve;
	});

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: async (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			resolveSendStarted();
			await sendCanFinish;
			return { message_id: "msg_sent_123", thread_id: "thread_sent_123" };
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const firstResponse = server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-concurrent",
			},
		});

		await sendStarted;

		const secondResponse = server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-concurrent",
			},
		});

		releaseSend();

		const [first, second] = await Promise.all([firstResponse, secondResponse]);
		assert.strictEqual(first.statusCode, 200);
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
		assert.strictEqual(
			first.json<{ event: { idempotencyKey: string | null } }>().event
				.idempotencyKey,
			"idem-send-concurrent",
		);
		assert.strictEqual(
			second.json<{ event: { idempotencyKey: string | null } }>().event
				.idempotencyKey,
			"idem-send-concurrent",
		);
	} finally {
		restore();
		restoreLock();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 when an existing action belongs to another agent inbox", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord({ id: "res_current" });
	let performActionCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal({
		initialAction: buildOutboundActionRecord({
			agentId: "agt_other",
			resourceId: "res_other",
			idempotencyKey: "idem-send-other-agent",
			requestHash: buildSendEmailRequestHash(resource, {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
			}),
		}),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			return Promise.resolve({ message_id: "msg_should_not_send" });
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-other-agent",
			},
		});

		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message: "Idempotency key already used for a different action",
		});
		assert.strictEqual(performActionCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email retries safely after a pre-dispatch state update failure", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({
		idempotencyKey: "idem-send-ready-retry",
	});

	let storedEvent: EventRecord | null = null;
	let performActionCalls = 0;
	let writeEventCalls = 0;
	let dispatchTransitionAttempts = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock({
		...outboundActions.methods,
		transitionState: async (id, fromState, toState, updates) => {
			if (toState === "dispatching") {
				dispatchTransitionAttempts += 1;
				if (dispatchTransitionAttempts === 1) {
					return null;
				}
			}

			return outboundActions.methods.transitionState(
				id,
				fromState,
				toState,
				updates,
			);
		},
	});
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_sent_retry_123",
				thread_id: "thread_sent_retry_123",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-ready-retry",
			},
		});
		assert.strictEqual(first.statusCode, 500);
		assert.strictEqual(performActionCalls, 0);
		assert.strictEqual(writeEventCalls, 0);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-ready-retry",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email rechecks policy before retrying a ready action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord({
		config: { allowed_domains: ["example.com"] },
	});

	let performActionCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			if (performActionCalls === 1) {
				return Promise.reject(
					new AgentMailError({
						message: "RateLimitError",
						statusCode: 429,
						body: { message: "Rate limited" },
					}),
				);
			}

			return Promise.resolve({
				message_id: "msg_should_not_send",
				thread_id: "thread_should_not_send",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			throw new Error(
				"writeEvent should not run while the retry is policy-blocked",
			);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-policy-recheck",
			},
		});
		assert.strictEqual(first.statusCode, 429);

		resource.config = { allowed_domains: ["trusted.com"] };

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-policy-recheck",
			},
		});
		assert.strictEqual(second.statusCode, 403);
		assert.match(
			second.json<{ message: string }>().message,
			/user@example.com/,
		);
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(outboundActions.getCurrentAction()?.state, "ready");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email replays cached provider rejection without resending", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	let performActionCalls = 0;
	let writeEventCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			return Promise.reject(
				new AgentMailError({
					message: "ValidationError",
					statusCode: 400,
					body: { message: "Invalid recipient" },
				}),
			);
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			throw new Error("writeEvent should not run for rejected sends");
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-rejected",
			},
		});
		assert.strictEqual(first.statusCode, 400);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-rejected",
			},
		});
		assert.strictEqual(second.statusCode, 400);
		assert.deepStrictEqual(second.json(), { message: "Invalid recipient" });
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email finalizes a provider_succeeded action without resending", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const fakeEvent = buildFakeEventRecord({
		idempotencyKey: "idem-send-provider-succeeded",
		data: {
			message_id: "msg_sent_recovered",
			thread_id: "thread_sent_recovered",
			from: "agent@agentmail.to",
			to: ["user@example.com"],
			subject: "Hi",
		},
	});

	let storedEvent: EventRecord | null = null;
	let performActionCalls = 0;
	let writeEventCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_sent_recovered",
				thread_id: "thread_sent_recovered",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			if (writeEventCalls === 1) {
				throw new Error("forced write failure");
			}

			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-provider-succeeded",
			},
		});
		assert.strictEqual(first.statusCode, 500);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-provider-succeeded",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 2);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 when a provider_succeeded recovery finds another action event", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const conflictingEvent = buildFakeEventRecord({
		provider: "stripe",
		resourceId: "res_card_conflict",
		eventType: "payment.card.issued",
		idempotencyKey: "idem-send-provider-conflict",
		data: { card_id: "ic_conflict" },
	});

	let performActionCalls = 0;
	let writeEventCalls = 0;
	let exposeConflictEvent = false;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () =>
			Promise.resolve(exposeConflictEvent ? conflictingEvent : null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_sent_conflict",
				thread_id: "thread_sent_conflict",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			throw new Error("forced write failure");
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-provider-conflict",
			},
		});
		assert.strictEqual(first.statusCode, 500);
		assert.strictEqual(
			outboundActions.getCurrentAction()?.state,
			"provider_succeeded",
		);

		exposeConflictEvent = true;

		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-provider-conflict",
			},
		});

		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message: "Idempotency key already used for a different action",
		});
		assert.strictEqual(performActionCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
		assert.strictEqual(
			outboundActions.getCurrentAction()?.state,
			"provider_succeeded",
		);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 for ambiguous retries without resending", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	let performActionCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: (_id) => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: (_agentId, _type, _provider) =>
			Promise.resolve(resource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			assert.strictEqual(action, "send_email");
			performActionCalls += 1;
			return Promise.resolve({});
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-ambiguous",
			},
		});
		assert.strictEqual(first.statusCode, 500);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-send-ambiguous",
			},
		});
		assert.strictEqual(second.statusCode, 409);
		assert.strictEqual(performActionCalls, 1);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// reply_email action tests
// ---------------------------------------------------------------------------

void test("POST /agents/:id/actions/reply_email returns 404 when agent not found", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_missing/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_001",
				text: "Hello",
				idempotency_key: "idem-reply-missing-agent",
			},
		});
		assert.strictEqual(response.statusCode, 404);
	} finally {
		restore();
		restoreAgents();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns 404 when no active email inbox", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(null),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_001",
				text: "Hello",
				idempotency_key: "idem-reply-missing-resource",
			},
		});
		assert.strictEqual(response.statusCode, 404);
		const body = response.json<{ message: string }>();
		assert.ok(body.message.toLowerCase().includes("inbox"));
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns 200 and emits email.sent with in_reply_to_message_id", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);

	const adapterCalls: unknown[] = [];
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			adapterCalls.push({ action, payload });
			if (action === "get_message") {
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender Example <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}
			return Promise.resolve({
				message_id: "msg_reply_001",
				thread_id: "thread_001",
			});
		},
	});

	const writeEventCalls: unknown[] = [];
	const fakeEvent = {
		id: "22222222-2222-4222-8222-222222222222",
		orgId: "org_123",
		agentId: "agt_123",
		resourceId: "res_email_123",
		provider: "agentmail",
		providerEventId: null,
		eventType: "email.sent" as const,
		occurredAt: FIXED_TIMESTAMP,
		idempotencyKey: null,
		data: {
			message_id: "msg_reply_001",
			in_reply_to_message_id: "msg_original_001",
		},
		ingestedAt: FIXED_TIMESTAMP,
	};
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input);
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-success",
			},
		});

		assert.strictEqual(response.statusCode, 200);

		assert.strictEqual(adapterCalls.length, 2);
		const getMessageCall = adapterCalls[0] as {
			action: string;
			payload: Record<string, unknown>;
		};
		assert.strictEqual(getMessageCall.action, "get_message");
		assert.strictEqual(getMessageCall.payload.message_id, "msg_original_001");

		const replyCall = adapterCalls[1] as {
			action: string;
			payload: Record<string, unknown>;
		};
		assert.strictEqual(replyCall.action, "reply_email");
		assert.strictEqual(replyCall.payload.message_id, "msg_original_001");
		assert.deepStrictEqual(replyCall.payload.reply_recipients, [
			"sender@example.com",
		]);

		assert.strictEqual(writeEventCalls.length, 1);
		const eventInput = writeEventCalls[0] as Record<string, unknown>;
		assert.strictEqual(eventInput.eventType, "email.sent");
		const eventData = eventInput.data as Record<string, unknown>;
		assert.strictEqual(eventData.in_reply_to_message_id, "msg_original_001");
		assert.deepStrictEqual(eventData.to, ["sender@example.com"]);
		assert.strictEqual(eventData.subject, "Original subject");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns 400 when idempotency_key is missing", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_001",
				text: "Hello",
			},
		});

		assert.strictEqual(response.statusCode, 400);
		assert.match(
			response.json<{ message: string }>().message,
			/idempotency_key/i,
		);
	} finally {
		restore();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email accepts multiple reply_to addresses", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);

	const adapterCalls: unknown[] = [];
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			adapterCalls.push({ action, payload });
			if (action === "get_message") {
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender Example <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			return Promise.resolve({
				message_id: "msg_reply_001",
				thread_id: "thread_001",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) =>
			Promise.resolve({
				event: buildFakeEventRecord({
					data: input.data as Record<string, unknown>,
				}),
				wasCreated: true,
			} as WriteEventResult),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				reply_to: ["reply-one@example.com", "reply-two@example.com"],
				idempotency_key: "idem-reply-multi-reply-to",
			},
		});

		assert.strictEqual(response.statusCode, 200);

		const replyCall = adapterCalls[1] as {
			action: string;
			payload: Record<string, unknown>;
		};
		assert.strictEqual(replyCall.action, "reply_email");
		assert.deepStrictEqual(replyCall.payload.replyTo, [
			"reply-one@example.com",
			"reply-two@example.com",
		]);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email treats scalar and array reply_to as the same idempotent request", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});

	let storedEvent: EventRecord | null = null;
	let getMessageCalls = 0;
	let replyCalls = 0;
	let writeEventCalls = 0;

	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id ? storedEvent : null,
			),
		findByIdempotencyKey: () => Promise.resolve(storedEvent),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			if (action === "get_message") {
				getMessageCalls += 1;
				return Promise.resolve({
					message_id: payload.message_id,
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			assert.strictEqual(action, "reply_email");
			replyCalls += 1;
			return Promise.resolve({
				message_id: "msg_reply_to_equivalent",
				thread_id: "thread_reply_to_equivalent",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls += 1;
			storedEvent = buildFakeEventRecord({
				idempotencyKey: "idem-reply-to-equivalent",
				resourceId: "res_email_123",
				data: input.data as Record<string, unknown>,
			});
			return Promise.resolve({
				event: storedEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				reply_to: "reply@example.com",
				idempotency_key: "idem-reply-to-equivalent",
			},
		});
		assert.strictEqual(first.statusCode, 200);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				reply_to: ["reply@example.com"],
				idempotency_key: "idem-reply-to-equivalent",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(getMessageCalls, 1);
		assert.strictEqual(replyCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns 403 when original sender violates policy", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			blocked_domains: ["other.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	const adapterCalls: unknown[] = [];
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			adapterCalls.push({ action, payload });
			if (action === "get_message") {
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "ignored@example.com",
					reply_to: ["Blocked Sender <blocked@other.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			throw new Error(`Unexpected action: ${action}`);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-policy-blocked",
			},
		});

		assert.strictEqual(response.statusCode, 403);
		const body = response.json<{ message: string }>();
		assert.ok(body.message.includes("blocked@other.com"));
		assert.strictEqual(adapterCalls.length, 1);
		const getMessageCall = adapterCalls[0] as { action: string };
		assert.strictEqual(getMessageCall.action, "get_message");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email uses original recipients for sent messages", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			blocked_domains: ["blocked.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	const adapterCalls: unknown[] = [];
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action, payload) => {
			adapterCalls.push({ action, payload });
			if (action === "get_message") {
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "Agent Inbox <agent@mail.example.com>",
					to: ["customer@blocked.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			throw new Error(`Unexpected action: ${action}`);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-original-recipients",
			},
		});

		assert.strictEqual(response.statusCode, 403);
		const body = response.json<{ message: string }>();
		assert.ok(body.message.includes("customer@blocked.com"));
		assert.strictEqual(adapterCalls.length, 1);
		assert.strictEqual(
			(adapterCalls[0] as { action: string }).action,
			"get_message",
		);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns provider 404s for missing original messages", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () =>
			Promise.reject(
				new AgentMailError({
					message: "NotFoundError",
					statusCode: 404,
					body: { message: "Message not found" },
				}),
			),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_missing",
				text: "Reply text",
				idempotency_key: "idem-reply-missing-original-message",
			},
		});

		assert.strictEqual(response.statusCode, 404);
		assert.deepStrictEqual(response.json(), { message: "Message not found" });
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns provider 403s from AgentMail directly", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			if (action === "get_message") {
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			return Promise.reject(
				new AgentMailError({
					message: "MessageRejectedError",
					statusCode: 403,
					body: { message: "Message rejected" },
				}),
			);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-provider-403",
			},
		});

		assert.strictEqual(response.statusCode, 403);
		assert.deepStrictEqual(response.json(), { message: "Message rejected" });
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email returns 409 when an existing action belongs to another agent inbox", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_current",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	let adapterCalls = 0;
	const outboundActions = createMemoryOutboundActionsDal({
		initialAction: buildOutboundActionRecord({
			action: "reply_email",
			agentId: "agt_other",
			resourceId: "res_email_other",
			idempotencyKey: "idem-reply-other-agent",
			requestHash: buildReplyEmailRequestHash(emailResource, {
				message_id: "msg_original_001",
				text: "Reply text",
			}),
		}),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			adapterCalls += 1;
			return Promise.resolve({});
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-other-agent",
			},
		});

		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message: "Idempotency key already used for a different action",
		});
		assert.strictEqual(adapterCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email replays cached provider rejection without refetching or re-replying", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	let getMessageCalls = 0;
	let replyCalls = 0;
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			if (action === "get_message") {
				getMessageCalls += 1;
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			assert.strictEqual(action, "reply_email");
			replyCalls += 1;
			return Promise.reject(
				new AgentMailError({
					message: "MessageRejectedError",
					statusCode: 403,
					body: { message: "Message rejected" },
				}),
			);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-rejected",
			},
		});
		assert.strictEqual(first.statusCode, 403);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-rejected",
			},
		});
		assert.strictEqual(second.statusCode, 403);
		assert.deepStrictEqual(second.json(), { message: "Message rejected" });
		assert.strictEqual(getMessageCalls, 1);
		assert.strictEqual(replyCalls, 1);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email rechecks policy before retrying a ready action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	let getMessageCalls = 0;
	let replyCalls = 0;
	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			if (action === "get_message") {
				getMessageCalls += 1;
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			assert.strictEqual(action, "reply_email");
			replyCalls += 1;
			if (replyCalls === 1) {
				return Promise.reject(
					new AgentMailError({
						message: "RateLimitError",
						statusCode: 429,
						body: { message: "Rate limited" },
					}),
				);
			}

			return Promise.resolve({
				message_id: "msg_should_not_send",
				thread_id: "thread_001",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			throw new Error(
				"writeEvent should not run while the retry is policy-blocked",
			);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-policy-recheck",
			},
		});
		assert.strictEqual(first.statusCode, 429);

		emailResource.config = {
			email_address: "agent@mail.example.com",
			allowed_domains: ["trusted.com"],
		};

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-policy-recheck",
			},
		});
		assert.strictEqual(second.statusCode, 403);
		assert.match(
			second.json<{ message: string }>().message,
			/sender@example.com/,
		);
		assert.strictEqual(getMessageCalls, 1);
		assert.strictEqual(replyCalls, 1);
		assert.strictEqual(outboundActions.getCurrentAction()?.state, "ready");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email finalizes a provider_succeeded action without refetching or re-replying", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	let storedEvent: Record<string, unknown> | null = null;
	let getMessageCalls = 0;
	let replyCalls = 0;
	let writeEventCalls = 0;
	const writeEventInputs: unknown[] = [];
	const fakeEvent = {
		id: "55555555-5555-4555-8555-555555555555",
		orgId: "org_123",
		agentId: "agt_123",
		resourceId: "res_email_123",
		provider: "agentmail",
		providerEventId: null,
		eventType: "email.sent" as const,
		occurredAt: FIXED_TIMESTAMP,
		idempotencyKey: "idem-reply-provider-succeeded",
		data: {
			message_id: "msg_reply_001",
			thread_id: "thread_001",
			from: "agent@mail.example.com",
			to: ["sender@example.com"],
			in_reply_to_message_id: "msg_original_001",
			subject: "Original subject",
		},
		ingestedAt: FIXED_TIMESTAMP,
	};

	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id
					? (storedEvent as typeof fakeEvent)
					: null,
			),
		findByIdempotencyKey: () =>
			Promise.resolve(storedEvent as typeof fakeEvent | null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: (_resource, action) => {
			if (action === "get_message") {
				getMessageCalls += 1;
				return Promise.resolve({
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				});
			}

			assert.strictEqual(action, "reply_email");
			replyCalls += 1;
			return Promise.resolve({
				message_id: "msg_reply_001",
				thread_id: "thread_001",
			});
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventInputs.push(input);
			writeEventCalls += 1;
			if (writeEventCalls === 1) {
				throw new Error("forced write failure");
			}

			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const first = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-provider-succeeded",
			},
		});
		assert.strictEqual(first.statusCode, 500);

		const second = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-provider-succeeded",
			},
		});
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(getMessageCalls, 1);
		assert.strictEqual(replyCalls, 1);
		assert.strictEqual(writeEventCalls, 2);
		assert.strictEqual(writeEventInputs.length, 2);
		const recoveredInput = writeEventInputs[1] as {
			data: Record<string, unknown>;
		};
		assert.strictEqual(recoveredInput.data.subject, "Original subject");
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/reply_email with the same idempotency key replies only once under concurrency", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const restoreLock = installAdvisoryLockMock(server);
	const agent = buildAgentRecord();
	const emailResource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: {
			email_address: "agent@mail.example.com",
			allowed_domains: ["example.com"],
		},
	});
	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(emailResource),
	});

	let storedEvent: Record<string, unknown> | null = null;
	let getMessageCalls = 0;
	let replyCalls = 0;
	let writeEventCalls = 0;
	let resolveReplyStarted = () => {};
	const replyStarted = new Promise<void>((resolve) => {
		resolveReplyStarted = resolve;
	});
	let releaseReply = () => {};
	const replyCanFinish = new Promise<void>((resolve) => {
		releaseReply = resolve;
	});
	const fakeEvent = {
		id: "44444444-4444-4444-8444-444444444444",
		orgId: "org_123",
		agentId: "agt_123",
		resourceId: "res_email_123",
		provider: "agentmail",
		providerEventId: null,
		eventType: "email.sent" as const,
		occurredAt: FIXED_TIMESTAMP,
		idempotencyKey: "idem-reply-concurrent",
		data: {
			message_id: "msg_reply_001",
			thread_id: "thread_001",
			from: "agent@mail.example.com",
			to: ["sender@example.com"],
			in_reply_to_message_id: "msg_original_001",
		},
		ingestedAt: FIXED_TIMESTAMP,
	};

	const outboundActions = createMemoryOutboundActionsDal();
	const restoreEvents = installEventsDalMock({
		findById: (id) =>
			Promise.resolve(
				storedEvent && storedEvent.id === id
					? (storedEvent as typeof fakeEvent)
					: null,
			),
		findByIdempotencyKey: () =>
			Promise.resolve(storedEvent as typeof fakeEvent | null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);

	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: async (_resource, action) => {
			if (action === "get_message") {
				getMessageCalls += 1;
				return {
					message_id: "msg_original_001",
					from: "sender@example.com",
					reply_to: ["Sender <sender@example.com>"],
					to: ["agent@mail.example.com"],
					subject: "Original subject",
					text: "Original text",
					html: null,
				};
			}

			assert.strictEqual(action, "reply_email");
			replyCalls += 1;
			resolveReplyStarted();
			await replyCanFinish;
			return { message_id: "msg_reply_001", thread_id: "thread_001" };
		},
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			storedEvent = fakeEvent;
			return Promise.resolve({
				event: fakeEvent,
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const firstResponse = server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-concurrent",
			},
		});

		await replyStarted;

		const secondResponse = server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/reply_email",
			headers: {
				authorization: authorizationHeader,
				"content-type": "application/json",
			},
			payload: {
				message_id: "msg_original_001",
				text: "Reply text",
				idempotency_key: "idem-reply-concurrent",
			},
		});

		releaseReply();

		const [first, second] = await Promise.all([firstResponse, secondResponse]);
		assert.strictEqual(first.statusCode, 200);
		assert.strictEqual(second.statusCode, 200);
		assert.strictEqual(getMessageCalls, 1);
		assert.strictEqual(replyCalls, 1);
		assert.strictEqual(writeEventCalls, 1);
	} finally {
		restore();
		restoreLock();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// Adapter tests
// ---------------------------------------------------------------------------

void test("AgentMailAdapter.provision returns config.email_address matching inboxId", async () => {
	const adapter = new AgentMailAdapter("key", "secret");

	(adapter as unknown as { client: Record<string, unknown> }).client = {
		inboxes: {
			create: () =>
				Promise.resolve({ inboxId: "inbox@example.com", podId: "pod_123" }),
		},
	};

	const result = await adapter.provision("agt_test", {});
	assert.strictEqual(result.providerRef, "inbox@example.com");
	assert.strictEqual(
		(result.config as Record<string, unknown>).email_address,
		"inbox@example.com",
	);
});

void test("AgentMailAdapter.reply_email forwards resolved reply recipients as `to`", async () => {
	const adapter = new AgentMailAdapter("key", "secret");
	let replyArgs: unknown[] | null = null;

	(adapter as unknown as { client: Record<string, unknown> }).client = {
		inboxes: {
			messages: {
				reply: (...args: unknown[]) => {
					replyArgs = args;
					return Promise.resolve({
						messageId: "msg_reply_123",
						threadId: "thread_123",
					});
				},
			},
		},
	};

	const result = await adapter.performAction(
		buildResourceRecord({
			id: "res_email_123",
			providerRef: "agent@mail.example.com",
			providerOrgId: "pod_123",
			config: { email_address: "agent@mail.example.com" },
		}),
		"reply_email",
		{
			message_id: "msg_original_123",
			text: "Reply body",
			reply_recipients: ["customer@example.com"],
			cc: ["cc@example.com"],
		},
	);

	assert.deepStrictEqual(result, {
		message_id: "msg_reply_123",
		thread_id: "thread_123",
	});
	assert.ok(replyArgs, "expected AgentMail reply to be called");
	assert.strictEqual(replyArgs[0], "agent@mail.example.com");
	assert.strictEqual(replyArgs[1], "msg_original_123");
	assert.deepStrictEqual(replyArgs[2], {
		to: ["customer@example.com"],
		text: "Reply body",
		html: undefined,
		cc: ["cc@example.com"],
		bcc: undefined,
		replyTo: undefined,
	});
});

void test("AgentMailAdapter.performAction forwards replyTo when sending or replying", async () => {
	const adapter = new AgentMailAdapter("key", "secret");
	let sendArgs: unknown[] | null = null;
	let replyArgs: unknown[] | null = null;

	(adapter as unknown as { client: Record<string, unknown> }).client = {
		inboxes: {
			messages: {
				send: (...args: unknown[]) => {
					sendArgs = args;
					return Promise.resolve({
						messageId: "msg_sent_123",
						threadId: "thread_123",
					});
				},
				reply: (...args: unknown[]) => {
					replyArgs = args;
					return Promise.resolve({
						messageId: "msg_reply_123",
						threadId: "thread_123",
					});
				},
			},
		},
	};

	const resource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});

	await adapter.performAction(resource, "send_email", {
		to: ["customer@example.com"],
		subject: "Hello",
		text: "Body",
		replyTo: ["reply-one@example.com", "reply-two@example.com"],
	});
	await adapter.performAction(resource, "reply_email", {
		message_id: "msg_original_123",
		text: "Reply body",
		reply_recipients: ["customer@example.com"],
		replyTo: ["reply-one@example.com", "reply-two@example.com"],
	});

	assert.ok(sendArgs, "expected AgentMail send to be called");
	assert.deepStrictEqual((sendArgs[1] as Record<string, unknown>).replyTo, [
		"reply-one@example.com",
		"reply-two@example.com",
	]);
	assert.ok(replyArgs, "expected AgentMail reply to be called");
	assert.deepStrictEqual((replyArgs[2] as Record<string, unknown>).replyTo, [
		"reply-one@example.com",
		"reply-two@example.com",
	]);
});

void test("AgentMailAdapter.performAction forwards abort signals to AgentMail requests", async () => {
	const adapter = new AgentMailAdapter("key", "secret");
	const sendController = new AbortController();
	const replyController = new AbortController();
	const getController = new AbortController();
	let sendOptions: unknown;
	let replyOptions: unknown;
	let getOptions: unknown;

	(adapter as unknown as { client: Record<string, unknown> }).client = {
		inboxes: {
			messages: {
				send: (_inboxId: string, _request: unknown, options?: unknown) => {
					sendOptions = options;
					return Promise.resolve({
						messageId: "msg_sent_123",
						threadId: "thread_123",
					});
				},
				reply: (
					_inboxId: string,
					_messageId: string,
					_request: unknown,
					options?: unknown,
				) => {
					replyOptions = options;
					return Promise.resolve({
						messageId: "msg_reply_123",
						threadId: "thread_123",
					});
				},
				get: (_inboxId: string, _messageId: string, options?: unknown) => {
					getOptions = options;
					return Promise.resolve({
						messageId: "msg_original_123",
						threadId: "thread_123",
						inboxId: "agent@mail.example.com",
						labels: [],
						from: "customer@example.com",
						to: ["agent@mail.example.com"],
						cc: [],
						bcc: [],
						subject: "Hello",
						text: "Body",
						html: null,
						replyTo: [],
						size: 1024,
						updatedAt: FIXED_TIMESTAMP,
						createdAt: FIXED_TIMESTAMP,
						timestamp: FIXED_TIMESTAMP,
					});
				},
			},
		},
	};

	const resource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});

	await adapter.performAction(
		resource,
		"send_email",
		{
			to: ["customer@example.com"],
			subject: "Hello",
			text: "Body",
		},
		{ abortSignal: sendController.signal },
	);
	await adapter.performAction(
		resource,
		"reply_email",
		{
			message_id: "msg_original_123",
			text: "Reply body",
			reply_recipients: ["customer@example.com"],
		},
		{ abortSignal: replyController.signal },
	);
	await adapter.performAction(
		resource,
		"get_message",
		{ message_id: "msg_original_123" },
		{ abortSignal: getController.signal },
	);

	assert.deepStrictEqual(sendOptions, { abortSignal: sendController.signal });
	assert.deepStrictEqual(replyOptions, { abortSignal: replyController.signal });
	assert.deepStrictEqual(getOptions, { abortSignal: getController.signal });
});

void test("AgentMailAdapter.performAction tolerates additive AgentMail message fields", async () => {
	const adapter = new AgentMailAdapter("key", "secret");

	(adapter as unknown as { client: Record<string, unknown> }).client = {
		inboxes: {
			messages: {
				get: () =>
					Promise.resolve({
						messageId: "msg_123",
						threadId: "thread_123",
						inboxId: "agent@mail.example.com",
						labels: [],
						from: "sender@example.com",
						to: ["agent@mail.example.com"],
						size: 1024,
						updatedAt: FIXED_TIMESTAMP,
						createdAt: FIXED_TIMESTAMP,
						timestamp: FIXED_TIMESTAMP,
						organizationId: "org_123",
						podId: "pod_123",
						smtpId: "smtp_123",
					}),
			},
		},
	};

	const resource = buildResourceRecord({
		id: "res_email_123",
		providerRef: "agent@mail.example.com",
		providerOrgId: "pod_123",
		config: { email_address: "agent@mail.example.com" },
	});

	const result = await adapter.performAction(resource, "get_message", {
		message_id: "msg_123",
	});

	assert.strictEqual(result.message_id, "msg_123");
	assert.strictEqual(result.thread_id, "thread_123");
	assert.strictEqual(result.organizationId, "org_123");
	assert.strictEqual(result.podId, "pod_123");
	assert.strictEqual(result.smtpId, "smtp_123");
});

void test("AgentMailAdapter.parseWebhook parses the official message.received payload shape", async () => {
	const adapter = new AgentMailAdapter("key", "secret");

	const events = await adapter.parseWebhook(
		Buffer.from(buildReceivedWebhookPayload()),
		{},
	);

	assert.deepStrictEqual(events, [
		{
			resourceRef: "agent@agentmail.to",
			provider: "agentmail",
			providerEventId: "evt_abc123",
			eventType: "email.received",
			occurredAt: FIXED_TIMESTAMP,
			data: {
				message_id: "msg_xyz",
				thread_id: "thread_1",
				from: "sender@example.com",
				to: ["agent@agentmail.to"],
				subject: "Hello",
			},
		},
	]);
});

void test("AgentMailAdapter.parseWebhook parses official outbound lifecycle payload shapes", async () => {
	const adapter = new AgentMailAdapter("key", "secret");

	const cases = [
		{
			name: "sent",
			payload: buildSentWebhookPayload(),
			expected: {
				resourceRef: "agent@agentmail.to",
				provider: "agentmail",
				providerEventId: "evt_sent_123",
				eventType: "email.sent",
				occurredAt: FIXED_TIMESTAMP,
				data: {
					message_id: "msg_sent_123",
					thread_id: "thread_1",
					to: ["user@example.com"],
				},
			},
		},
		{
			name: "delivered",
			payload: buildDeliveredWebhookPayload(),
			expected: {
				resourceRef: "agent@agentmail.to",
				provider: "agentmail",
				providerEventId: "evt_delivered_123",
				eventType: "email.delivered",
				occurredAt: FIXED_TIMESTAMP,
				data: {
					message_id: "msg_delivered_123",
					thread_id: "thread_1",
					to: ["user@example.com"],
				},
			},
		},
		{
			name: "complained",
			payload: buildComplainedWebhookPayload(),
			expected: {
				resourceRef: "agent@agentmail.to",
				provider: "agentmail",
				providerEventId: "evt_complained_123",
				eventType: "email.complained",
				occurredAt: FIXED_TIMESTAMP,
				data: {
					message_id: "msg_complained_123",
					thread_id: "thread_1",
					to: ["user@example.com"],
					reason: "abuse: complaint",
					complaint_type: "abuse",
					complaint_sub_type: "complaint",
				},
			},
		},
		{
			name: "bounced",
			payload: buildBouncedWebhookPayload(),
			expected: {
				resourceRef: "agent@agentmail.to",
				provider: "agentmail",
				providerEventId: "evt_bounced_123",
				eventType: "email.bounced",
				occurredAt: FIXED_TIMESTAMP,
				data: {
					message_id: "msg_bounced_123",
					thread_id: "thread_1",
					to: ["user@example.com"],
					reason: "Permanent: General",
					bounce_type: "Permanent",
					bounce_sub_type: "General",
				},
			},
		},
		{
			name: "rejected",
			payload: buildRejectedWebhookPayload(),
			expected: {
				resourceRef: "agent@agentmail.to",
				provider: "agentmail",
				providerEventId: "evt_rejected_123",
				eventType: "email.rejected",
				occurredAt: FIXED_TIMESTAMP,
				data: {
					message_id: "msg_rejected_123",
					thread_id: "thread_1",
					reason: "Suppressed destination",
				},
			},
		},
	] as const;

	for (const testCase of cases) {
		const events = await adapter.parseWebhook(
			Buffer.from(testCase.payload),
			{},
		);
		assert.deepStrictEqual(events, [testCase.expected], testCase.name);
	}
});

void test("AgentMailAdapter.parseWebhook rejects the old fictional payload shape", async () => {
	const adapter = new AgentMailAdapter("key", "secret");

	const events = await adapter.parseWebhook(
		Buffer.from(buildLegacyWebhookPayload()),
		{},
	);

	assert.deepStrictEqual(events, []);
});

// ---------------------------------------------------------------------------
// Webhook endpoint tests
// ---------------------------------------------------------------------------

void test("POST /webhooks/agentmail returns 401 for missing svix headers", async () => {
	const server = await buildServer();
	const body = buildReceivedWebhookPayload();

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _headers) => Promise.resolve(false),
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers: { "content-type": "application/json" },
			payload: body,
		});

		assert.strictEqual(response.statusCode, 401);
	} finally {
		restoreAdapter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail returns 200 and writes email.received event", async () => {
	const server = await buildServer();
	const bodyStr = buildReceivedWebhookPayload();
	const headers = buildWebhookHeaders(bodyStr);
	const resource = buildResourceRecord();

	const writeEventCalls: unknown[] = [];

	// Mock systemDal.findResourceByProviderRef
	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = (_provider, _providerRef) =>
		Promise.resolve(resource);

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
		parseWebhook: (_rawBody, _hdrs) =>
			Promise.resolve([
				{
					resourceRef: "agent@agentmail.to",
					provider: "agentmail",
					providerEventId: "evt_abc123",
					eventType: "email.received",
					occurredAt: FIXED_TIMESTAMP,
					data: {
						message_id: "msg_xyz",
						thread_id: "thread_1",
						from: "sender@example.com",
						to: ["agent@agentmail.to"],
						subject: "Hello",
					},
				} satisfies ParsedWebhookEvent,
			]),
	});

	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input);
			return Promise.resolve({
				event: buildFakeEventRecord({ eventType: "email.received" }),
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(writeEventCalls.length, 1);

		const input = writeEventCalls[0] as Record<string, unknown>;
		assert.strictEqual(input.eventType, "email.received");
		assert.strictEqual(input.providerEventId, "evt_abc123");

		const data = input.data as Record<string, unknown>;
		assert.strictEqual(data.thread_id, "thread_1");
		assert.strictEqual(data.from, "sender@example.com");
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail ingests official AgentMail payload shapes end to end", async () => {
	const server = await buildServer();
	const resource = buildResourceRecord();
	const adapter = new AgentMailAdapter("key", WEBHOOK_SECRET);
	const writeEventCalls: Array<Record<string, unknown>> = [];

	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = (_provider, _providerRef) =>
		Promise.resolve(resource);

	const restoreAdapter = installAgentMailAdapterMock(server, adapter);
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input as Record<string, unknown>);
			return Promise.resolve({
				event: buildFakeEventRecord({
					eventType: input.eventType,
					providerEventId: input.providerEventId ?? null,
					data: input.data as Record<string, unknown>,
				}),
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	const cases = [
		{
			payload: buildReceivedWebhookPayload(),
			eventType: "email.received",
			providerEventId: "evt_abc123",
			data: {
				message_id: "msg_xyz",
				thread_id: "thread_1",
				from: "sender@example.com",
				to: ["agent@agentmail.to"],
				subject: "Hello",
			},
		},
		{
			payload: buildSentWebhookPayload(),
			eventType: "email.sent",
			providerEventId: "evt_sent_123",
			data: {
				message_id: "msg_sent_123",
				thread_id: "thread_1",
				to: ["user@example.com"],
			},
		},
		{
			payload: buildDeliveredWebhookPayload(),
			eventType: "email.delivered",
			providerEventId: "evt_delivered_123",
			data: {
				message_id: "msg_delivered_123",
				thread_id: "thread_1",
				to: ["user@example.com"],
			},
		},
		{
			payload: buildComplainedWebhookPayload(),
			eventType: "email.complained",
			providerEventId: "evt_complained_123",
			data: {
				message_id: "msg_complained_123",
				thread_id: "thread_1",
				to: ["user@example.com"],
				reason: "abuse: complaint",
				complaint_type: "abuse",
				complaint_sub_type: "complaint",
			},
		},
		{
			payload: buildBouncedWebhookPayload(),
			eventType: "email.bounced",
			providerEventId: "evt_bounced_123",
			data: {
				message_id: "msg_bounced_123",
				thread_id: "thread_1",
				to: ["user@example.com"],
				reason: "Permanent: General",
				bounce_type: "Permanent",
				bounce_sub_type: "General",
			},
		},
		{
			payload: buildRejectedWebhookPayload(),
			eventType: "email.rejected",
			providerEventId: "evt_rejected_123",
			data: {
				message_id: "msg_rejected_123",
				thread_id: "thread_1",
				reason: "Suppressed destination",
			},
		},
	] as const;

	try {
		for (const testCase of cases) {
			writeEventCalls.length = 0;

			const response = await server.inject({
				method: "POST",
				url: "/webhooks/agentmail",
				headers: buildWebhookHeaders(testCase.payload),
				payload: testCase.payload,
			});

			assert.strictEqual(response.statusCode, 200, testCase.eventType);
			assert.strictEqual(writeEventCalls.length, 1, testCase.eventType);
			assert.strictEqual(
				writeEventCalls[0].eventType,
				testCase.eventType,
				testCase.eventType,
			);
			assert.strictEqual(
				writeEventCalls[0].providerEventId,
				testCase.providerEventId,
				testCase.eventType,
			);
			assert.deepStrictEqual(
				writeEventCalls[0].data as Record<string, unknown>,
				testCase.data,
				testCase.eventType,
			);
		}
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail accepts webhook-* signature headers", async () => {
	const server = await buildServer();
	const resource = buildResourceRecord();
	const adapter = new AgentMailAdapter("key", WEBHOOK_SECRET);
	const payload = buildReceivedWebhookPayload();
	const writeEventCalls: Array<Record<string, unknown>> = [];

	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = (_provider, _providerRef) =>
		Promise.resolve(resource);

	const restoreAdapter = installAgentMailAdapterMock(server, adapter);
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input as Record<string, unknown>);
			return Promise.resolve({
				event: buildFakeEventRecord({
					eventType: input.eventType,
					providerEventId: input.providerEventId ?? null,
					data: input.data as Record<string, unknown>,
				}),
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers: buildWebhookAliasHeaders(payload),
			payload,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(writeEventCalls.length, 1);
		assert.strictEqual(writeEventCalls[0].eventType, "email.received");
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail ignores the old fictional payload shape", async () => {
	const server = await buildServer();
	const adapter = new AgentMailAdapter("key", WEBHOOK_SECRET);
	const writeEventCalls: Array<Record<string, unknown>> = [];
	const legacyPayload = buildLegacyWebhookPayload();

	const restoreAdapter = installAgentMailAdapterMock(server, adapter);
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input as Record<string, unknown>);
			return Promise.resolve({
				event: buildFakeEventRecord({
					eventType: input.eventType,
					providerEventId: input.providerEventId ?? null,
					data: input.data as Record<string, unknown>,
				}),
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers: buildWebhookHeaders(legacyPayload),
			payload: legacyPayload,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(writeEventCalls.length, 0);
	} finally {
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail returns 200 for unknown event_type (silently skips)", async () => {
	const server = await buildServer();
	const bodyStr = buildReceivedWebhookPayload({
		event_type: "message.unknown_event",
	});
	const headers = buildWebhookHeaders(bodyStr);

	const writeEventCalls: unknown[] = [];

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
		parseWebhook: (_rawBody, _hdrs) => Promise.resolve([]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: (input) => {
			writeEventCalls.push(input);
			return Promise.resolve({
				event: buildFakeEventRecord(),
				wasCreated: true,
			} as WriteEventResult);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(writeEventCalls.length, 0);
	} finally {
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail deduplication: second call with same event_id → wasCreated false", async () => {
	const server = await buildServer();
	const bodyStr = buildReceivedWebhookPayload();
	const headers = buildWebhookHeaders(bodyStr);
	const resource = buildResourceRecord();

	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = (_provider, _providerRef) =>
		Promise.resolve(resource);

	const results = [
		{ event: buildFakeEventRecord(), wasCreated: true },
		{ event: buildFakeEventRecord(), wasCreated: false },
	];
	let callCount = 0;

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
		parseWebhook: (_rawBody, _hdrs) =>
			Promise.resolve([
				{
					resourceRef: "agent@agentmail.to",
					provider: "agentmail",
					providerEventId: "evt_abc123",
					eventType: "email.received",
					occurredAt: FIXED_TIMESTAMP,
					data: { message_id: "msg_xyz" },
				} satisfies ParsedWebhookEvent,
			]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			const result = results[callCount] ?? results[results.length - 1];
			callCount += 1;
			return Promise.resolve(result as WriteEventResult);
		},
	});

	try {
		const r1 = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});
		const r2 = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});

		assert.strictEqual(r1.statusCode, 200);
		assert.strictEqual(r2.statusCode, 200);
		assert.strictEqual(callCount, 2);
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail returns 200 when a verified webhook cannot be matched to a resource", async () => {
	const server = await buildServer();
	const bodyStr = buildReceivedWebhookPayload();
	const headers = buildWebhookHeaders(bodyStr);
	let writeEventCalls = 0;

	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = () => Promise.resolve(null);

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
		parseWebhook: (_rawBody, _hdrs) =>
			Promise.resolve([
				{
					resourceRef: "agent@agentmail.to",
					provider: "agentmail",
					providerEventId: "evt_missing_resource",
					eventType: "email.received",
					occurredAt: FIXED_TIMESTAMP,
					data: { message_id: "msg_xyz", from: "sender@example.com" },
				} satisfies ParsedWebhookEvent,
			]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			return Promise.reject(
				new Error("writeEvent should not be called for unmatched webhooks"),
			);
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});

		assert.strictEqual(response.statusCode, 200);
		assert.deepStrictEqual(response.json(), { ok: true });
		assert.strictEqual(writeEventCalls, 0);
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

void test("POST /webhooks/agentmail returns 500 when persistence fails after verification", async () => {
	const server = await buildServer();
	const bodyStr = buildReceivedWebhookPayload();
	const headers = buildWebhookHeaders(bodyStr);
	const resource = buildResourceRecord();
	let writeEventCalls = 0;

	const originalFind = systemDal.findResourceByProviderRef.bind(systemDal);
	systemDal.findResourceByProviderRef = (_provider, _providerRef) =>
		Promise.resolve(resource);

	const restoreAdapter = installAgentMailAdapterMock(server, {
		verifyWebhook: (_rawBody, _hdrs) => Promise.resolve(true),
		parseWebhook: (_rawBody, _hdrs) =>
			Promise.resolve([
				{
					resourceRef: "agent@agentmail.to",
					provider: "agentmail",
					providerEventId: "evt_abc123",
					eventType: "email.received",
					occurredAt: FIXED_TIMESTAMP,
					data: { message_id: "msg_xyz", from: "sender@example.com" },
				} satisfies ParsedWebhookEvent,
			]),
	});
	const restoreWriter = installEventWriterMock(server, {
		writeEvent: () => {
			writeEventCalls += 1;
			return Promise.reject(new Error("forced webhook write failure"));
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/webhooks/agentmail",
			headers,
			payload: bodyStr,
		});

		assert.strictEqual(response.statusCode, 500);
		assert.deepStrictEqual(response.json(), {
			message: "Webhook processing failed",
		});
		assert.strictEqual(writeEventCalls, 1);
	} finally {
		systemDal.findResourceByProviderRef = originalFind;
		restoreAdapter();
		restoreWriter();
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// In-flight action safety tests
// ---------------------------------------------------------------------------

void test("POST /agents/:id/actions/send_email returns 409 for a stale dispatching action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	let performActionCalls = 0;
	const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

	const requestHash = buildSendEmailRequestHash(resource, {
		to: ["user@example.com"],
		subject: "Hi",
		text: "Hello",
	});

	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(resource),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const outboundActions = createMemoryOutboundActionsDal({
		initialAction: buildOutboundActionRecord({
			state: "dispatching",
			idempotencyKey: "idem-stale-dispatching",
			requestHash,
			requestData: { to: ["user@example.com"], subject: "Hi", text: "Hello" },
			updatedAt: staleTime,
		}),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdvisoryLock = installAdvisoryLockMock(server);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_reclaimed",
				thread_id: "thread_reclaimed",
			});
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-stale-dispatching",
			},
		});

		// Stale dispatching actions must NOT be retried — the email may already have been sent
		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message:
				"A previous email attempt may already have been dispatched for this idempotency key",
		});
		assert.strictEqual(performActionCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdvisoryLock();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 for a recent dispatching action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	let performActionCalls = 0;
	const recentTime = new Date(Date.now() - 30 * 1000); // 30 seconds ago (within 5-min threshold)

	const requestHash = buildSendEmailRequestHash(resource, {
		to: ["user@example.com"],
		subject: "Hi",
		text: "Hello",
	});

	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(resource),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const outboundActions = createMemoryOutboundActionsDal({
		initialAction: buildOutboundActionRecord({
			state: "dispatching",
			idempotencyKey: "idem-recent-dispatching",
			requestHash,
			requestData: { to: ["user@example.com"], subject: "Hi", text: "Hello" },
			updatedAt: recentTime,
		}),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdvisoryLock = installAdvisoryLockMock(server);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_reclaimed",
				thread_id: "thread_reclaimed",
			});
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-recent-dispatching",
			},
		});

		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message:
				"A previous email attempt may already have been dispatched for this idempotency key",
		});
		assert.strictEqual(performActionCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdvisoryLock();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 for a stale ambiguous action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();
	const staleTime = new Date(Date.now() - 40 * 60 * 1000); // 40 minutes ago

	let performActionCalls = 0;

	const requestHash = buildSendEmailRequestHash(resource, {
		to: ["user@example.com"],
		subject: "Hi",
		text: "Hello",
	});

	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(resource),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const outboundActions = createMemoryOutboundActionsDal({
		initialAction: buildOutboundActionRecord({
			state: "ambiguous",
			idempotencyKey: "idem-stale-ambiguous",
			requestHash,
			requestData: { to: ["user@example.com"], subject: "Hi", text: "Hello" },
			updatedAt: staleTime,
		}),
	});
	const restoreOutboundActions = installOutboundActionsDalMock(
		outboundActions.methods,
	);
	const restoreAdvisoryLock = installAdvisoryLockMock(server);
	const restoreAdapter = installAgentMailAdapterMock(server, {
		performAction: () => {
			performActionCalls += 1;
			return Promise.resolve({
				message_id: "msg_retried",
				thread_id: "thread_retried",
			});
		},
	});

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-stale-ambiguous",
			},
		});

		// Stale ambiguous actions must NOT be retried — the email may already have been sent
		assert.strictEqual(response.statusCode, 409);
		assert.deepStrictEqual(response.json(), {
			message:
				"A previous email attempt may already have been dispatched for this idempotency key",
		});
		assert.strictEqual(performActionCalls, 0);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdvisoryLock();
		restoreAdapter();
		await server.close();
	}
});

void test("POST /agents/:id/actions/send_email returns 409 for a recent dispatching action", async () => {
	const server = await buildServer();
	const { authorizationHeader, restore } = await installAuthApiKey(server);
	const agent = buildAgentRecord();
	const resource = buildResourceRecord();

	const requestHash = buildSendEmailRequestHash(resource, {
		to: ["user@example.com"],
		subject: "Hi",
		text: "Hello",
	});

	const restoreAgents = installAgentsDalMock({
		findById: () => Promise.resolve(agent),
	});
	const restoreResources = installResourcesDalMock({
		findActiveByAgentIdAndType: () => Promise.resolve(resource),
	});
	const restoreEvents = installEventsDalMock({
		findById: () => Promise.resolve(null),
		findByIdempotencyKey: () => Promise.resolve(null),
	});
	const restoreOutboundActions = installOutboundActionsDalMock({
		findByIdempotencyKey: () =>
			Promise.resolve(
				buildOutboundActionRecord({
					state: "dispatching",
					idempotencyKey: "idem-recent-dispatching",
					requestHash,
					requestData: {
						to: ["user@example.com"],
						subject: "Hi",
						text: "Hello",
					},
					updatedAt: new Date(), // Just now — not stale
				}),
			),
	});
	const restoreAdvisoryLock = installAdvisoryLockMock(server);

	try {
		const response = await server.inject({
			method: "POST",
			url: "/agents/agt_123/actions/send_email",
			headers: { authorization: authorizationHeader },
			payload: {
				to: ["user@example.com"],
				subject: "Hi",
				text: "Hello",
				idempotency_key: "idem-recent-dispatching",
			},
		});

		assert.strictEqual(response.statusCode, 409);
	} finally {
		restore();
		restoreAgents();
		restoreResources();
		restoreEvents();
		restoreOutboundActions();
		restoreAdvisoryLock();
		await server.close();
	}
});
