import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArgumentsHost } from '@nestjs/common';
import { RuntimeModelErrorSchema } from '@cap/contracts';
import { RuntimeModelPreflightError } from './runtime-model-preflight.error';
import { RuntimeModelHttpExceptionFilter } from './runtime-model-http.filter';

function responseHarness() {
  const headers = new Map<string, string>();
  let statusCode = 0;
  let body: unknown;
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    status(value: number) {
      statusCode = value;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, headers, status: () => statusCode, body: () => body };
}

test('REST maps unavailable selectors to 422 with the canonical safe body', () => {
  const error = RuntimeModelErrorSchema.parse({
    code: 'runtime_model_not_available',
    message: 'The requested runtime model is not available.',
    retryable: false,
  });
  const harness = responseHarness();
  new RuntimeModelHttpExceptionFilter().catch(
    new RuntimeModelPreflightError(error),
    harness.host,
  );
  assert.equal(harness.status(), 422);
  assert.deepEqual(harness.body(), error);
});

test('REST maps catalog capacity to 503 plus a bounded Retry-After', () => {
  const error = RuntimeModelErrorSchema.parse({
    code: 'runtime_model_catalog_unavailable',
    message: 'Runtime model catalog is temporarily unavailable.',
    retryable: true,
    capacity: { scope: 'owner', retryAfterMs: 1_501 },
  });
  const harness = responseHarness();
  new RuntimeModelHttpExceptionFilter().catch(
    new RuntimeModelPreflightError(error),
    harness.host,
  );
  assert.equal(harness.status(), 503);
  assert.equal(harness.headers.get('Retry-After'), '2');
  assert.deepEqual(harness.body(), error);
});
