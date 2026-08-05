/**
 * PIN for the capacity/occupancy blocks of the metrics response
 * (collapse-three-collaborator-groups, task 3.2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The projection's OWNERSHIP moves: the orchestrator stops exporting an
 * accessor over the admission semaphore and the metrics reader starts reading
 * the owner in this directory instead. A move like that is only safe if the
 * bytes on the wire are provably the same, and "the same" has to be recorded
 * BEFORE the reader is repointed — a pin written afterwards can only describe
 * whatever the new path happens to produce.
 *
 * So this file states the complete capacity and occupancy blocks as literals
 * over one fixed admission state, and demands the owner produce exactly them.
 * It must pass UNMODIFIED after the orchestrator's accessor is deleted and the
 * metrics consumer is repointed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not re-implement the derivation. The expectations are checked twice:
 * once against frozen literals, and once against the COMPILED `projectCapacity`
 * / `buildSlotOccupancy` from `dist/` — the very functions the metrics response
 * has always been built from. A hand-written mirror of the derivation would
 * agree with a drifting owner; the compiled functions will not.
 *
 * It also does not go through `MetricsService`'s constructor. That constructor
 * changes in this same change (its projection collaborator is repointed), and a
 * pin that had to be edited to keep compiling would no longer be a pin.
 *
 * Loads the compiled modules from `dist/runner-metrics/` the way
 * `apps/api/src/metrics/metrics.verify.test.mjs` loads dist. Requires
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

const { projectCapacity, buildSlotOccupancy } = require(
  path.join(DIST_RUNNER, 'metrics-projection.js'),
);
const { CapacityProjectionService } = require(
  path.join(DIST_RUNNER, 'capacity-projection.service.js'),
);

/**
 * A frozen instant. Neither block takes a clock input today, and pinning under
 * a stopped clock is what turns that into an assertion rather than a hope: a
 * derivation that started consulting the wall clock would have to disagree with
 * itself across `advanceFrozenClock` below.
 */
const FROZEN_NOW = 1_700_000_000_000;
let frozenNow = FROZEN_NOW;

/** Runs `fn` with `Date.now` stopped at the frozen instant, then restores it. */
function withFrozenClock(fn) {
  const realNow = Date.now;
  Date.now = () => frozenNow;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

function advanceFrozenClock(ms) {
  frozenNow += ms;
}

/**
 * The fixed admission state, as the live read-only view of it that the metrics
 * response has always been derived from: two of three slots held, two more
 * tasks waiting. It exercises every branch the blocks have — a busy slot, an
 * idle slot, and a non-empty FIFO queue reported outside the slot table.
 */
function fixedAdmissionState() {
  return {
    maxConcurrentTasks: 3,
    runningCount: 2,
    queuedCount: 2,
    snapshotRunning: () => ['task-alpha', 'task-beta'],
    snapshotQueue: () => ['task-gamma', 'task-delta'],
  };
}

/** The complete blocks, as bytes, for {@link fixedAdmissionState}. */
const PINNED_CAPACITY = { ceiling: 3, active: 2, free: 1, queueDepth: 2 };
const PINNED_OCCUPANCY = {
  slots: [
    { slot: 0, busy: true, taskId: 'task-alpha' },
    { slot: 1, busy: true, taskId: 'task-beta' },
    { slot: 2, busy: false, taskId: null },
  ],
  queuedTaskIds: ['task-gamma', 'task-delta'],
};

function boundOwner(source = fixedAdmissionState()) {
  const owner = new CapacityProjectionService();
  owner.bindSource(source);
  return owner;
}

test('3.2 the owner serves the pinned capacity and occupancy blocks, complete and byte-for-byte', () => {
  const projection = withFrozenClock(() => boundOwner().project());

  assert.deepEqual(projection.capacity, PINNED_CAPACITY);
  assert.deepEqual(projection.occupancy, PINNED_OCCUPANCY);
});

test('3.2 those blocks come from the COMPILED projection functions, not a mirror', () => {
  const source = fixedAdmissionState();
  const projection = withFrozenClock(() => boundOwner(source).project());

  // The functions the metrics response was always built from, over the very
  // same state. If the owner ever grew its own arithmetic, this is the
  // assertion that separates it from the shipped derivation.
  assert.deepEqual(projection.capacity, projectCapacity(source));
  assert.deepEqual(projection.occupancy, buildSlotOccupancy(source));
});

test('3.2 the running set the response folds per-task samples over is the same reading', () => {
  const source = fixedAdmissionState();
  const owner = boundOwner(source);

  const projection = withFrozenClock(() => owner.project());

  assert.deepEqual(projection.runningTaskIds, source.snapshotRunning());
  assert.deepEqual(owner.runningTaskIds(), source.snapshotRunning());
  // The slot table and the running set describe ONE reading: every busy slot
  // names a task the running set also names, in order.
  assert.deepEqual(
    projection.occupancy.slots
      .filter((entry) => entry.busy)
      .map((entry) => entry.taskId),
    projection.runningTaskIds,
  );
});

test('3.2 the blocks are a function of admission state alone — the frozen clock moving changes nothing', () => {
  const owner = boundOwner();

  const first = withFrozenClock(() => owner.project());
  advanceFrozenClock(10 * 60_000);
  const second = withFrozenClock(() => owner.project());

  assert.deepEqual(second.capacity, first.capacity);
  assert.deepEqual(second.occupancy, first.occupancy);
  assert.deepEqual(second.capacity, PINNED_CAPACITY);
  assert.deepEqual(second.occupancy, PINNED_OCCUPANCY);
});

test('3.2 an owner nobody bound a source to fails loudly instead of serving a plausible empty block', () => {
  const unbound = new CapacityProjectionService();

  // The failure mode this forbids is the quiet one: a zero-ceiling capacity
  // block and an empty slot table are a perfectly valid-looking response, and
  // an idle process produces exactly that — so an unwired projection would be
  // indistinguishable from a correct one.
  assert.throws(() => unbound.project(), /bindSource/);
  assert.throws(() => unbound.runningTaskIds(), /bindSource/);
});
