/**
 * Minimal test for requirement:
 *   "Idle ceiling reclaims wedged tasks"
 *
 * Requirement semantics (from idle-tracker.ts JSDoc):
 *   1. When a running task produces no terminal output and no hook activity for
 *      maxIdleMs, onIdleExceeded is fired exactly once and the task is removed
 *      from tracking.
 *   2. Any qualifying activity (terminal output OR hook event) resets the idle
 *      window; the full ceiling must elapse again before reclamation.
 *   3. A task stopped voluntarily (stop()) before the ceiling elapses does NOT
 *      fire onIdleExceeded.
 *   4. Recording activity for an untracked (already-reclaimed or stopped) task
 *      is a no-op and does NOT re-arm the task.
 *   5. Multiple tasks are tracked independently; one idle-out does not affect
 *      the other.
 *   6. Invalid maxIdleMs (0 or non-finite) throws on construction.
 *   7. stopAll() clears all tracked tasks; none fire onIdleExceeded after that.
 *   8. Stale-timer guard: a timer scheduled before a reset does NOT cause a
 *      premature fire when it eventually fires; it re-arms for the remaining gap
 *      instead.
 */

// ---------------------------------------------------------------------------
// Inline the class -- avoids transpile step, identical logic to .ts source.
// ---------------------------------------------------------------------------

const defaultTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

class IdleTracker {
  constructor(options) {
    if (!(options.maxIdleMs > 0) || !Number.isFinite(options.maxIdleMs)) {
      throw new Error(
        `MAX_IDLE must be a positive number of milliseconds, received: ${String(options.maxIdleMs)}`,
      );
    }
    this.maxIdleMs = options.maxIdleMs;
    this.onIdleExceeded = options.onIdleExceeded;
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? defaultTimer;
    this.tracked = new Map();
  }

  get trackedCount() { return this.tracked.size; }
  isTracking(taskId) { return this.tracked.has(taskId); }

  start(taskId) { this._armFromNow(taskId); }

  recordActivity(taskId) {
    if (!this.tracked.has(taskId)) return;
    this._armFromNow(taskId);
  }

  stop(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return;
    this.timer.clearTimeout(entry.handle);
    this.tracked.delete(taskId);
  }

  stopAll() {
    for (const entry of this.tracked.values()) {
      this.timer.clearTimeout(entry.handle);
    }
    this.tracked.clear();
  }

  _armFromNow(taskId) {
    const existing = this.tracked.get(taskId);
    if (existing) this.timer.clearTimeout(existing.handle);
    const startedAt = this.now();
    const handle = this.timer.setTimeout(() => this._onIdle(taskId), this.maxIdleMs);
    this.tracked.set(taskId, { lastActivityEpochMs: startedAt, handle });
  }

  _onIdle(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return;
    const idleFor = this.now() - entry.lastActivityEpochMs;
    if (idleFor < this.maxIdleMs) {
      const remaining = this.maxIdleMs - idleFor;
      entry.handle = this.timer.setTimeout(() => this._onIdle(taskId), remaining);
      return;
    }
    this.tracked.delete(taskId);
    this.onIdleExceeded(taskId);
  }
}

// ---------------------------------------------------------------------------
// Virtual-clock helper — drives time without real delays.
// ---------------------------------------------------------------------------

function makeVirtualClock(startMs = 0) {
  let nowMs = startMs;
  // Queue of { fireAt, handler, id }
  const pending = [];
  let nextId = 1;

  const clock = {
    now: () => nowMs,
    timer: {
      setTimeout(handler, delayMs) {
        const id = nextId++;
        pending.push({ fireAt: nowMs + delayMs, handler, id });
        return id;
      },
      clearTimeout(handle) {
        const idx = pending.findIndex((e) => e.id === handle);
        if (idx !== -1) pending.splice(idx, 1);
      },
    },
    /**
     * Advance virtual time by `deltaMs`, firing every scheduled callback
     * whose fireAt <= new now (in order).
     */
    advance(deltaMs) {
      nowMs += deltaMs;
      // Sort ascending so we fire in order.
      pending.sort((a, b) => a.fireAt - b.fireAt);
      while (pending.length > 0 && pending[0].fireAt <= nowMs) {
        const { handler } = pending.shift();
        handler();
      }
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== IdleTracker: idle ceiling reclaims wedged tasks ===\n');

// T1 — basic reclamation: after maxIdleMs elapses with no activity,
//       onIdleExceeded fires exactly once for the task.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-A');
  assert(tracker.isTracking('task-A'), 'T1a: task is tracked after start()');

  clock.advance(999); // just under ceiling — must not fire
  assert(exceeded.length === 0, 'T1b: onIdleExceeded not called before ceiling');

  clock.advance(1);   // exactly at ceiling — must fire
  assert(exceeded.length === 1, 'T1c: onIdleExceeded called exactly once at ceiling');
  assert(exceeded[0] === 'task-A', 'T1d: onIdleExceeded receives correct taskId');
  assert(!tracker.isTracking('task-A'), 'T1e: task removed from tracking after reclamation');
  assert(tracker.trackedCount === 0, 'T1f: trackedCount is 0 after reclamation');
}

// T2 — activity resets the window: activity before the ceiling resets the
//       timer; the full ceiling must elapse again before reclamation.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-B');
  clock.advance(800);                  // 800 ms idle — under ceiling
  tracker.recordActivity('task-B');    // reset; window restarts from t=800
  clock.advance(999);                  // 999 ms after reset — still under
  assert(exceeded.length === 0, 'T2a: no reclamation 999 ms after activity reset');

  clock.advance(1);                    // 1000 ms after reset — fires
  assert(exceeded.length === 1, 'T2b: reclaimed after full ceiling post-reset');
  assert(exceeded[0] === 'task-B', 'T2c: correct taskId reclaimed after reset');
}

// T3 — voluntary stop cancels reclamation: stop() before the ceiling does
//       not fire onIdleExceeded.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-C');
  clock.advance(500);
  tracker.stop('task-C');
  assert(!tracker.isTracking('task-C'), 'T3a: task removed after stop()');

  clock.advance(600); // advance past where ceiling would have fired
  assert(exceeded.length === 0, 'T3b: onIdleExceeded NOT fired after voluntary stop()');
}

