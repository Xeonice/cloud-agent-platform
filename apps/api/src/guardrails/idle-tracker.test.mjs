/**
 * Minimal test for requirement:
 *   "Idle ceiling reclaims wedged tasks" — now PER-TASK and OPT-IN.
 *
 * Requirement semantics (from idle-tracker.ts JSDoc, task-guardrail-controls):
 *   1. A task is tracked only when explicitly started WITH its own ceiling
 *      (`start(taskId, maxIdleMs)`); after `maxIdleMs` with no activity,
 *      onIdleExceeded fires exactly once and the task is removed from tracking.
 *   2. Any qualifying activity (terminal output OR hook event) resets the idle
 *      window against THAT task's own ceiling; the full ceiling must elapse again.
 *   3. A task stopped voluntarily (stop()) before the ceiling elapses does NOT
 *      fire onIdleExceeded.
 *   4. Recording activity for an untracked (already-reclaimed/stopped/never-armed)
 *      task is a no-op and does NOT re-arm the task — this is the default for a
 *      task created without an idle ceiling (never tracked → never reclaimed).
 *   5. Multiple tasks are tracked independently, each at its OWN ceiling.
 *   6. Invalid maxIdleMs (0 or non-finite) throws from start() (the ceiling is
 *      now per-task, so validation moved off the constructor).
 *   7. stopAll() clears all tracked tasks; none fire onIdleExceeded after that.
 *   8. Stale-timer guard: a timer scheduled before a reset does NOT cause a
 *      premature fire; it re-arms for the remaining gap against the task ceiling.
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
    this.onIdleExceeded = options.onIdleExceeded;
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? defaultTimer;
    this.tracked = new Map();
  }

  get trackedCount() { return this.tracked.size; }
  isTracking(taskId) { return this.tracked.has(taskId); }

  start(taskId, maxIdleMs) {
    if (!(maxIdleMs > 0) || !Number.isFinite(maxIdleMs)) {
      throw new Error(
        `idle ceiling must be a positive number of milliseconds, received: ${String(maxIdleMs)}`,
      );
    }
    this._armFromNow(taskId, maxIdleMs);
  }

  recordActivity(taskId) {
    const existing = this.tracked.get(taskId);
    if (!existing) return;
    this._armFromNow(taskId, existing.maxIdleMs);
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

  _armFromNow(taskId, maxIdleMs) {
    const existing = this.tracked.get(taskId);
    if (existing) this.timer.clearTimeout(existing.handle);
    const startedAt = this.now();
    const handle = this.timer.setTimeout(() => this._onIdle(taskId), maxIdleMs);
    this.tracked.set(taskId, { lastActivityEpochMs: startedAt, handle, maxIdleMs });
  }

  _onIdle(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return;
    const idleFor = this.now() - entry.lastActivityEpochMs;
    if (idleFor < entry.maxIdleMs) {
      const remaining = entry.maxIdleMs - idleFor;
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
    advance(deltaMs) {
      nowMs += deltaMs;
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

console.log('\n=== IdleTracker: per-task, opt-in idle ceiling ===\n');

// T1 — basic reclamation at the task's own ceiling.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-A', 1000);
  assert(tracker.isTracking('task-A'), 'T1a: task is tracked after start(id, ceiling)');

  clock.advance(999);
  assert(exceeded.length === 0, 'T1b: onIdleExceeded not called before ceiling');

  clock.advance(1);
  assert(exceeded.length === 1, 'T1c: onIdleExceeded called exactly once at ceiling');
  assert(exceeded[0] === 'task-A', 'T1d: onIdleExceeded receives correct taskId');
  assert(!tracker.isTracking('task-A'), 'T1e: task removed from tracking after reclamation');
  assert(tracker.trackedCount === 0, 'T1f: trackedCount is 0 after reclamation');
}

// T2 — activity resets the window against the task's own ceiling.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-B', 1000);
  clock.advance(800);
  tracker.recordActivity('task-B');
  clock.advance(999);
  assert(exceeded.length === 0, 'T2a: no reclamation 999 ms after activity reset');

  clock.advance(1);
  assert(exceeded.length === 1, 'T2b: reclaimed after full ceiling post-reset');
  assert(exceeded[0] === 'task-B', 'T2c: correct taskId reclaimed after reset');
}

// T3 — voluntary stop cancels reclamation.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('task-C', 1000);
  clock.advance(500);
  tracker.stop('task-C');
  assert(!tracker.isTracking('task-C'), 'T3a: task removed after stop()');

  clock.advance(600);
  assert(exceeded.length === 0, 'T3b: onIdleExceeded NOT fired after voluntary stop()');
}

// T4 — activity on untracked task is no-op (the DEFAULT for a task never armed).
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  // A task that was never start()-ed (no idle ceiling) is not tracked, and
  // recording activity for it never arms a timer — it can never be reclaimed.
  tracker.recordActivity('never-armed');
  assert(!tracker.isTracking('never-armed'), 'T4a: recordActivity never arms an unstarted task');
  clock.advance(10_000);
  assert(exceeded.length === 0, 'T4b: an unstarted task is never reclaimed for idleness');

  tracker.start('task-D', 500);
  clock.advance(500);
  assert(exceeded.length === 1, 'T4c: task-D reclaimed at its ceiling');
  tracker.recordActivity('task-D');
  assert(!tracker.isTracking('task-D'), 'T4d: recordActivity does not re-arm reclaimed task');
  clock.advance(1000);
  assert(exceeded.length === 1, 'T4e: no second onIdleExceeded for untracked task');
}

// T5 — multiple tasks tracked independently, each at its OWN ceiling.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('short', 1000); // small ceiling
  tracker.start('long', 5000);  // large ceiling, started at the same instant

  clock.advance(1000); // short hits its ceiling, long is far from its
  assert(exceeded.includes('short'), 'T5a: short reclaimed at its own 1000ms ceiling');
  assert(!exceeded.includes('long'), 'T5b: long not reclaimed (its ceiling is 5000ms)');

  clock.advance(4000); // now=5000 — long hits its own ceiling
  assert(exceeded.includes('long'), 'T5c: long reclaimed at its own 5000ms ceiling');
  assert(exceeded.length === 2, 'T5d: exactly two reclamations, each at its own ceiling');
}

// T6 — invalid ceiling throws from start() (validation moved off the constructor).
{
  const tracker = new IdleTracker({ onIdleExceeded: () => {} });
  assertThrows(() => tracker.start('z', 0), 'T6a: start ceiling=0 throws');
  assertThrows(() => tracker.start('z', -1), 'T6b: start ceiling=-1 throws');
  assertThrows(() => tracker.start('z', Infinity), 'T6c: start ceiling=Infinity throws');
  assertThrows(() => tracker.start('z', NaN), 'T6d: start ceiling=NaN throws');
  assert(tracker.trackedCount === 0, 'T6e: no task is tracked after a rejected ceiling');
}

// T7 — stopAll() cancels all tracked tasks.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('x1', 1000);
  tracker.start('x2', 1000);
  assert(tracker.trackedCount === 2, 'T7a: two tasks tracked');

  tracker.stopAll();
  assert(tracker.trackedCount === 0, 'T7b: trackedCount=0 after stopAll');

  clock.advance(2000);
  assert(exceeded.length === 0, 'T7c: no onIdleExceeded fired after stopAll');
}

// T8 — stale-timer guard re-arms against the task's own ceiling.
{
  const clock = makeVirtualClock();
  const exceeded = [];
  const tracker = new IdleTracker({
    onIdleExceeded: (id) => exceeded.push(id),
    now: clock.now,
    timer: clock.timer,
  });

  tracker.start('stale-guard', 1000);
  clock.advance(600);
  tracker.recordActivity('stale-guard'); // new lastActivity = t=600

  clock.advance(399); // t=999
  assert(exceeded.length === 0, 'T8a: no reclamation at t=999 after reset at t=600');
  clock.advance(1); // t=1000 — only 400ms since reset
  assert(exceeded.length === 0, 'T8b: no reclamation at t=1000 (only 400ms since reset)');
  clock.advance(600); // t=1600 — full ceiling after reset
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
