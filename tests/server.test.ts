import test from 'node:test';
import assert from 'node:assert';
import { buildServer } from '../src/api/server';

test('health endpoint returns ok', async (t) => {
    const server = await buildServer();

    const response = await server.inject({
        method: 'GET',
        url: '/health',
    });

    assert.strictEqual(response.statusCode, 200);
    const payload = JSON.parse(response.payload);
    assert.strictEqual(payload.status, 'ok');
    assert.ok(payload.timestamp);
});

test('subsequent requests include x-correlation-id', async (t) => {
    const server = await buildServer();

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
});
