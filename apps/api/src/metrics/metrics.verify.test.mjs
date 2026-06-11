/**
 * VERIFY-PHASE unit tests for Track 5 (be-metrics 5.6) — the pure capacity
 * projection + the REAL ResourceSamplerService freshness/outage behavior, with
 * NO live docker and NO running containers.
 *
 * Unlike the impl agent's metrics-projection / resource-sampler tests (which
 * INLINE copies of the pure functions), this file drives the ACTUAL compiled
 * code from dist/ so a future drift between source and test cannot hide:
 *   - dist/metrics/metrics-projection.js  (projectCapacity, buildSlotOccupancy)
 *   - dist/metrics/runner-minutes.js      (deriveRunnerMinutes)
 *   - dist/metrics/resource-sampler.service.js (real ResourceSamplerService +
 *     buildSampledResources / freshnessStatus)
 *
 * These three leaf modules have only erased TYPE imports from @cap/contracts, so
 * they load under plain `node`. Run with: `node metrics.verify.test.mjs`.
 *
 * Scenarios named by the verify task:
 *   - active/free/queueDepth projection from a fake semaphore: active+free==ceiling,
 *     free never negative;
 *   - slot table ↔ scalar consistency: busy==active, idle==free, queued len==
 *     queueDepth, never beyond ceiling;
 *   - no-containers → EXPLICIT empty (NOT a stale echo) — asserted on the REAL
 *     sampler's currentSnapshot(), which is where the empty-stays-available vs
 *     real-measurement-goes-stale distinction actually lives;
 *   - sampling-outage degrades ONLY the sampled block (the derived capacity block,
 *     computed independently of the sampler, is still returned and exact);
 *   - runner-minutes → unavailable when insufficient (no timing data).
 *
 * console-design-pixel-merge additions (per-task process-scope section):
 *   - foldTaskSamples over the REAL sampler's taskReading: entries present for
 *     running tasks (process primary / container fallback), latest frame ONLY;
 *   - carry-forward on a transient miss → entry kept, flagged stale;
 *   - non-running/left-set tasks omitted, never fabricated zeros;
 *   - ADDITIVE-CONTRACT assertion against the compiled zod schema: a prior-shape
 *     payload (no taskSamples) still parses, and the real MetricsService.build()
 *     response keeps every prior field unchanged in name/type.
 *
 * Requires `pnpm --filter @cap/api build` (refreshes dist/) and
 * `pnpm --filter @cap/contracts build` (compiled zod schemas) before running.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/metrics');

const { projectCapacity, buildSlotOccupancy, foldTaskSamples } = require(
  path.join(DIST, 'metrics-projection.js'),
);
const { deriveRunnerMinutes } = require(path.join(DIST, 'runner-minutes.js'));
const { ResourceSamplerService } = require(
  path.join(DIST, 'resource-sampler.service.js'),
);
const { MetricsService } = require(path.join(DIST, 'metrics.service.js'));

// The compiled contracts package is ESM — import the zod schemas dynamically.
const { MetricsResponseSchema } = await import(
  pathToFileURL(
    path.resolve(here, '../../../../packages/contracts/dist/metrics.js'),
  ).href
);

/** A live, mutable fake of the narrow SemaphoreProjectionSource. */
function makeSemaphore(ceiling, running, queued) {
  return {
    maxConcurrentTasks: ceiling,
    _running: [...running],
    _queued: [...queued],
    get runningCount() {
      return this._running.length;
    },
    get queuedCount() {
      return this._queued.length;
    },
    snapshotRunning() {
      return [...this._running];
    },
    snapshotQueue() {
      return [...this._queued];
    },
  };
}

// ---------------------------------------------------------------------------
// 5.1 — scalar capacity projection: active+free==ceiling, free never negative
// ---------------------------------------------------------------------------

test('5.1 projects active/free/queueDepth from a single reading; active+free==ceiling', () => {
  const cap = projectCapacity(makeSemaphore(5, ['r1', 'r2', 'r3'], ['q1', 'q2']));
  assert.equal(cap.ceiling, 5);
  assert.equal(cap.active, 3);
  assert.equal(cap.free, 2);
  assert.equal(cap.queueDepth, 2);
  assert.equal(cap.active + cap.free, cap.ceiling, 'active+free===ceiling');
});

