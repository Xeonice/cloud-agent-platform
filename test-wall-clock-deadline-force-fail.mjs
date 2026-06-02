/**
 * Minimal test: Wall-clock deadline force-fails a task (guardrail 12.2)
 *
 * Requirement: A running task that carries a wall-clock deadline MUST be
 * force-failed (transitioned to `failed`) when the deadline elapses before
 * the task reaches a terminal state on its own.
 *
 * Scenarios covered:
 *  1. Deadline fires → onDeadlineExceeded callback is called exactly once.
 *  2. Task cleared before deadline → callback is NOT called (no spurious fail).
 *  3. Deadline already in the past when armed → callback fires on next tick (async).
 *  4. Re-arming replaces the previous deadline (only one callback, at new time).
 *  5. clearAll() disarms all deadlines — no callbacks fire.
 *  6. isWatching() and watchedCount reflect live state accurately.
 *  7. 'running -> failed' is a valid lifecycle edge (deadline trigger is legal).
 *  8. 'failed' is a terminal state — no further transitions are allowed.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { DeadlineWatcher } = require(path.join(
  __dirname,
  'apps/api/dist/guardrails/deadline-watcher.js',
));

const { canTransition, isTerminal } = require(path.join(
  __dirname,
  'apps/api/dist/tasks/task-lifecycle.js',
));

// ─── tiny assertion helper ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

// ─── virtual-timer helpers ────────────────────────────────────────────────────

/**
 * Build a virtual timer that stores pending callbacks keyed by handle, and a
 * controllable clock.  Call `tick(ms)` to advance virtual time and fire any
 * callbacks whose delay has been reached.
 */
function makeVirtualTimer(startMs = 0) {
  let nextHandle = 1;
  let nowMs = startMs;
  const pending = new Map(); // handle -> { fireAt, handler }

  const timer = {
    setTimeout(handler, delayMs) {
      const handle = nextHandle++;
      pending.set(handle, { fireAt: nowMs + delayMs, handler });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
  };

  function tick(ms) {
    nowMs += ms;
    // Fire all callbacks whose fireAt <= nowMs (in order).
    const toFire = [...pending.entries()]
      .filter(([, v]) => v.fireAt <= nowMs)
      .sort(([, a], [, b]) => a.fireAt - b.fireAt);
    for (const [handle, { handler }] of toFire) {
      pending.delete(handle);
      handler();
    }
  }

  function now() {
    return nowMs;
  }

  return { timer, tick, now };
}

// ─── Scenario 1: deadline fires → callback invoked exactly once ───────────────
console.log('\nScenario 1 — deadline fires, callback called exactly once');
{
  const { timer, tick, now } = makeVirtualTimer(0);
  const calls = [];

  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: (id) => calls.push(id),
    now,
    timer,
  });

  watcher.armAfter('task-1', 5_000); // deadline at t=5000
  assert(watcher.isWatching('task-1'), 'task is being watched after armAfter');
  assert(watcher.watchedCount === 1, 'watchedCount is 1 after arming one task');

  tick(3_000); // advance to t=3000 — deadline not yet reached
  assert(calls.length === 0, 'no callback before deadline (t=3000 < 5000)');

  tick(2_000); // advance to t=5000 — deadline fires
  assert(calls.length === 1, 'callback fired exactly once when deadline reached');
  assert(calls[0] === 'task-1', 'callback carries the correct task id');
  assert(!watcher.isWatching('task-1'), 'task is no longer watched after deadline fires');
  assert(watcher.watchedCount === 0, 'watchedCount drops to 0 after deadline fires');
}

// ─── Scenario 2: task cleared before deadline → no callback ──────────────────
console.log('\nScenario 2 — task cleared before deadline, no spurious force-fail');
{
  const { timer, tick, now } = makeVirtualTimer(0);
  const calls = [];

  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: (id) => calls.push(id),
    now,
    timer,
  });

  watcher.armAfter('task-2', 10_000); // deadline at t=10000
  tick(4_000); // still before deadline
  watcher.clear('task-2'); // task finished on its own — cancel the deadline

  assert(!watcher.isWatching('task-2'), 'task no longer watched after clear()');
  tick(10_000); // advance well past where the deadline would have fired
  assert(calls.length === 0, 'no force-fail callback after clear() + tick past deadline');
}

