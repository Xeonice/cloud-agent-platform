/**
 * INTEGRATION proof for the runner-minutes ownership move
 * (extract-runner-minutes-ledger, track `gates-and-verification`, tasks 5.3 + 5.11).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The characterization test next door proves the DERIVATION did not change. It
 * cannot prove the thing the move is actually about: that after the move ONE
 * ledger instance still serves both the writer (the orchestrator, on the
 * admission/terminal seam) and the reader (the metrics service). Two ledgers
 * would keep every derivation test green while silently reporting a booted
 * process's runner minutes as zero.
 *
 * So this file BOOTS a Nest application context, resolves the owner through the
 * DI token, drives a real run start through the orchestrator's own write path,
 * and reads the number back out of the real `MetricsService`.
 *
 * WHY IT IS A NEW FILE
 * --------------------
 * Task 5.2 asserts the characterization test is byte-identical to the file the
 * `characterization-proof` track committed, and task 1.x owns
 * `runner-minutes-ledger.port.test.mjs`. Neither may be appended to. This is the
 * integration track's own file.
 *
 * Requires `pnpm --filter @cap-console/api build` first (apps/api's `pretest`
 * does this). Mounted by apps/api's `test:src` glob (`src/**\/*.test.mjs`).
 *
 * Run standalone with:
 *   node --test apps/api/src/runner-metrics/runner-minutes-ownership.integration.test.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist');

if (!existsSync(path.join(DIST, 'runner-metrics/runner-minutes.module.js'))) {
  // Fail loudly rather than skip: an integration proof that quietly does nothing
  // when dist/ is stale would report "green" across the very move it polices.
  throw new Error(
    `runner-minutes-ownership: compiled modules missing under ${DIST}. ` +
      'Run `pnpm --filter @cap-console/api build` first.',
  );
}

const { NestFactory, ModuleRef } = require('@nestjs/core');
const { Module } = require('@nestjs/common');

const { RunnerMinutesModule } = require(path.join(DIST, 'runner-metrics/runner-minutes.module.js'));
const { RUNNER_MINUTES_PORT } = require(
  path.join(DIST, 'runner-metrics/runner-minutes-ledger.port.js'),
);
const { RunnerMinutesLedgerService } = require(
  path.join(DIST, 'runner-metrics/runner-minutes-ledger.service.js'),
);
const { deriveRunnerMinutes } = require(path.join(DIST, 'runner-metrics/runner-minutes.js'));
const { GuardrailsService } = require(path.join(DIST, 'guardrails/guardrails.service.js'));
const { MetricsService } = require(path.join(DIST, 'metrics/metrics.service.js'));
const { TASK_OPERATIONS } = require(path.join(DIST, 'task-operations/task-operations.port.js'));

const MIN = 60_000;

/**
 * Boot the smallest context that can answer the ownership question: the owner's
 * module, plus the one token `GuardrailsService.onModuleInit` resolves
 * NON-optionally before it reaches the runner-minutes lookup.
 *
 * Everything else that hook resolves (terminal gateway, forge trio) is already
 * wrapped in try/catch by production code, so leaving those modules out
 * exercises the same degradation path a focused context always took.
 */
async function bootContext() {
  class RunnerMinutesOwnershipTestModule {}
  Module({
    imports: [RunnerMinutesModule],
    providers: [{ provide: TASK_OPERATIONS, useValue: {} }],
  })(RunnerMinutesOwnershipTestModule);

  return NestFactory.createApplicationContext(RunnerMinutesOwnershipTestModule, {
    logger: false,
  });
}

/** The orchestrator, built the way the frozen unit spec builds it — positionally. */
function buildOrchestrator(moduleRef) {
  return new GuardrailsService(moduleRef, { destroyForSession() {} });
}

/** A capacity projection double: this test is about runner minutes, not slots. */
function semaphoreProjection(running) {
  return () => ({
    ceiling: 4,
    snapshotRunning: () => running,
    snapshotQueue: () => [],
  });
}

function sampler(nowMs) {
  return {
    currentSnapshot: () => ({
      status: 'available',
      sampledAt: new Date(nowMs).toISOString(),
      ageMs: 0,
      containers: [],
    }),
    taskReading: () => new Map(),
  };
}

// ---------------------------------------------------------------------------
// 5.3 — one instance serves both sides, in a BOOTED context
// ---------------------------------------------------------------------------

test('booted context: the orchestrator writes and metrics reads the SAME ledger instance', async (t) => {
  const app = await bootContext();
  t.after(() => app.close());

  const registered = app.get(RUNNER_MINUTES_PORT, { strict: false });
  const service = buildOrchestrator(app.get(ModuleRef));
  service.onModuleInit();

  // The member every write site names now yields the DI-registered owner —
  // object identity, not an equal-looking second ledger.
  assert.equal(
    service.runnerMinutes,
    registered,
    'the orchestrator resolved the provider registered under RUNNER_MINUTES_PORT',
  );
  assert.ok(
    registered instanceof RunnerMinutesLedgerService,
    'the token resolves to the owning provider class',
  );

  // Drive a real run start through the orchestrator's OWN write path — the
  // durable-arm site, one of the three production `recordStart` references.
  const t0 = Date.now();
  await service.armDurableRuntime('task-alpha', { authorize: async () => {} });

  // The interval is visible on the READ side without any second ledger.
  const observed = registered.intervals();
  assert.deepEqual(
    observed.map(({ taskId, endedAt }) => ({ taskId, open: endedAt === null })),
    [{ taskId: 'task-alpha', open: true }],
    'the run start the orchestrator recorded is what the owner holds',
  );

  // And the real MetricsService, fed from the port, counts it.
  const now = t0 + 5 * MIN;
  const body = new MetricsService(
    { semaphoreProjection: semaphoreProjection(['task-alpha']) },
    sampler(now),
    registered,
  ).build(now);

  assert.equal(body.runnerMinutes.available, true, 'the derived block is available');
  assert.ok(
    body.runnerMinutes.minutes >= 4.9 && body.runnerMinutes.minutes <= 5.1,
    `expected ~5 minutes for the in-flight interval, got ${body.runnerMinutes.minutes}`,
  );
});

