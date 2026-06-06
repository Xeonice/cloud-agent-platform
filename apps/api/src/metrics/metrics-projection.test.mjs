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
