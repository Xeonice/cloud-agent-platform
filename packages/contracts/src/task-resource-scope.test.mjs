/**
 * Schema round-trip for the per-task resource `scope` + dual (process/container)
 * reading (task-codex-process-metrics, task 2.2). Drives the REAL compiled zod
 * schemas from dist/. Guards: a `process`-scope reading carries the primary codex
 * figure + a background container reading; a `container`-scope (fallback) reading
 * carries the container figure + null background; `not-running` still parses; and
 * the aggregate `/metrics` block (container samples) is unaffected.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node task-resource-scope.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { TaskResourceResponseSchema, MetricsResponseSchema } = require(
  path.join(here, '..', 'dist', 'metrics.js'),
);

const sample = (cpu, memMB) => ({
  taskId: '11111111-1111-4111-8111-111111111111',
  cpuPercent: cpu,
  memoryBytes: memMB * 1024 * 1024,
  memoryLimitBytes: 8 * 1024 * 1024 * 1024,
  memoryPercent: (memMB * 1024 * 1024) / (8 * 1024 * 1024 * 1024) * 100,
});

test('process-scope reading carries the codex primary + container background', () => {
  const parsed = TaskResourceResponseSchema.parse({
    state: 'sampled',
    scope: 'process',
    sample: sample(2.4, 126), // codex process subtree
    container: sample(2.3, 1500), // container aggregate (background)
    sampledAt: new Date().toISOString(),
    ageMs: 1300,
  });
  assert.equal(parsed.scope, 'process');
  assert.equal(parsed.sample.memoryBytes, 126 * 1024 * 1024, 'primary is codex RSS');
  assert.ok(parsed.container, 'container background present');
  assert.equal(parsed.container.memoryBytes, 1500 * 1024 * 1024, 'background is the container total');
});

test('container-scope fallback carries the container figure + null background', () => {
  const parsed = TaskResourceResponseSchema.parse({
    state: 'sampled',
    scope: 'container',
    sample: sample(2.3, 1500),
    container: null,
    sampledAt: new Date().toISOString(),
    ageMs: 1300,
  });
  assert.equal(parsed.scope, 'container');
  assert.equal(parsed.container, null, 'no duplicate background in container scope');
});

test('not-running still parses', () => {
  const parsed = TaskResourceResponseSchema.parse({ state: 'not-running' });
  assert.equal(parsed.state, 'not-running');
});

test('an invalid scope is rejected', () => {
  assert.throws(() =>
    TaskResourceResponseSchema.parse({
      state: 'sampled',
      scope: 'host',
      sample: sample(1, 1),
      container: null,
      sampledAt: null,
      ageMs: null,
    }),
  );
});

test('aggregate MetricsResponse (container samples) is unaffected by the scope addition', () => {
  const parsed = MetricsResponseSchema.parse({
    capacity: { ceiling: 5, active: 1, free: 4, queueDepth: 0 },
    occupancy: { slots: [], queuedTaskIds: [] },
    runnerMinutes: { available: false, minutes: null },
    resources: {
      status: 'available',
      sampledAt: new Date().toISOString(),
      ageMs: 0,
      hasActiveContainers: true,
      containers: [sample(2.3, 1500)],
      aggregateCpuPercent: 2.3,
      aggregateMemoryBytes: 1500 * 1024 * 1024,
    },
  });
  assert.equal(parsed.resources.containers.length, 1, 'aggregate container block unchanged');
});
