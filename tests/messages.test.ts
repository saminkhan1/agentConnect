import assert from 'node:assert';
import test from 'node:test';

import { AgentMailError } from 'agentmail';

import { buildServer } from '../src/api/server';
import {
  FIXED_TIMESTAMP,
  buildAgentRecord,
  buildResourceRecord,
  installAgentMailAdapterMock,
  installAgentsDalMock,
  installAuthApiKey,
  installResourcesDalMock,
} from './helpers';

type MessageResponse = {
  message_id: string;
  thread_id: string;
  from: string;
  labels: string[];
  timestamp: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string | null;
  preview: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, unknown>;
  in_reply_to: string | null;
  references: string[];
  size: number | null;
  created_at: string | null;
  updated_at: string | null;
};

// ---------------------------------------------------------------------------
// Tests — GET /agents/:id/messages/:messageId
// ---------------------------------------------------------------------------

void test('GET /agents/:id/messages/:messageId returns 200 with full message', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: (_resource, _action, _params) =>
      Promise.resolve({
        message_id: 'msg_001',
        thread_id: 'thread_001',
        from: 'sender@example.com',
        labels: ['received', 'unread'],
        timestamp: FIXED_TIMESTAMP.toISOString(),
        to: ['agent@agentmail.to'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        reply_to: ['replyto@example.com'],
        subject: 'Test subject',
        preview: 'Preview text',
        text: 'Plain text body',
        html: '<p>HTML body</p>',
        headers: { 'Reply-To': 'replyto@example.com' },
        in_reply_to: 'msg_parent_001',
        references: ['msg_parent_001'],
        size: 2048,
        created_at: FIXED_TIMESTAMP.toISOString(),
        updated_at: FIXED_TIMESTAMP.toISOString(),
      }),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_001',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = response.json<MessageResponse>();
    assert.strictEqual(body.message_id, 'msg_001');
    assert.strictEqual(body.thread_id, 'thread_001');
    assert.strictEqual(body.from, 'sender@example.com');
    assert.deepStrictEqual(body.labels, ['received', 'unread']);
    assert.strictEqual(body.timestamp, FIXED_TIMESTAMP.toISOString());
    assert.deepStrictEqual(body.to, ['agent@agentmail.to']);
    assert.deepStrictEqual(body.cc, ['cc@example.com']);
    assert.deepStrictEqual(body.bcc, ['bcc@example.com']);
    assert.deepStrictEqual(body.reply_to, ['replyto@example.com']);
    assert.strictEqual(body.subject, 'Test subject');
    assert.strictEqual(body.preview, 'Preview text');
    assert.strictEqual(body.text, 'Plain text body');
    assert.strictEqual(body.html, '<p>HTML body</p>');
    assert.deepStrictEqual(body.headers, { 'Reply-To': 'replyto@example.com' });
    assert.strictEqual(body.in_reply_to, 'msg_parent_001');
    assert.deepStrictEqual(body.references, ['msg_parent_001']);
    assert.strictEqual(body.size, 2048);
    assert.strictEqual(body.created_at, FIXED_TIMESTAMP.toISOString());
    assert.strictEqual(body.updated_at, FIXED_TIMESTAMP.toISOString());
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreAdapter();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId returns 200 with nulls/empty arrays for missing optional fields', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: (_resource, _action, _params) =>
      Promise.resolve({
        message_id: 'msg_002',
        thread_id: 'thread_002',
        from: 'sender@example.com',
      }),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_002',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = response.json<MessageResponse>();
    assert.strictEqual(body.message_id, 'msg_002');
    assert.strictEqual(body.thread_id, 'thread_002');
    assert.strictEqual(body.from, 'sender@example.com');
    assert.deepStrictEqual(body.labels, []);
    assert.strictEqual(body.timestamp, null);
    assert.deepStrictEqual(body.to, []);
    assert.deepStrictEqual(body.cc, []);
    assert.deepStrictEqual(body.bcc, []);
    assert.deepStrictEqual(body.reply_to, []);
    assert.strictEqual(body.subject, null);
    assert.strictEqual(body.preview, null);
    assert.strictEqual(body.text, null);
    assert.strictEqual(body.html, null);
    assert.deepStrictEqual(body.headers, {});
    assert.strictEqual(body.in_reply_to, null);
    assert.deepStrictEqual(body.references, []);
    assert.strictEqual(body.size, null);
    assert.strictEqual(body.created_at, null);
    assert.strictEqual(body.updated_at, null);
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreAdapter();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId normalizes formatted from addresses', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: (_resource, _action, _params) =>
      Promise.resolve({
        message_id: 'msg_003',
        thread_id: 'thread_003',
        from: 'AgentMail <gleamingcrowd538@agentmail.to>',
      }),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_003',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = response.json<MessageResponse>();
    assert.strictEqual(body.from, 'gleamingcrowd538@agentmail.to');
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreAdapter();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId normalizes malformed adapter response defensively', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  // Adapter returns falsy/missing required string fields, non-array for array fields,
  // and non-string values for optional string fields. The route normalization handles
  // these: falsy values → '' via `|| ''`, non-arrays → [] via normalizeStringArray,
  // non-strings → null via `typeof === 'string'` checks.
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: (_resource, _action, _params) =>
      Promise.resolve({
        message_id: '', // empty string (falsy) → falls through to ''
        thread_id: null, // null (falsy) → ''
        from: undefined, // undefined (falsy) → ''
        labels: ['valid-label', 123], // mixed array → filters to strings only
        timestamp: 42, // number instead of string → null
        to: 'not-an-array', // string instead of array → []
        cc: [123, 'valid@example.com', null], // mixed array → filters to strings only
        subject: 42, // number instead of string → null
        preview: ['wrong'], // non-string → null
        text: { nested: 'object' }, // object instead of string → null
        html: true, // boolean instead of string → null
        headers: 'not-a-record', // non-object → {}
        in_reply_to: false, // non-string → null
        references: [null, 'msg_ref_1', 42], // mixed array → filters to strings only
        size: 'large', // non-number → null
        created_at: new Date(), // non-string → null
        updated_at: 0, // non-string → null
      } as unknown as Record<string, unknown>),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_bad',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = response.json<MessageResponse>();
    // Falsy values for message_id/thread_id/from → empty string fallback
    assert.strictEqual(body.message_id, '');
    assert.strictEqual(body.thread_id, '');
    assert.strictEqual(body.from, '');
    assert.deepStrictEqual(body.labels, ['valid-label']);
    assert.strictEqual(body.timestamp, null);
    // Non-array → empty array
    assert.deepStrictEqual(body.to, []);
    // Mixed array → filters to only string entries
    assert.deepStrictEqual(body.cc, ['valid@example.com']);
    assert.deepStrictEqual(body.bcc, []);
    assert.deepStrictEqual(body.reply_to, []);
    // Non-string optional fields → null
    assert.strictEqual(body.subject, null);
    assert.strictEqual(body.preview, null);
    assert.strictEqual(body.text, null);
    assert.strictEqual(body.html, null);
    assert.deepStrictEqual(body.headers, {});
    assert.strictEqual(body.in_reply_to, null);
    assert.deepStrictEqual(body.references, ['msg_ref_1']);
    assert.strictEqual(body.size, null);
    assert.strictEqual(body.created_at, null);
    assert.strictEqual(body.updated_at, null);
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreAdapter();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId returns 404 when the agent is missing or archived', async () => {
  const agentCases = [
    { name: 'missing', agent: null, url: '/agents/agt_nonexistent/messages/msg_001' },
    {
      name: 'archived',
      agent: buildAgentRecord({ isArchived: true }),
      url: '/agents/agt_123/messages/msg_001',
    },
  ] as const;

  for (const testCase of agentCases) {
    const server = await buildServer();
    const { authorizationHeader, restore } = await installAuthApiKey(server);
    const restoreAgents = installAgentsDalMock({
      findById: (_id) => Promise.resolve(testCase.agent),
    });
    const restoreResources = installResourcesDalMock({
      findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(null),
    });

    try {
      const response = await server.inject({
        method: 'GET',
        url: testCase.url,
        headers: { authorization: authorizationHeader },
      });

      assert.strictEqual(response.statusCode, 404, testCase.name);
      const body = JSON.parse(response.payload) as { message: string };
      assert.strictEqual(body.message, 'Agent not found', testCase.name);
    } finally {
      restore();
      restoreAgents();
      restoreResources();
      await server.close();
    }
  }
});

