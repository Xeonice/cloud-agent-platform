/**
 * Unit test for the per-task resource read (console-task-metrics-and-navigation,
 * task 1.4). Drives the REAL compiled MetricsService.buildTaskResource from
 * dist/ against a fake ResourceSamplerService snapshot — NO live docker.
 *
 * Scenarios:
 *   - a task WITH a live sampled container → state 'sampled' carrying that
 *     container's sample + the snapshot's sampledAt/ageMs;
 *   - a task with NO live container → state 'not-running' (NOT an error, NOT
 *     fabricated zeros);
 *   - the read filters by taskId (returns THIS task's sample, not another's);
 *   - (console-design-pixel-merge) ONE /metrics poll carries the equivalent
 *     per-task data (same snapshot, same scope semantics) the per-task fan-out
 *     would return, with running-but-unsampled tasks omitted, never zeroed.
 *
 * (The 401 auth-gate is enforced by the global APP_GUARD before the controller
 * handler runs — same as GET /metrics — so it is covered by the existing auth
 * guard tests, not re-driven here.)
 *
 * Requires `pnpm --filter @cap/api build` (+ @cap/contracts build) first.
 * Run: `node task-resource.test.mjs`.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/metrics');

const { MetricsService } = require(path.join(DIST, 'metrics.service.js'));

const PROC = {
  taskId: 'task-abc',
  cpuPercent: 5.0,
  memoryBytes: 126_000_000, // codex process RSS (~126MB)
  memoryLimitBytes: 8_000_000_000,
  memoryPercent: 1.58,
};
const CONTAINER = {
  taskId: 'task-abc',
  cpuPercent: 2.3,
  memoryBytes: 1_500_000_000, // whole-container total (~1.5GB)
  memoryLimitBytes: 8_000_000_000,
  memoryPercent: 18.75,
};

/**
 * Fake sampler exposing `taskReading(taskId)` (the seam buildTaskResource now
 * uses). buildTaskResource is a thin mapper of this reading → the contract
 * response; the scope-selection / carry-forward logic lives in the real sampler
 * (covered by resource-sampler-process.test.mjs).
 */
function makeSampler(readingByTask) {
  return {
    taskReading(taskId) {
      return readingByTask[taskId] ?? null;
    },
  };
}

// guardrails is unused by buildTaskResource; pass a minimal stub.
const guardrailsStub = {};

test('process-scope reading maps to a sampled response (codex primary + container background)', () => {
  const reading = {
    scope: 'process',
    sample: PROC,
    container: CONTAINER,
    sampledAt: new Date(1_700_000_000_000),
    ageMs: 1000,
  };
  const svc = new MetricsService(guardrailsStub, makeSampler({ 'task-abc': reading }));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'sampled');
  assert.equal(res.scope, 'process');
  assert.deepEqual(res.sample, PROC, 'primary = codex process figure');
  assert.deepEqual(res.container, CONTAINER, 'container total carried as background');
  assert.ok(res.sampledAt instanceof Date, 'carries sampledAt');
  assert.equal(res.ageMs, 1000, 'carries ageMs');
});

test('container-scope fallback maps through with null background', () => {
  const reading = {
    scope: 'container',
    sample: CONTAINER,
    container: null,
    sampledAt: new Date(1_700_000_000_000),
    ageMs: 1000,
  };
  const svc = new MetricsService(guardrailsStub, makeSampler({ 'task-abc': reading }));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'sampled');
  assert.equal(res.scope, 'container');
  assert.equal(res.container, null);
});

test('no reading (null) maps to not-running (not an error, no zeros)', () => {
  const svc = new MetricsService(guardrailsStub, makeSampler({}));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'not-running');
  assert.equal(res.sample, undefined, 'no fabricated sample');
});

test('one /metrics poll carries the equivalent per-task data the fan-out would return', () => {
  const reading = {
    scope: 'process',
    sample: PROC,
    container: CONTAINER,
    sampledAt: new Date(5_000),
    ageMs: 0,
  };
  const sampler = {
    taskReading: (taskId) => (taskId === 'task-abc' ? reading : null),
    currentSnapshot: () => ({
      status: 'available',
      sampledAt: new Date(5_000),
      ageMs: 0,
      hasActiveContainers: true,
      containers: [CONTAINER],
      aggregateCpuPercent: CONTAINER.cpuPercent,
      aggregateMemoryBytes: CONTAINER.memoryBytes,
    }),
  };
  // 'task-gone' is running per the semaphore but has NO live frame.
  const guardrails = {
    semaphoreProjection: () => ({
      maxConcurrentTasks: 3,
      runningCount: 2,
      queuedCount: 0,
      snapshotRunning: () => ['task-abc', 'task-gone'],
      snapshotQueue: () => [],
    }),
    runnerMinuteIntervals: () => [],
  };
  const svc = new MetricsService(guardrails, sampler);

  const aggregate = svc.build(5_000);
  const fanout = svc.buildTaskResource('task-abc', 5_000);

  const entry = aggregate.resources.taskSamples['task-abc'];
  assert.ok(entry, 'running task rides the aggregate per-task section');
  assert.equal(entry.scope, fanout.scope, 'same scope semantics as the fan-out');
  assert.deepEqual(entry.sample, fanout.sample, 'same snapshot data as the fan-out');
  assert.equal(entry.stale, false, 'fresh same-tick frame is not stale');
  // Unsampled-but-running task: omitted from the section AND not-running via
  // the fan-out — equivalent honesty, never fabricated zeros.
  assert.ok(!('task-gone' in aggregate.resources.taskSamples), 'no-frame task omitted');
  assert.equal(svc.buildTaskResource('task-gone', 5_000).state, 'not-running');
  // Prior fields of the resources block ride along unchanged.
  assert.equal(aggregate.resources.status, 'available');
  assert.deepEqual(aggregate.resources.containers, [CONTAINER]);
});