// ─── Scenario 3: deadline already in the past → fires on next tick ───────────
console.log('\nScenario 3 — deadline in the past → fires on next tick (async semantics)');
{
  const { timer, tick, now } = makeVirtualTimer(1_000); // start at t=1000
  const calls = [];

  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: (id) => calls.push(id),
    now,
    timer,
  });

  // Arm with a deadline that is already in the past (epoch 500 < now 1000)
  watcher.arm('task-3', 500);
  assert(calls.length === 0, 'callback not yet fired synchronously (delay clamped to 0 means next tick)');

  tick(0); // zero-advance triggers the 0-delay callback
  assert(calls.length === 1, 'callback fires on next tick (delay=0) for past deadline');
  assert(calls[0] === 'task-3', 'callback carries correct task id for past deadline');
}

// ─── Scenario 4: re-arming replaces previous deadline ────────────────────────
console.log('\nScenario 4 — re-arming replaces previous deadline');
{
  const { timer, tick, now } = makeVirtualTimer(0);
  const calls = [];

  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: (id) => calls.push(id),
    now,
    timer,
  });

  watcher.armAfter('task-4', 3_000); // first deadline at t=3000
  tick(2_000); // t=2000
  watcher.armAfter('task-4', 8_000); // re-arm: new deadline at t=10000

  tick(2_000); // t=4000 — original deadline (t=3000) would have fired; new one hasn't
  assert(calls.length === 0, 'original deadline does not fire after re-arm (replaced)');
  assert(watcher.isWatching('task-4'), 'task still watched under new deadline');

  tick(6_000); // t=10000 — new deadline fires
  assert(calls.length === 1, 'new (re-armed) deadline fires exactly once');
  assert(calls[0] === 'task-4', 'callback carries correct task id after re-arm');
}

// ─── Scenario 5: clearAll() disarms everything ────────────────────────────────
console.log('\nScenario 5 — clearAll() disarms all deadlines');
{
  const { timer, tick, now } = makeVirtualTimer(0);
  const calls = [];

  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: (id) => calls.push(id),
    now,
    timer,
  });

  watcher.armAfter('task-5a', 2_000);
  watcher.armAfter('task-5b', 4_000);
  watcher.armAfter('task-5c', 6_000);
  assert(watcher.watchedCount === 3, 'watchedCount is 3 after arming three tasks');

  watcher.clearAll();
  assert(watcher.watchedCount === 0, 'watchedCount is 0 after clearAll()');

  tick(10_000); // advance far past all deadlines
  assert(calls.length === 0, 'no callbacks fire after clearAll() + large tick');
}

// ─── Scenario 6: isWatching / watchedCount reflect live state ─────────────────
console.log('\nScenario 6 — isWatching and watchedCount reflect live state');
{
  const { timer, tick, now } = makeVirtualTimer(0);
  const watcher = new DeadlineWatcher({
    onDeadlineExceeded: () => {},
    now,
    timer,
  });

  assert(!watcher.isWatching('task-6'), 'isWatching is false before arming');
  assert(watcher.watchedCount === 0, 'watchedCount is 0 before arming');

  watcher.armAfter('task-6', 5_000);
  assert(watcher.isWatching('task-6'), 'isWatching is true after arming');
  assert(watcher.watchedCount === 1, 'watchedCount is 1 after arming');

  tick(5_000); // deadline fires
  assert(!watcher.isWatching('task-6'), 'isWatching is false after deadline fires');
  assert(watcher.watchedCount === 0, 'watchedCount is 0 after deadline fires');
}

// ─── Scenario 7: lifecycle — running -> failed is a valid edge ────────────────
console.log('\nScenario 7 — lifecycle: running -> failed is a valid transition edge');
{
  assert(
    canTransition('running', 'failed'),
    'canTransition("running", "failed") is true (deadline-triggered force-fail is legal)',
  );
}

// ─── Scenario 8: lifecycle — failed is terminal ───────────────────────────────
console.log('\nScenario 8 — lifecycle: failed is a terminal state');
{
  assert(
    isTerminal('failed'),
    'isTerminal("failed") is true',
  );
  assert(
    !canTransition('failed', 'running'),
    'no transition out of failed -> running',
  );
  assert(
    !canTransition('failed', 'completed'),
    'no transition out of failed -> completed',
  );
  assert(
    !canTransition('failed', 'pending'),
    'no transition out of failed -> pending',
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All wall-clock deadline force-fail scenarios PASSED.');
}