void test('GET /agents/:id/messages/:messageId returns 404 when no email resource', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(null),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_001',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 404);
    const body = JSON.parse(response.payload) as { message: string };
    assert.strictEqual(body.message, 'No active agentmail email inbox found for agent');
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId returns 500 when adapter not configured', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });

  // Remove the adapter to simulate it not being configured
  const original = server.agentMailAdapter;
  server.agentMailAdapter = undefined;

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_001',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 500);
    const body = JSON.parse(response.payload) as { message: string };
    assert.strictEqual(body.message, 'AgentMail adapter not configured');
  } finally {
    server.agentMailAdapter = original;
    restore();
    restoreAgents();
    restoreResources();
    await server.close();
  }
});

void test('GET /agents/:id/messages/:messageId propagates AgentMailError 4xx status', async () => {
  const server = await buildServer();
  const { authorizationHeader, restore } = await installAuthApiKey(server);
  const agent = buildAgentRecord();
  const resource = buildResourceRecord();

  const restoreAgents = installAgentsDalMock({ findById: (_id) => Promise.resolve(agent) });
  const restoreResources = installResourcesDalMock({
    findActiveByAgentIdAndType: (_agentId, _type, _provider) => Promise.resolve(resource),
  });
  const restoreAdapter = installAgentMailAdapterMock(server, {
    performAction: () =>
      Promise.reject(
        new AgentMailError({
          message: 'NotFound',
          statusCode: 404,
          body: { message: 'Message not found' },
        }),
      ),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/agents/agt_123/messages/msg_missing',
      headers: { authorization: authorizationHeader },
    });

    assert.strictEqual(response.statusCode, 404);
    assert.deepStrictEqual(response.json(), { message: 'Message not found' });
  } finally {
    restore();
    restoreAgents();
    restoreResources();
    restoreAdapter();
    await server.close();
  }
});