test('5.1 free is NEVER negative even when over-admitted (clamped, invariant holds)', () => {
  const cap = projectCapacity(makeSemaphore(3, ['r1', 'r2', 'r3', 'r4'], []));
  assert.equal(cap.active, 4);
  assert.equal(cap.free, 0, 'free clamped at 0, never negative');
  assert.ok(cap.free >= 0);
});

test('5.1 empty semaphore: all free; full semaphore: zero free', () => {
  const empty = projectCapacity(makeSemaphore(3, [], []));
  assert.equal(empty.active, 0);
  assert.equal(empty.free, 3);
  const full = projectCapacity(makeSemaphore(2, ['a', 'b'], ['c']));
  assert.equal(full.free, 0);
  assert.equal(full.queueDepth, 1);
});

test('5.1 projection is LIVE: mutating the semaphore between reads changes the result', () => {
  const sem = makeSemaphore(3, ['r1'], []);
  const before = projectCapacity(sem);
  assert.deepEqual([before.active, before.free, before.queueDepth], [1, 2, 0]);
  sem._running.push('r2');
  sem._queued.push('q1');
  const after = projectCapacity(sem);
  assert.deepEqual([after.active, after.free, after.queueDepth], [2, 1, 1]);
});

// ---------------------------------------------------------------------------
// 5.2 — slot table ↔ scalar consistency
// ---------------------------------------------------------------------------

test('5.2 slot table is consistent with scalars: busy==active, idle==free, len==ceiling', () => {
  const sem = makeSemaphore(5, ['r1', 'r2', 'r3'], ['q1', 'q2']);
  const cap = projectCapacity(sem);
  const occ = buildSlotOccupancy(sem);
  assert.equal(occ.slots.length, cap.ceiling, 'exactly ceiling slots');
  const busy = occ.slots.filter((s) => s.busy);
  const idle = occ.slots.filter((s) => !s.busy);
  assert.equal(busy.length, cap.active, 'busy count === active');
  assert.equal(idle.length, cap.free, 'idle count === free');
  assert.ok(busy.every((s) => s.taskId !== null), 'busy slots carry a taskId');
  assert.ok(idle.every((s) => s.taskId === null), 'idle slots carry null');
  assert.deepEqual(busy.map((s) => s.taskId), ['r1', 'r2', 'r3']);
});

test('5.2 queued ids reported SEPARATELY in FIFO order; len==queueDepth; never in a slot', () => {
  const sem = makeSemaphore(5, ['r1'], ['q1', 'q2', 'q3']);
  const cap = projectCapacity(sem);
  const occ = buildSlotOccupancy(sem);
  assert.deepEqual(occ.queuedTaskIds, ['q1', 'q2', 'q3'], 'FIFO order preserved');
  assert.equal(occ.queuedTaskIds.length, cap.queueDepth, 'queue length === queueDepth');
  const slotIds = occ.slots.map((s) => s.taskId).filter((x) => x !== null);
  assert.ok(
    occ.queuedTaskIds.every((q) => !slotIds.includes(q)),
    'a queued task never occupies a slot',
  );
});

test('5.2 NEVER invents slots beyond ceiling even when running > ceiling', () => {
  const sem = makeSemaphore(2, ['r1', 'r2', 'r3'], []);
  const occ = buildSlotOccupancy(sem);
  assert.equal(occ.slots.length, 2, 'slot table capped at ceiling, never grown');
  assert.deepEqual(occ.slots.map((s) => s.taskId), ['r1', 'r2']);
});

// ---------------------------------------------------------------------------
// 5.4 — runner-minutes: unavailable when insufficient timing data
// ---------------------------------------------------------------------------

test('5.4 no timing data → UNAVAILABLE (minutes null), never a fabricated 0', () => {
  const r = deriveRunnerMinutes([], 1_000);
  assert.equal(r.available, false);
  assert.equal(r.minutes, null);
});

