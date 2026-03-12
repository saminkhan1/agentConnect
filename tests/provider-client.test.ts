import assert from 'node:assert';
import test from 'node:test';

import { withTimeout } from '../src/adapters/provider-client';
import { AppError } from '../src/domain/errors';

void test('withTimeout returns the callback value when it resolves before timeout', async () => {
  const result = await withTimeout(() => Promise.resolve('ok'), 50);
  assert.strictEqual(result, 'ok');
});

void test('withTimeout enforces deadline even when callback ignores AbortSignal', async () => {
  await assert.rejects(
    withTimeout(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      return 'late';
    }, 10),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.strictEqual(error.code, 'ADAPTER_TIMEOUT');
      assert.strictEqual(error.httpStatus, 504);
      return true;
    },
  );
});

void test('withTimeout surfaces timeout when callback aborts on signal', async () => {
  await assert.rejects(
    withTimeout(
      async (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      10,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.strictEqual(error.code, 'ADAPTER_TIMEOUT');
      return true;
    },
  );
});

void test('withTimeout preserves non-timeout callback failures', async () => {
  await assert.rejects(
    withTimeout(() => Promise.reject(new Error('boom')), 50),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, 'boom');
      return true;
    },
  );
});
