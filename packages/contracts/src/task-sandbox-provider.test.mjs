/**
 * Schema round-trip for the public task sandbox-provider summary
 * (surface-task-sandbox-provider-label). Drives the REAL compiled zod schemas
 * from dist/ so api + web stay on the same response contract.
 *
 * Requires `pnpm --filter @cap/contracts build` first.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  ListTasksResponseSchema,
  TaskResponseSchema,
  TaskSandboxProviderSchema,
  sandboxProviderLabel,
} = require(path.join(here, '..', 'dist', 'task.js'));

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  repoId: '22222222-2222-4222-8222-222222222222',
  prompt: 'p',
  status: 'running',
  createdAt: new Date().toISOString(),
  branch: null,
  strategy: null,
  skills: [],
};

test('TaskSandboxProviderSchema accepts only the public id and label summary', () => {
  const parsed = TaskSandboxProviderSchema.parse({
    id: 'boxlite',
    label: 'BoxLite Sandbox',
    providerSandboxId: 'box-1',
    connectionJson: { baseUrl: 'http://internal' },
  });
  assert.deepEqual(parsed, { id: 'boxlite', label: 'BoxLite Sandbox' });
});

test('TaskResponse accepts a BoxLite sandbox provider summary', () => {
  const parsed = TaskResponseSchema.parse({
    ...baseRow,
    sandboxProvider: { id: 'boxlite', label: sandboxProviderLabel('boxlite') },
    providerSandboxId: 'box-1',
    connectionJson: { baseUrl: 'http://internal' },
    endpointUrl: 'http://internal',
    nativeTerminalUrl: 'ws://internal',
    token: 'secret',
    metadata: { provider: 'boxlite' },
  });
  assert.deepEqual(parsed.sandboxProvider, {
    id: 'boxlite',
    label: 'BoxLite Sandbox',
  });
  for (const key of [
    'providerSandboxId',
    'connectionJson',
    'endpointUrl',
    'nativeTerminalUrl',
    'token',
    'metadata',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, key),
      false,
      `${key} is not public`,
    );
  }
});

test('TaskResponse accepts an AIO sandbox provider summary', () => {
  const parsed = TaskResponseSchema.parse({
    ...baseRow,
    sandboxProvider: { id: 'aio-local', label: sandboxProviderLabel('aio-local') },
  });
  assert.deepEqual(parsed.sandboxProvider, {
    id: 'aio-local',
    label: 'AIO Sandbox',
  });
});

test('TaskResponse accepts null or absent sandboxProvider without fabricating AIO', () => {
  const explicitNull = TaskResponseSchema.parse({
    ...baseRow,
    sandboxProvider: null,
  });
  assert.equal(explicitNull.sandboxProvider, null);

  const absent = TaskResponseSchema.parse(baseRow);
  assert.equal(absent.sandboxProvider, undefined);
});

test('unknown sandbox provider ids get a neutral public label', () => {
  assert.equal(sandboxProviderLabel('future-provider'), 'Sandbox Provider');
  const parsed = TaskResponseSchema.parse({
    ...baseRow,
    sandboxProvider: {
      id: 'future-provider',
      label: sandboxProviderLabel('future-provider'),
    },
  });
  assert.deepEqual(parsed.sandboxProvider, {
    id: 'future-provider',
    label: 'Sandbox Provider',
  });
});

test('ListTasksResponseSchema uses the enriched TaskResponse shape', () => {
  const parsed = ListTasksResponseSchema.parse([
    {
      ...baseRow,
      sandboxProvider: { id: 'boxlite', label: 'BoxLite Sandbox' },
    },
  ]);
  assert.deepEqual(parsed[0].sandboxProvider, {
    id: 'boxlite',
    label: 'BoxLite Sandbox',
  });
});