test('5.4 a genuine zero-elapsed reading WITH data is available:true minutes:0 (distinct from unavailable)', () => {
  const r = deriveRunnerMinutes(
    [{ taskId: 't1', startedAt: 7_000, endedAt: 7_000 }],
    99_000,
  );
  assert.equal(r.available, true, 'data present → available, even if the sum is 0');
  assert.equal(r.minutes, 0);
});

test('5.4 closed + in-flight intervals sum; clock skew contributes 0', () => {
  const MIN = 60_000;
  const r = deriveRunnerMinutes(
    [
      { taskId: 'closed', startedAt: 0, endedAt: 2 * MIN }, // +2
      { taskId: 'open', startedAt: 1 * MIN, endedAt: null }, // +3 to now(4)
      { taskId: 'skew', startedAt: 5 * MIN, endedAt: 2 * MIN }, // negative → 0
    ],
    4 * MIN,
  );
  assert.equal(r.available, true);
  assert.equal(r.minutes, 5, '2 + 3 + 0 === 5 minutes');
});

// ---------------------------------------------------------------------------
// 5.3 / 5.5 — REAL ResourceSamplerService: no-containers ≠ stale; outage degrades
//             ONLY the sampled block.
// ---------------------------------------------------------------------------

/** A sampler whose container read is fully stubbed (no docker, no cgroup fs). */
function makeSampler() {
  // Short thresholds keep the freshness math obvious; the loop is never started.
  return new ResourceSamplerService({ cadenceMs: 1_000, staleAfterMs: 3_000 });
}

test('5.3 never-sampled sampler reports an explicit UNAVAILABLE reading (not a fake zero)', () => {
  const s = makeSampler();
  const snap = s.currentSnapshot(0);
  assert.equal(snap.status, 'unavailable');
  assert.equal(snap.sampledAt, null);
  assert.equal(snap.ageMs, null);
  assert.equal(snap.hasActiveContainers, false);
  assert.equal(snap.containers.length, 0);
});

test('5.3 no-containers tick → EXPLICIT empty reading that stays AVAILABLE (never a stale echo)', async () => {
  const s = makeSampler();
  // First, prime a non-empty healthy sample so there IS a prior measurement that
  // a buggy implementation might echo back as "stale".
  s.setRunningTaskIdSource(() => ['t1']);
  s.readContainers = async () => [
    {
      taskId: 't1',
      cpuUsageUsec: null,
      cpuPercent: 12,
      readAtMs: 1_000,
      memoryBytes: 100,
      memoryLimitBytes: 200,
    },
  ];
  await s.sampleOnce(1_000);
  assert.equal(s.currentSnapshot(1_000).hasActiveContainers, true, 'primed non-empty');

  // Now the running set drops to zero: the sampler must cache the EXPLICIT empty
  // reading, not keep echoing the prior non-empty sample.
  s.setRunningTaskIdSource(() => []);
  await s.sampleOnce(2_000);

  // Even queried FAR in the future (well beyond staleAfterMs), an empty reading
  // stays `available` — its emptiness is a current fact, not a stale measurement.
  const empty = s.currentSnapshot(10_000_000);
  assert.equal(empty.status, 'available', 'empty reading is available, not stale');
  assert.equal(empty.hasActiveContainers, false);
  assert.equal(empty.containers.length, 0);
  assert.equal(empty.aggregateCpuPercent, 0);
  assert.equal(empty.aggregateMemoryBytes, 0);
});

test('5.5 a real measurement DOES go stale past the threshold (contrast with the empty reading)', async () => {
  const s = makeSampler();
  s.setRunningTaskIdSource(() => ['t1']);
  s.readContainers = async () => [
    {
      taskId: 't1',
      cpuUsageUsec: null,
      cpuPercent: 30,
      readAtMs: 1_000,
      memoryBytes: 50,
      memoryLimitBytes: 100,
    },
  ];
  await s.sampleOnce(1_000);
  assert.equal(s.currentSnapshot(1_000).status, 'available', 'fresh within threshold');
  assert.equal(
    s.currentSnapshot(1_000 + 4_000).status,
    'stale',
    'past staleAfterMs(3000) → stale',
  );
});

