/**
 * Minimal test for requirement:
 *   "Concurrency semaphore bounds running tasks"
 *
 * Requirement semantics (from semaphore.ts JSDoc):
 *   1. Tasks offered while under the cap are admitted immediately (running).
 *   2. Tasks offered once the cap is full are queued (not running).
 *   3. runningCount never exceeds maxConcurrentTasks at any point.
 *   4. On release, the oldest queued task is admitted (FIFO), and onAdmit is
 *      called for it exactly once.
 *   5. Releasing a queued-but-not-running task drops it without admitting a
 *      replacement (it held no slot).
 *   6. offer() is idempotent for already-tracked tasks.
 *   7. Invalid maxConcurrentTasks (0 or non-integer) throws on construction.
 *
 * Runtime-mutable ceiling semantics (configurable-task-slots):
 *   8. Raising the ceiling from N to N+k with k tasks queued promotes the k
 *      oldest queued tasks in FIFO order immediately (no release needed).
 *   9. Lowering the ceiling below the running count evicts nothing; the running
 *      count converges down as tasks release, then FIFO admission resumes.
 *  10. Invalid setter values (0, negative, non-integer) are rejected and leave
 *      the ceiling, running set, and queue unchanged.
 */

// ---- inline the class (mirrors semaphore.ts, no transpile step needed) ----

class ConcurrencySemaphore {
  constructor(options) {
    if (!Number.isInteger(options.maxConcurrentTasks) || options.maxConcurrentTasks < 1) {
      throw new Error(
        `MAX_CONCURRENT_TASKS must be a positive integer, received: ${String(options.maxConcurrentTasks)}`,
      );
    }
    this.maxConcurrentTasks = options.maxConcurrentTasks;
    this.onAdmit = options.onAdmit;
    this.running = new Set();
    this.queue = [];
  }

  get runningCount() { return this.running.size; }
  get queuedCount() { return this.queue.length; }
  get hasCapacity() { return this.running.size < this.maxConcurrentTasks; }
  isRunning(taskId) { return this.running.has(taskId); }
  isQueued(taskId) { return this.queue.includes(taskId); }

  offer(taskId) {
    if (this.running.has(taskId)) return 'running';
    if (this.queue.includes(taskId)) return 'queued';
    if (this.hasCapacity) {
      this.running.add(taskId);
      return 'running';
    }
    this.queue.push(taskId);
    return 'queued';
  }

  release(taskId) {
    const wasRunning = this.running.delete(taskId);
    if (!wasRunning) {
      const idx = this.queue.indexOf(taskId);
      if (idx !== -1) this.queue.splice(idx, 1);
      return null;
    }
    return this._admitNext();
  }

