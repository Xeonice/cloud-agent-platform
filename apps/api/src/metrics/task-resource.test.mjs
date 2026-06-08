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
 *   - the read filters by taskId (returns THIS task's sample, not another's).
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

const SAMPLE = {
  taskId: 'task-abc',
  cpuPercent: 42.5,
  memoryBytes: 123_456_789,
  memoryLimitBytes: 2_000_000_000,
  memoryPercent: 6.17,
};

/** Fake sampler whose currentSnapshot returns a fixed snapshot. */
function makeSampler(containers, sampledAtMs) {
  return {
    currentSnapshot() {
      return {
        status: containers.length ? 'available' : 'unavailable',
        sampledAt: sampledAtMs == null ? null : new Date(sampledAtMs),
        ageMs: sampledAtMs == null ? null : 1000,
        hasActiveContainers: containers.length > 0,
        containers,
        aggregateCpuPercent: containers.reduce((a, c) => a + c.cpuPercent, 0),
        aggregateMemoryBytes: containers.reduce((a, c) => a + c.memoryBytes, 0),
      };
    },
  };
}

// guardrails is unused by buildTaskResource; pass a minimal stub.
const guardrailsStub = {};

test('sampled task returns its own CPU/memory with freshness', () => {
  const svc = new MetricsService(guardrailsStub, makeSampler([SAMPLE], 1_700_000_000_000));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'sampled');
  assert.deepEqual(res.sample, SAMPLE);
  assert.ok(res.sampledAt instanceof Date, 'carries sampledAt');
  assert.equal(res.ageMs, 1000, 'carries ageMs');
});

test('task with no live container returns not-running (not an error, no zeros)', () => {
  const svc = new MetricsService(guardrailsStub, makeSampler([], null));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'not-running');
  assert.equal(res.sample, undefined, 'no fabricated sample');
});

test('read filters by taskId — returns THIS task, not another running one', () => {
  const other = { ...SAMPLE, taskId: 'task-other', cpuPercent: 99 };
  const svc = new MetricsService(guardrailsStub, makeSampler([other, SAMPLE], 1_700_000_000_000));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'sampled');
  assert.equal(res.sample.taskId, 'task-abc');
  assert.equal(res.sample.cpuPercent, 42.5, 'not the other task’s 99%');
});

test('a task whose container just left the snapshot reads not-running', () => {
  const svc = new MetricsService(guardrailsStub, makeSampler([{ ...SAMPLE, taskId: 'task-other' }], 1_700_000_000_000));
  const res = svc.buildTaskResource('task-abc');
  assert.equal(res.state, 'not-running');
});