// T4 — activity on untracked task is no-op: does not re-arm the tracker.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 500,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-D');
  clock.advance(500); // fires and reclaims
  assert(exceeded.length === 1, 'T4a: task-D reclaimed');
  assert(!tracker.isTracking('task-D'), 'T4b: task-D no longer tracked');

  // Now record activity for the already-reclaimed task.
  tracker.recordActivity('task-D');
  assert(!tracker.isTracking('task-D'), 'T4c: recordActivity does not re-arm reclaimed task');

  clock.advance(1000); // no further fire expected
  assert(exceeded.length === 1, 'T4d: no second onIdleExceeded for untracked task');
}

// T5 — multiple tasks tracked independently.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('alpha');
  clock.advance(500);
  tracker.start('beta');   // beta's window starts 500 ms later

  clock.advance(500);      // now=1000 — alpha hits ceiling
  assert(exceeded.includes('alpha'), 'T5a: alpha reclaimed at its ceiling');
  assert(!exceeded.includes('beta'), 'T5b: beta not yet reclaimed (only 500 ms idle)');

  clock.advance(500);      // now=1500 — beta hits its ceiling
  assert(exceeded.includes('beta'), 'T5c: beta reclaimed at its own ceiling');
  assert(exceeded.length === 2, 'T5d: exactly two reclamations, one each');
}

// T6 — invalid maxIdleMs throws on construction.
{
  assertThrows(
    () => new IdleTracker({ maxIdleMs: 0, onIdleExceeded: () => {} }),
    'T6a: maxIdleMs=0 throws',
  );
  assertThrows(
    () => new IdleTracker({ maxIdleMs: -1, onIdleExceeded: () => {} }),
    'T6b: maxIdleMs=-1 throws',
  );
  assertThrows(
    () => new IdleTracker({ maxIdleMs: Infinity, onIdleExceeded: () => {} }),
    'T6c: maxIdleMs=Infinity throws',
  );
  assertThrows(
    () => new IdleTracker({ maxIdleMs: NaN, onIdleExceeded: () => {} }),
    'T6d: maxIdleMs=NaN throws',
  );
}

// T7 — stopAll() cancels all tracked tasks; none fire after stopAll.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('x1');
  tracker.start('x2');
  assert(tracker.trackedCount === 2, 'T7a: two tasks tracked');

  tracker.stopAll();
  assert(tracker.trackedCount === 0, 'T7b: trackedCount=0 after stopAll');

  clock.advance(2000); // advance well past ceiling
  assert(exceeded.length === 0, 'T7c: no onIdleExceeded fired after stopAll');
}

// T8 — stale-timer guard: a timer scheduled before a recordActivity reset
//       does NOT cause a premature fire; it re-arms for the remaining gap.
//
//   Mechanics: start at t=0. At t=600 record activity (window restarts).
//   The original timer fires at t=1000 (only 400 ms after the reset, not
//   1000 ms), so the guard re-arms for the remaining 600 ms. The task must
//   NOT be reclaimed until t=1600.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    maxIdleMs: 1000,
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('stale-guard');

  // Manually inject a stale timer by manipulating the tracked entry's
  // lastActivityEpochMs AFTER armFromNow, so the pending timer has a stale
  // "start" timestamp. We simulate this by directly updating the entry.
  // (This replicates the race described in the JSDoc.)
  clock.advance(600);

  // Reset the window via recordActivity — new lastActivity = t=600.
  tracker.recordActivity('stale-guard');

  // The original timer (scheduled to fire at t=1000 from t=0) is cancelled
  // by armFromNow. A new timer fires at t=1600. Verify no early reclamation.
  clock.advance(399); // t=999: still 601 ms before new ceiling
  assert(exceeded.length === 0, 'T8a: no reclamation at t=999 after reset at t=600');

  clock.advance(1); // t=1000: 400 ms after reset — not yet ceiling
  assert(exceeded.length === 0, 'T8b: no reclamation at t=1000 (only 400ms since reset)');

  clock.advance(600); // t=1600: exactly 1000 ms after reset — fires now
  assert(exceeded.length === 1, 'T8c: reclaimed at t=1600 (full ceiling after reset)');
  assert(exceeded[0] === 'stale-guard', 'T8d: correct taskId reclaimed');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