test('5.5 SAMPLING OUTAGE degrades ONLY the sampled block (status stale; prior numbers preserved)', async () => {
  const s = makeSampler();
  s.setRunningTaskIdSource(() => ['t1']);
  s.readContainers = async () => [
    {
      taskId: 't1',
      cpuUsageUsec: null,
      cpuPercent: 25,
      readAtMs: 1_000,
      memoryBytes: 64,
      memoryLimitBytes: 128,
    },
  ];
  await s.sampleOnce(1_000);

  // Outage on the next tick: the source read throws.
  s.readContainers = async () => {
    throw new Error('docker socket unreachable');
  };
  await s.sampleOnce(2_000);

  const snap = s.currentSnapshot(2_000);
  assert.equal(snap.status, 'stale', 'outage flags the sampled block as not-fresh');
  // The block degrades but is NOT wiped: the prior derived numbers are still served.
  assert.equal(snap.containers.length, 1, 'prior sample retained (degraded, not empty)');
  assert.equal(snap.aggregateCpuPercent, 25);
});

test('5.5 derived CAPACITY block is INDEPENDENT of the sampler: still exact during an outage', async () => {
  // Mirror MetricsService.build()'s composition with the REAL pure builders + the
  // REAL sampler driven into an outage. The capacity/occupancy/runnerMinutes block
  // is a pure function of the semaphore projection + ledger; it must be returned
  // and exact regardless of the sampled block being stale/unavailable.
  const sem = makeSemaphore(4, ['r1', 'r2'], ['q1']);
  const intervals = [{ taskId: 'r1', startedAt: 0, endedAt: 60_000 }]; // 1 min

  const s = makeSampler();
  s.setRunningTaskIdSource(() => ['r1', 'r2']);
  s.readContainers = async () => {
    throw new Error('sampling source down from the very first tick');
  };
  await s.sampleOnce(5_000); // outage; nothing ever cached → unavailable

  const response = {
    capacity: projectCapacity(sem),
    occupancy: buildSlotOccupancy(sem),
    runnerMinutes: deriveRunnerMinutes(intervals, 60_000),
    resources: s.currentSnapshot(5_000),
  };

  // Sampled block degraded ...
  assert.equal(response.resources.status, 'unavailable', 'sampled block unavailable on cold outage');
  // ... but the derived block is fully present and exact.
  assert.equal(response.capacity.ceiling, 4);
  assert.equal(response.capacity.active, 2);
  assert.equal(response.capacity.free, 2);
  assert.equal(response.capacity.queueDepth, 1);
  assert.equal(response.occupancy.slots.length, 4);
  assert.equal(response.occupancy.slots.filter((x) => x.busy).length, 2);
  assert.deepEqual(response.occupancy.queuedTaskIds, ['q1']);
  assert.equal(response.runnerMinutes.available, true);
  assert.equal(response.runnerMinutes.minutes, 1);
});

// ---------------------------------------------------------------------------
// console-design-pixel-merge — per-task process-scope section in /metrics,
// driven through the REAL compiled foldTaskSamples + ResourceSamplerService
// (white-box snapshot/process state, same pattern as resource-sampler-process).
// ---------------------------------------------------------------------------

const ctSample = (taskId, cpu, mem) => ({
  taskId,
  cpuPercent: cpu,
  memoryBytes: mem,
  memoryLimitBytes: 8e9,
  memoryPercent: (mem / 8e9) * 100,
});

const ctSnapshot = (containers, sampledAtMs) => ({
  status: 'available',
  sampledAt: new Date(sampledAtMs),
  ageMs: 0,
  hasActiveContainers: containers.length > 0,
  containers,
  aggregateCpuPercent: containers.reduce((a, c) => a + c.cpuPercent, 0),
  aggregateMemoryBytes: containers.reduce((a, c) => a + c.memoryBytes, 0),
});