test('booted context: the detached fallback is bypassed and records nothing', async (t) => {
  const app = await bootContext();
  t.after(() => app.close());

  const registered = app.get(RUNNER_MINUTES_PORT, { strict: false });
  const service = buildOrchestrator(app.get(ModuleRef));

  // Before resolution the field initializer's detached ledger is what answers.
  const detached = service.detachedRunnerMinutes;
  assert.ok(detached, 'the field initializer produced a fallback ledger');
  assert.equal(service.runnerMinutes, detached, 'pre-boot, the fallback answers');

  service.onModuleInit();
  assert.equal(service.runnerMinutes, registered, 'post-boot, the owner answers');
  assert.notEqual(detached, registered, 'the fallback is a DIFFERENT instance from the owner');

  await service.armDurableRuntime('task-beta', { authorize: async () => {} });

  // The fallback was BYPASSED, not replaced in place: it saw none of that write.
  assert.deepEqual(
    detached.intervals(),
    [],
    'the detached instance recorded zero intervals once the application booted',
  );
  assert.equal(registered.intervals().length, 1, 'the owner took the write instead');
});

test('booted context: an unwired context still accounts through the fallback', async (t) => {
  // The negative control for the assertion above. If the runner-metrics module
  // is absent, `onModuleInit` leaves the owner unset and the fallback keeps
  // accounting — a REAL ledger, so the frozen unit spec's negative assertions
  // cannot pass vacuously.
  class NoOwnerModule {}
  Module({ providers: [{ provide: TASK_OPERATIONS, useValue: {} }] })(NoOwnerModule);
  const app = await NestFactory.createApplicationContext(NoOwnerModule, { logger: false });
  t.after(() => app.close());

  const service = buildOrchestrator(app.get(ModuleRef));
  service.onModuleInit();
  assert.equal(service.runnerMinutes, service.detachedRunnerMinutes, 'fallback still answers');

  await service.armDurableRuntime('task-gamma', { authorize: async () => {} });
  assert.equal(
    service.detachedRunnerMinutes.intervals().length,
    1,
    'the injector-less instance genuinely accounts',
  );
});

// ---------------------------------------------------------------------------
// 5.11 — the response body is unchanged by the rewiring
// ---------------------------------------------------------------------------

test('the runnerMinutes block equals the PRE-MOVE read expression over the same intervals', () => {
  // Before the move, `MetricsService.build` computed this block by calling the
  // orchestrator's forwarding read accessor and passing its result to
  // `deriveRunnerMinutes` with `now`; that accessor was a one-line forward to the
  // ledger's `intervals()`. So the pre-move value over a fixture is exactly
  // `deriveRunnerMinutes(fixture, now)` — computed here from the SAME compiled
  // derivation the service itself calls. (The accessor's identifier is deliberately
  // not spelled out: the removal is asserted by a tree-wide grep for it returning
  // zero, and a mention here — even in a comment — would defeat that tripwire.)
  const NOW = 1_000 * MIN;
  const fixture = [
    { taskId: 'closed-a', startedAt: NOW - 10 * MIN, endedAt: NOW - 8 * MIN },
    { taskId: 'closed-b', startedAt: NOW - 7 * MIN, endedAt: NOW - 4 * MIN },
    { taskId: 'open-a', startedAt: NOW - 3 * MIN, endedAt: null },
  ];
  const port = { recordStart() {}, recordEnd() {}, intervals: () => fixture };

  const body = new MetricsService(
    { semaphoreProjection: semaphoreProjection(['open-a']) },
    sampler(NOW),
    port,
  ).build(NOW);

  assert.deepEqual(
    body.runnerMinutes,
    deriveRunnerMinutes(fixture, NOW),
    'the post-move block equals the pre-move expression over the same intervals',
  );
  // Pin the literal too, so a change to BOTH sides at once cannot pass silently.
  assert.deepEqual(body.runnerMinutes, { available: true, minutes: 8 });
});

test('the response keeps its exact top-level block set — nothing added, nothing dropped', () => {
  const NOW = 1_000 * MIN;
  const port = { recordStart() {}, recordEnd() {}, intervals: () => [] };
  const body = new MetricsService(
    { semaphoreProjection: semaphoreProjection([]) },
    sampler(NOW),
    port,
  ).build(NOW);

  assert.deepEqual(Object.keys(body), [
    'capacity',
    'occupancy',
    'runnerMinutes',
    'resources',
    'provisioningDiagnostics',
  ]);
  // The empty ledger stays honestly unavailable rather than a fabricated 0.
  assert.deepEqual(body.runnerMinutes, { available: false, minutes: null });
});
