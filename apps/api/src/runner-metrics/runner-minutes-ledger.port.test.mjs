/**
 * The detached fallback is a REAL ledger, not a silent no-op
 * (extract-runner-minutes-ledger, task 1.4).
 *
 * `createDetachedRunnerMinutes()` backs the orchestrator's injector-less
 * fallback member, which is what `guardrails.service.spec.ts` reads reflectively
 * — and all 7 of that frozen spec's assertions assert the ABSENCE of open
 * intervals. A factory that returned a no-op double would therefore satisfy
 * every one of them VACUOUSLY while accounting nothing at all, and no existing
 * test would notice. This file is the assertion that notices: it drives the
 * returned instance positively (start → read → end → read) and demands to see
 * the interval appear open and then closed.
 *
 * It loads the COMPILED port from `dist/runner-metrics/` the way
 * `apps/api/src/metrics/metrics.verify.test.mjs` loads dist, so a drift between
 * this file and the shipped module cannot hide. Requires
 * `pnpm --filter @cap-console/api build`. Discovered by apps/api's `test:src`
 * glob (`src/**\/*.test.mjs`) with no registration step.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_RUNNER = path.resolve(here, '../../dist/runner-metrics');

const portModule = require(
  path.join(DIST_RUNNER, 'runner-minutes-ledger.port.js'),
);
const { createDetachedRunnerMinutes, RUNNER_MINUTES_PORT } = portModule;

test('1.4 the detached factory returns a ledger that really records: open then closed', () => {
  const ledger = createDetachedRunnerMinutes();

  ledger.recordStart('task-detached-1');
  const whileRunning = ledger.intervals();

  assert.equal(
    whileRunning.length,
    1,
    'a recorded start must be visible as one interval — a no-op fallback returns []',
  );
  assert.equal(whileRunning[0].taskId, 'task-detached-1');
  assert.equal(
    whileRunning[0].endedAt,
    null,
    'the interval is still open while the task runs',
  );
  assert.equal(typeof whileRunning[0].startedAt, 'number');

  ledger.recordEnd('task-detached-1');
  const afterEnd = ledger.intervals();

  assert.equal(afterEnd.length, 1, 'closing an interval retains it, not drops it');
  assert.equal(afterEnd[0].taskId, 'task-detached-1');
  assert.notEqual(
    afterEnd[0].endedAt,
    null,
    'the interval is closed after recordEnd — this is the assertion a no-op fallback fails',
  );
  assert.ok(afterEnd[0].endedAt >= afterEnd[0].startedAt);
});

test('1.4 two detached instances are independent, so the factory is not a shared singleton', () => {
  const first = createDetachedRunnerMinutes();
  const second = createDetachedRunnerMinutes();

  first.recordStart('task-detached-2');

  assert.equal(first.intervals().length, 1);
  assert.deepEqual(
    second.intervals(),
    [],
    'a second detached instance shares no state with the first',
  );
});

test('1.2 the port module exports exactly the interface token and the factory', () => {
  // The interface is a type and erases, so the runtime surface is exactly two
  // names: the DI token and the detached factory. Anything else here — the
  // concrete `RunnerMinutesLedger` above all — would be a second route to the
  // implementation.
  assert.deepEqual(
    Object.keys(portModule).filter((key) => key !== '__esModule').sort(),
    ['RUNNER_MINUTES_PORT', 'createDetachedRunnerMinutes'],
  );
  assert.equal(typeof RUNNER_MINUTES_PORT, 'string');
  assert.equal(typeof createDetachedRunnerMinutes, 'function');
});
