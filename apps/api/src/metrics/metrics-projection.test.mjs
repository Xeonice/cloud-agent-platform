/**
 * Tests for the pure derived-capacity projection (be-metrics 5.1 & 5.2).
 *
 * Requirement semantics (from metrics-projection.ts):
 *   1. projectCapacity reads ceiling/active/free/queueDepth from ONE live
 *      semaphore reading; active===runningCount, queueDepth===queuedCount,
 *      free===ceiling-active, free never negative, active+free===ceiling.
 *   2. buildSlotOccupancy emits EXACTLY `ceiling` slots; busy count===active,
 *      idle count===free; queuedTaskIds is the FIFO queue, separate from slots;
 *      queuedTaskIds.length===queueDepth.
 *   3. Slot table and scalar block are mutually consistent.
 *   4. Reads are LIVE: mutating the fake between reads changes the projection
 *      (no cached/parallel counter).
 *   5. Never invents slots beyond ceiling, even if running > ceiling.
 *   6. foldTaskSamples (console-design-pixel-merge): per-task entries keyed by
 *      taskId for running tasks only, latest frame ONLY (no history), scope
 *      passthrough (process primary / container fallback), carried-forward
 *      frames flagged stale instead of dropped, non-running/left-set tasks
 *      omitted — never fabricated zeros.
 */

// ---- inline the pure functions (mirror metrics-projection.ts) ----

function projectCapacity(semaphore) {
  const ceiling = semaphore.maxConcurrentTasks;
  const active = semaphore.runningCount;
  const free = Math.max(0, ceiling - active);
  const queueDepth = semaphore.queuedCount;
  return { ceiling, active, free, queueDepth };
}

function buildSlotOccupancy(semaphore) {
  const ceiling = semaphore.maxConcurrentTasks;
  const running = semaphore.snapshotRunning();
  const queuedTaskIds = semaphore.snapshotQueue();
  const slots = [];
  for (let slot = 0; slot < ceiling; slot += 1) {
    const taskId = slot < running.length ? running[slot] : null;
    slots.push({ slot, busy: taskId !== null, taskId });
  }
  return { slots, queuedTaskIds };
}

function foldTaskSamples(runningTaskIds, readTask, resources) {
  const samples = {};
  const blockFresh = resources.status === 'available';
  for (const taskId of runningTaskIds) {
    const reading = readTask(taskId);
    if (!reading || reading.sampledAt === null || reading.ageMs === null) {
      continue;
    }
    const carriedForward =
      resources.ageMs === null || reading.ageMs > resources.ageMs;
    samples[taskId] = {
      scope: reading.scope,
      sample: reading.sample,
      sampledAt: reading.sampledAt,
      ageMs: reading.ageMs,
      stale: !blockFresh || carriedForward,
    };
  }
  return samples;
}

// ---- a fake semaphore source (mutable, live) ----

function makeFake(ceiling, running, queued) {
  return {
    maxConcurrentTasks: ceiling,
    get runningCount() {
      return this._running.length;
    },
    get queuedCount() {
      return this._queued.length;
    },
    _running: [...running],
    _queued: [...queued],
    snapshotRunning() {
      return [...this._running];
    },
    snapshotQueue() {
      return [...this._queued];
    },
  };
}

// ---- assertion helpers ----

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// T1: scalar projection invariants on a partially-full semaphore.
{
  const fake = makeFake(5, ['r1', 'r2', 'r3'], ['q1', 'q2']);
  const cap = projectCapacity(fake);
  assert(cap.ceiling === 5, 'T1a: ceiling===maxConcurrentTasks');
  assert(cap.active === 3, 'T1b: active===runningCount');
  assert(cap.free === 2, 'T1c: free===ceiling-active');
  assert(cap.active + cap.free === cap.ceiling, 'T1d: active+free===ceiling');
  assert(cap.queueDepth === 2, 'T1e: queueDepth===queuedCount');
}

// T2: free never negative; active+free still ===ceiling when over-admitted.
{
  const fake = makeFake(3, ['r1', 'r2', 'r3', 'r4'], []); // pathological: 4 > 3
  const cap = projectCapacity(fake);
  assert(cap.free === 0, 'T2a: free clamped at 0 when active>ceiling');
  assert(cap.free >= 0, 'T2b: free never negative');
}