test('per-task section: entries for running tasks — process primary, container fallback', () => {
  const s = makeSampler();
  s.lastSnapshot = ctSnapshot([ctSample('t1', 2.3, 1.5e9), ctSample('t2', 1.1, 9e8)], 1_000);
  // t1 has an in-sandbox codex process sample; t2 does not (fallback).
  s.processSamples = new Map([
    ['t1', { sample: ctSample('t1', 5, 1.26e8), freshAtMs: 1_000, misses: 0 }],
  ]);

  const resources = s.currentSnapshot(1_000);
  const folded = foldTaskSamples(['t1', 't2'], (id) => s.taskReading(id, 1_000), resources);

  assert.deepEqual(Object.keys(folded).sort(), ['t1', 't2'], 'entries keyed by taskId');
  assert.equal(folded.t1.scope, 'process', 'codex process scope is primary');
  assert.equal(folded.t1.sample.memoryBytes, 1.26e8, 'codex subtree figure, not container total');
  assert.equal(folded.t1.stale, false, 'fresh frame is not stale');
  assert.equal(folded.t2.scope, 'container', 'container fallback when no process reading');
  assert.equal(folded.t2.sample.memoryBytes, 9e8, 'container aggregate carried, not dropped/zeroed');
  // Latest frame ONLY — no history/time-series structure.
  assert.deepEqual(
    Object.keys(folded.t1).sort(),
    ['ageMs', 'sample', 'sampledAt', 'scope', 'stale'],
    'entry carries exactly one latest frame + freshness',
  );
  assert.ok(Object.values(folded.t1).every((v) => !Array.isArray(v)), 'no arrays in an entry');
});

test('per-task section: carry-forward on a transient miss → kept and flagged stale', () => {
  const s = makeSampler();
  // The block sampled freshly at t=6000, but t1's process frame is from t=1000
  // (it missed the latest tick and was carried forward, misses=1).
  s.lastSnapshot = ctSnapshot([ctSample('t1', 2.3, 1.5e9)], 6_000);
  s.processSamples = new Map([
    ['t1', { sample: ctSample('t1', 5, 1.26e8), freshAtMs: 1_000, misses: 1 }],
  ]);

  const resources = s.currentSnapshot(6_000);
  const folded = foldTaskSamples(['t1'], (id) => s.taskReading(id, 6_000), resources);

  assert.ok(folded.t1, 'carried-forward task does NOT disappear');
  assert.equal(folded.t1.scope, 'process', 'prior process reading surfaced, not flipped');
  assert.equal(folded.t1.stale, true, 'carried-forward frame flagged stale');
  assert.equal(folded.t1.ageMs, 5_000, 'age reflects the missed ticks');
  assert.equal(folded.t1.sample.cpuPercent, 5, 'prior reading, never fabricated zeros');
});

test('per-task section: degraded block marks entries stale; non-running tasks omitted', () => {
  const s = makeSampler();
  s.lastSnapshot = ctSnapshot([ctSample('t1', 2.3, 1.5e9)], 1_000);
  s.processSamples = new Map([
    ['t1', { sample: ctSample('t1', 5, 1.26e8), freshAtMs: 1_000, misses: 0 }],
  ]);

  // Query far past staleAfterMs(3000): the block degrades to 'stale' — the
  // per-task entries inherit the degradation honestly.
  const stale = s.currentSnapshot(5_000);
  assert.equal(stale.status, 'stale');
  const foldedStale = foldTaskSamples(['t1'], (id) => s.taskReading(id, 5_000), stale);
  assert.equal(foldedStale.t1.stale, true, 'block staleness bounds per-task freshness');

  // 'gone' is claimed running but has NO live frame (left the sampled set past
  // the carry-forward bound) → omitted, never zero-filled.
  const fresh = s.currentSnapshot(1_000);
  const folded = foldTaskSamples(['t1', 'gone'], (id) => s.taskReading(id, 1_000), fresh);
  assert.ok(!('gone' in folded), 'no-frame task omitted from the section');
  assert.deepEqual(Object.keys(folded), ['t1'], 'only sampled running tasks appear');
});

// ---------------------------------------------------------------------------
// ADDITIVE-CONTRACT assertion — every prior field unchanged in name/type; the
// extension only ADDS fields (no new endpoint family / capability flag rides
// the contract: taskSamples lives inside the existing resources block).
// ---------------------------------------------------------------------------

