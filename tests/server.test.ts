import assert from 'node:assert';
import test from 'node:test';
import { z } from 'zod';

import { buildServer } from '../src/api/server';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.iso.datetime(),
});

void test('health endpoint returns ok', async () => {
  const server = await buildServer();
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    assert.strictEqual(response.statusCode, 200);
    const rawPayload: unknown = JSON.parse(response.payload);
    const payload = healthResponseSchema.parse(rawPayload);
    assert.strictEqual(payload.status, 'ok');
    assert.ok(payload.timestamp);
  } finally {
    await server.close();
  }
});

void test('subsequent requests include x-correlation-id', async () => {
  const server = await buildServer();
  try {
    const response1 = await server.inject({
      method: 'GET',
      url: '/health',
    });

    const correlationId1 = response1.headers['x-correlation-id'];
    assert.ok(correlationId1);

    const response2 = await server.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-correlation-id': 'my-custom-id',
      },
    });

    const correlationId2 = response2.headers['x-correlation-id'];
    assert.strictEqual(correlationId2, 'my-custom-id');
  } finally {
    await server.close();
  }
});