// T3: slot table has exactly `ceiling` entries; busy/idle counts match scalars.
{
  const fake = makeFake(5, ['r1', 'r2', 'r3'], ['q1', 'q2']);
  const cap = projectCapacity(fake);
  const occ = buildSlotOccupancy(fake);
  assert(occ.slots.length === 5, 'T3a: exactly ceiling slots');
  const busy = occ.slots.filter((s) => s.busy);
  const idle = occ.slots.filter((s) => !s.busy);
  assert(busy.length === cap.active, 'T3b: busy count===active');
  assert(idle.length === cap.free, 'T3c: idle count===free');
  assert(
    busy.every((s) => s.taskId !== null) && idle.every((s) => s.taskId === null),
    'T3d: busy carry taskId, idle carry null',
  );
  assert(
    eq(busy.map((s) => s.taskId), ['r1', 'r2', 'r3']),
    'T3e: busy slots carry the running task ids',
  );
}

// T4: queue reported separately, in FIFO order, length===queueDepth.
{
  const fake = makeFake(5, ['r1'], ['q1', 'q2', 'q3']);
  const cap = projectCapacity(fake);
  const occ = buildSlotOccupancy(fake);
  assert(eq(occ.queuedTaskIds, ['q1', 'q2', 'q3']), 'T4a: queuedTaskIds in FIFO order');
  assert(occ.queuedTaskIds.length === cap.queueDepth, 'T4b: queue length===queueDepth');
  // queued ids must NOT appear in the slot table (separate from free slots).
  const slotIds = occ.slots.map((s) => s.taskId).filter((x) => x !== null);
  assert(
    occ.queuedTaskIds.every((q) => !slotIds.includes(q)),
    'T4c: queued ids never occupy a slot',
  );
}

// T5: full semaphore — zero free slots, all busy, queue still separate.
{
  const fake = makeFake(2, ['r1', 'r2'], ['q1']);
  const cap = projectCapacity(fake);
  const occ = buildSlotOccupancy(fake);
  assert(cap.free === 0, 'T5a: free===0 when full');
  assert(occ.slots.every((s) => s.busy), 'T5b: all slots busy when full');
  assert(occ.slots.length === 2, 'T5c: still exactly ceiling slots');
  assert(cap.queueDepth === 1, 'T5d: queueDepth counts the held task');
}

// T6: empty semaphore — all idle, no queue.
{
  const fake = makeFake(3, [], []);
  const cap = projectCapacity(fake);
  const occ = buildSlotOccupancy(fake);
  assert(cap.active === 0 && cap.free === 3, 'T6a: all free when empty');
  assert(occ.slots.every((s) => !s.busy && s.taskId === null), 'T6b: all slots idle');
  assert(occ.queuedTaskIds.length === 0, 'T6c: empty queue');
}

// T7: never invents slots beyond ceiling even when running > ceiling.
{
  const fake = makeFake(2, ['r1', 'r2', 'r3'], []);
  const occ = buildSlotOccupancy(fake);
  assert(occ.slots.length === 2, 'T7a: slots capped at ceiling, never grown');
  assert(
    eq(occ.slots.map((s) => s.taskId), ['r1', 'r2']),
    'T7b: only the first ceiling running ids get slots',
  );
}

// T8: reads are LIVE — mutating the fake between reads changes the projection.
{
  const fake = makeFake(3, ['r1'], []);
  const before = projectCapacity(fake);
  assert(before.active === 1 && before.free === 2, 'T8a: initial live read');
  fake._running.push('r2'); // a new task takes a slot
  fake._queued.push('q1'); // and one is queued
  const after = projectCapacity(fake);
  const occAfter = buildSlotOccupancy(fake);
  assert(after.active === 2, 'T8b: active reflects the new slot immediately');
  assert(after.free === 1, 'T8c: free recomputed live (no drift)');
  assert(after.queueDepth === 1, 'T8d: queueDepth reflects the new queued task');
  assert(occAfter.slots.filter((s) => s.busy).length === 2, 'T8e: slot table re-derived live');
}

// ---- foldTaskSamples (per-task process-scope section) ----

const mkSample = (taskId, cpu, mem) => ({
  taskId,
  cpuPercent: cpu,
  memoryBytes: mem,
  memoryLimitBytes: 8e9,
  memoryPercent: (mem / 8e9) * 100,
});
const mkReading = (scope, sample, container, atMs, ageMs) => ({
  scope,
  sample,
  container,
  sampledAt: new Date(atMs),
  ageMs,
});
const FRESH_BLOCK = { status: 'available', ageMs: 0 };