test('additive contract: a prior-shape /metrics payload (no taskSamples) still parses', () => {
  const priorShape = {
    capacity: { ceiling: 2, active: 1, free: 1, queueDepth: 0 },
    occupancy: {
      slots: [
        { slot: 0, busy: true, taskId: 't1' },
        { slot: 1, busy: false, taskId: null },
      ],
      queuedTaskIds: [],
    },
    runnerMinutes: { available: false, minutes: null },
    resources: {
      status: 'available',
      sampledAt: new Date(1_000).toISOString(),
      ageMs: 0,
      hasActiveContainers: true,
      containers: [ctSample('t1', 2.3, 1.5e9)],
      aggregateCpuPercent: 2.3,
      aggregateMemoryBytes: 1.5e9,
    },
  };
  const parsed = MetricsResponseSchema.safeParse(priorShape);
  assert.ok(parsed.success, 'pre-extension payload remains valid — fields were only added');
});

test('additive contract: real build() response keeps every prior field name/type and gains taskSamples', () => {
  const sem = makeSemaphore(2, ['t1'], []);
  const guardrails = {
    semaphoreProjection: () => sem,
    runnerMinuteIntervals: () => [{ taskId: 't1', startedAt: 0, endedAt: 60_000 }],
  };
  const s = makeSampler();
  s.lastSnapshot = ctSnapshot([ctSample('t1', 2.3, 1.5e9)], 1_000);
  s.processSamples = new Map([
    ['t1', { sample: ctSample('t1', 5, 1.26e8), freshAtMs: 1_000, misses: 0 }],
  ]);

  const res = new MetricsService(guardrails, s).build(1_000);

  // The whole composed response validates against the shared zod contract.
  const parsed = MetricsResponseSchema.parse(res);

  // Prior top-level/field names unchanged (nothing renamed or removed)...
  assert.deepEqual(Object.keys(parsed).sort(), ['capacity', 'occupancy', 'resources', 'runnerMinutes']);
  assert.deepEqual(Object.keys(parsed.capacity).sort(), ['active', 'ceiling', 'free', 'queueDepth']);
  assert.deepEqual(Object.keys(parsed.occupancy).sort(), ['queuedTaskIds', 'slots']);
  assert.deepEqual(Object.keys(parsed.runnerMinutes).sort(), ['available', 'minutes']);
  for (const k of [
    'status',
    'sampledAt',
    'ageMs',
    'hasActiveContainers',
    'containers',
    'aggregateCpuPercent',
    'aggregateMemoryBytes',
  ]) {
    assert.ok(k in parsed.resources, `prior resources.${k} still present`);
  }
  // ... with prior types intact.
  assert.equal(typeof parsed.capacity.ceiling, 'number');
  assert.equal(typeof parsed.capacity.active, 'number');
  assert.equal(typeof parsed.capacity.free, 'number');
  assert.equal(typeof parsed.capacity.queueDepth, 'number');
  assert.ok(Array.isArray(parsed.occupancy.slots));
  assert.ok(Array.isArray(parsed.occupancy.queuedTaskIds));
  assert.equal(typeof parsed.runnerMinutes.available, 'boolean');
  assert.equal(typeof parsed.runnerMinutes.minutes, 'number');
  assert.equal(typeof parsed.resources.status, 'string');
  assert.ok(parsed.resources.sampledAt instanceof Date);
  assert.equal(typeof parsed.resources.ageMs, 'number');
  assert.equal(typeof parsed.resources.hasActiveContainers, 'boolean');
  assert.ok(Array.isArray(parsed.resources.containers));
  assert.equal(typeof parsed.resources.aggregateCpuPercent, 'number');
  assert.equal(typeof parsed.resources.aggregateMemoryBytes, 'number');

  // The ONLY addition: the per-task section, populated for the running task.
  assert.ok(parsed.resources.taskSamples, 'served response carries taskSamples');
  assert.ok(parsed.resources.taskSamples.t1, 'running task present in the section');
  assert.equal(parsed.resources.taskSamples.t1.scope, 'process');
});