  setMaxConcurrentTasks(maxConcurrentTasks) {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
      throw new Error(
        `maxConcurrentTasks must be a positive integer, received: ${String(maxConcurrentTasks)}`,
      );
    }
    this.maxConcurrentTasks = maxConcurrentTasks;
    while (this._admitNext() !== null) {
      // back-fill on raise; first call returns null on lower / empty queue
    }
  }

  _admitNext() {
    if (!this.hasCapacity || this.queue.length === 0) return null;
    const next = this.queue.shift();
    if (next === undefined) return null;
    this.running.add(next);
    this.onAdmit?.(next);
    return next;
  }

  snapshotRunning() { return [...this.running]; }
  snapshotQueue()   { return [...this.queue]; }
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

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  FAIL  ${label}  (expected throw, got nothing)`);
    failed++;
  } catch {
    console.log(`  PASS  ${label}`);
    passed++;
  }
}

// ---- tests ----

console.log('\n=== Concurrency semaphore: bounds running tasks ===\n');

// T1: tasks under the cap are admitted immediately; runningCount tracks them
{
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: 3 });

  const r1 = sem.offer('t1');
  const r2 = sem.offer('t2');
  const r3 = sem.offer('t3');

  assert(r1 === 'running', 'T1a: first task admitted as running');
  assert(r2 === 'running', 'T1b: second task admitted as running');
  assert(r3 === 'running', 'T1c: third task admitted as running (cap=3)');
  assert(sem.runningCount === 3, 'T1d: runningCount equals 3');
  assert(sem.queuedCount === 0, 'T1e: nothing queued');
}

// T2: tasks over the cap are queued; runningCount stays at cap
{
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: 2 });

  sem.offer('t1');
  sem.offer('t2'); // cap reached

  const r3 = sem.offer('t3');
  const r4 = sem.offer('t4');

  assert(r3 === 'queued', 'T2a: task beyond cap is queued');
  assert(r4 === 'queued', 'T2b: second task beyond cap is also queued');
  assert(sem.runningCount === 2, 'T2c: runningCount does not exceed cap (2)');
  assert(sem.queuedCount === 2, 'T2d: queuedCount is 2');
}

// T3: runningCount never exceeds maxConcurrentTasks (stress: offer many)
{
  const cap = 3;
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: cap });

  for (let i = 0; i < 10; i++) {
    sem.offer(`task-${i}`);
    assert(
      sem.runningCount <= cap,
      `T3-offer${i}: runningCount (${sem.runningCount}) <= cap (${cap})`,
    );
  }
}

// T4: on release, oldest queued task is admitted (FIFO) and onAdmit fires
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 1,
    onAdmit: (id) => admitted.push(id),
  });

  sem.offer('first');  // running
  sem.offer('second'); // queued (FIFO position 0)
  sem.offer('third');  // queued (FIFO position 1)

  assert(sem.runningCount === 1, 'T4a: 1 running before any release');
  assert(sem.queuedCount === 2, 'T4b: 2 queued before any release');

  const admitted1 = sem.release('first');

  assert(admitted1 === 'second', 'T4c: release admits oldest queued task');
  assert(admitted.length === 1, 'T4d: onAdmit called exactly once after release');
  assert(admitted[0] === 'second', 'T4e: onAdmit receives the admitted task id');
  assert(sem.runningCount === 1, 'T4f: runningCount back to 1 after slot-release+admit');
  assert(sem.queuedCount === 1, 'T4g: one task still queued');
  assert(sem.isRunning('second'), 'T4h: second is now running');
  assert(sem.isQueued('third'), 'T4i: third is still queued');
}

// T5: releasing a queued-but-not-running task drops it without admitting a
//     replacement (it held no slot)
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 1,
    onAdmit: (id) => admitted.push(id),
  });

  sem.offer('runner');  // running
  sem.offer('waiter');  // queued

  const result = sem.release('waiter'); // drop from queue, no slot freed

  assert(result === null, 'T5a: release of queued task returns null');
  assert(admitted.length === 0, 'T5b: onAdmit not called (no slot freed)');
  assert(sem.runningCount === 1, 'T5c: runner still occupies its slot');
  assert(sem.queuedCount === 0, 'T5d: waiter removed from queue');
  assert(!sem.isQueued('waiter'), 'T5e: waiter is no longer queued');
}

// T6: offer() is idempotent for already-tracked tasks
{
  const sem = new ConcurrencySemaphore({ maxConcurrentTasks: 1 });

  sem.offer('r1');  // running
  sem.offer('q1');  // queued

  assert(sem.offer('r1') === 'running', 'T6a: re-offer running task returns running');
  assert(sem.offer('q1') === 'queued',  'T6b: re-offer queued task returns queued');
  assert(sem.runningCount === 1, 'T6c: runningCount unchanged by idempotent offers');
  assert(sem.queuedCount === 1, 'T6d: queuedCount unchanged by idempotent offers');
}

// T7: FIFO ordering preserved across multiple releases
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 2,
    onAdmit: (id) => admitted.push(id),
  });

  // Fill cap
  sem.offer('r1');
  sem.offer('r2');
  // Queue three more in order
  sem.offer('q1');
  sem.offer('q2');
  sem.offer('q3');

  sem.release('r1'); // admits q1
  sem.release('r2'); // admits q2

  assert(admitted[0] === 'q1', 'T7a: first admitted is q1 (FIFO)');
  assert(admitted[1] === 'q2', 'T7b: second admitted is q2 (FIFO)');
  assert(sem.queuedCount === 1, 'T7c: q3 still queued');
  assert(sem.isQueued('q3'), 'T7d: q3 is the remaining queued task');
}

// T8: invalid maxConcurrentTasks throws on construction
{
  assertThrows(
    () => new ConcurrencySemaphore({ maxConcurrentTasks: 0 }),
    'T8a: maxConcurrentTasks=0 throws',
  );
  assertThrows(
    () => new ConcurrencySemaphore({ maxConcurrentTasks: -1 }),
    'T8b: maxConcurrentTasks=-1 throws',
  );
  assertThrows(
    () => new ConcurrencySemaphore({ maxConcurrentTasks: 1.5 }),
    'T8c: maxConcurrentTasks=1.5 throws',
  );
}

// T9: raising the ceiling from N to N+k with k queued promotes the k oldest
//     queued tasks in FIFO order immediately (no release required)
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 2, // N = 2
    onAdmit: (id) => admitted.push(id),
  });

  sem.offer('r1');
  sem.offer('r2'); // cap reached
  sem.offer('q1');
  sem.offer('q2');
  sem.offer('q3');

  sem.setMaxConcurrentTasks(4); // raise by k = 2

  assert(sem.maxConcurrentTasks === 4, 'T9a: ceiling reflects the raise (4)');
  assert(admitted.length === 2, 'T9b: exactly k=2 tasks promoted immediately');
  assert(admitted[0] === 'q1', 'T9c: oldest queued task promoted first (FIFO)');
  assert(admitted[1] === 'q2', 'T9d: second-oldest promoted second (FIFO)');
  assert(sem.runningCount === 4, 'T9e: runningCount filled to the new ceiling');
  assert(sem.queuedCount === 1, 'T9f: remaining task stays queued');
  assert(sem.isRunning('q1') && sem.isRunning('q2'), 'T9g: promoted tasks are running');
  assert(sem.isQueued('q3'), 'T9h: q3 is the remaining queued task');

  // Raising past the backlog size empties the queue without overshooting.
  sem.setMaxConcurrentTasks(10);
  assert(admitted[2] === 'q3', 'T9i: further raise promotes the last queued task');
  assert(sem.runningCount === 5, 'T9j: runningCount only grows by available backlog');
  assert(sem.queuedCount === 0, 'T9k: queue emptied by the raise');
}

// T10: lowering the ceiling below the running count evicts nothing and the
//      running count converges as tasks release; FIFO admission then resumes
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 3,
    onAdmit: (id) => admitted.push(id),
  });

  sem.offer('r1');
  sem.offer('r2');
  sem.offer('r3'); // cap reached
  sem.offer('q1'); // queued

  sem.setMaxConcurrentTasks(1); // lower below running count

  assert(sem.maxConcurrentTasks === 1, 'T10a: ceiling reflects the lower (1)');
  assert(sem.runningCount === 3, 'T10b: no running task evicted by the lower');
  assert(
    sem.isRunning('r1') && sem.isRunning('r2') && sem.isRunning('r3'),
    'T10c: all three running tasks keep their slots',
  );
  assert(sem.queuedCount === 1, 'T10d: queued task stays queued (no admission)');
  assert(admitted.length === 0, 'T10e: onAdmit not called on a lower');

  sem.release('r1'); // running 3 -> 2, still above ceiling 1
  assert(sem.runningCount === 2, 'T10f: release converges count without back-fill');
  assert(admitted.length === 0, 'T10g: no admission while over the new ceiling');

  sem.release('r2'); // running 2 -> 1, at ceiling, still no capacity
  assert(sem.runningCount === 1, 'T10h: count converges to the new ceiling');
  assert(admitted.length === 0, 'T10i: no admission at the ceiling');

  sem.release('r3'); // running 1 -> 0, capacity free again: FIFO resumes
  assert(admitted.length === 1 && admitted[0] === 'q1', 'T10j: FIFO admission resumes (q1)');
  assert(sem.runningCount === 1, 'T10k: runningCount back at the ceiling');
  assert(sem.queuedCount === 0, 'T10l: queue drained after convergence');
}

// T11: invalid setter values are rejected and leave ceiling/running/queue intact
{
  const admitted = [];
  const sem = new ConcurrencySemaphore({
    maxConcurrentTasks: 2,
    onAdmit: (id) => admitted.push(id),
  });

  sem.offer('r1');
  sem.offer('r2');
  sem.offer('q1');

  for (const bad of [0, -1, 2.5, NaN]) {
    assertThrows(
      () => sem.setMaxConcurrentTasks(bad),
      `T11-throw(${String(bad)}): setter rejects invalid value`,
    );
  }

  assert(sem.maxConcurrentTasks === 2, 'T11a: ceiling unchanged after rejections');
  assert(sem.runningCount === 2, 'T11b: running set size unchanged');
  assert(
    sem.isRunning('r1') && sem.isRunning('r2'),
    'T11c: running membership unchanged',
  );
  assert(sem.queuedCount === 1 && sem.isQueued('q1'), 'T11d: queue unchanged');
  assert(admitted.length === 0, 'T11e: onAdmit never fired during rejections');
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