// T9: per-task entries present for running tasks, keyed by taskId.
{
  const readings = {
    t1: mkReading('process', mkSample('t1', 5, 1.26e8), mkSample('t1', 2.3, 1.5e9), 1000, 0),
    t2: mkReading('process', mkSample('t2', 1, 0.9e8), mkSample('t2', 1.1, 0.9e9), 1000, 0),
  };
  const folded = foldTaskSamples(['t1', 't2'], (id) => readings[id] ?? null, FRESH_BLOCK);
  assert(eq(Object.keys(folded).sort(), ['t1', 't2']), 'T9a: entries keyed by taskId for running tasks');
  assert(folded.t1.scope === 'process', 'T9b: process scope is primary');
  assert(folded.t1.sample.cpuPercent === 5, 'T9c: server-computed cpuPercent passes through');
  assert(folded.t1.sample.memoryPercent !== null, 'T9d: server-computed memoryPercent present');
  assert(folded.t1.stale === false, 'T9e: fresh frame in a fresh block is not stale');
}

// T10: latest-frame-only shape — exactly one frame per task, no history arrays.
{
  const folded = foldTaskSamples(
    ['t1'],
    () => mkReading('process', mkSample('t1', 5, 1e8), null, 1000, 0),
    FRESH_BLOCK,
  );
  assert(
    eq(Object.keys(folded.t1).sort(), ['ageMs', 'sample', 'sampledAt', 'scope', 'stale']),
    'T10a: entry carries exactly scope/sample/sampledAt/ageMs/stale',
  );
  assert(
    !Array.isArray(folded.t1.sample) && Object.values(folded.t1).every((v) => !Array.isArray(v)),
    'T10b: no history/time-series structure anywhere in the entry',
  );
}

// T11: container fallback when the in-sandbox process reading is unavailable.
{
  const folded = foldTaskSamples(
    ['t1'],
    () => mkReading('container', mkSample('t1', 2.3, 1.5e9), null, 1000, 0),
    FRESH_BLOCK,
  );
  assert(folded.t1.scope === 'container', 'T11a: entry tagged scope container, not dropped');
  assert(folded.t1.sample.memoryBytes === 1.5e9, 'T11b: container-aggregate figure carried');
}

// T12: carry-forward on a transient miss — frame older than the block's latest
// tick stays present, flagged stale (never disappears, never zero-filled).
{
  const carried = mkReading('process', mkSample('t1', 5, 1e8), null, 1000, 5000);
  const folded = foldTaskSamples(['t1'], () => carried, FRESH_BLOCK);
  assert('t1' in folded, 'T12a: carried-forward task still present');
  assert(folded.t1.stale === true, 'T12b: carried-forward frame flagged stale');
  assert(folded.t1.sample.cpuPercent === 5, 'T12c: prior reading surfaced, not zeros');
  // A degraded block (stale/unavailable) marks even same-tick frames stale.
  const degraded = foldTaskSamples(
    ['t1'],
    () => mkReading('process', mkSample('t1', 5, 1e8), null, 1000, 0),
    { status: 'stale', ageMs: 0 },
  );
  assert(degraded.t1.stale === true, 'T12d: degraded block bounds per-task freshness');
}

// T13: non-running/left-set tasks omitted — never fabricated zeros.
{
  const readings = {
    t1: mkReading('process', mkSample('t1', 5, 1e8), null, 1000, 0),
  };
  // 'gone' is in the running list but has no live frame (left the sampled set
  // past the carry-forward bound) → readTask null → omitted.
  const folded = foldTaskSamples(['t1', 'gone'], (id) => readings[id] ?? null, FRESH_BLOCK);
  assert(!('gone' in folded), 'T13a: no-frame task omitted from the section');
  assert(
    Object.values(folded).every((e) => e.sample.cpuPercent !== 0 || e.sample.memoryBytes !== 0),
    'T13b: no fabricated zero entries',
  );
  // Only the running set is consulted: a non-running id never reaches an entry.
  let asked = [];
  foldTaskSamples(['t1'], (id) => (asked.push(id), readings[id] ?? null), FRESH_BLOCK);
  assert(eq(asked, ['t1']), 'T13c: fold consults exactly the running set');
}

// ---- summary ----
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
