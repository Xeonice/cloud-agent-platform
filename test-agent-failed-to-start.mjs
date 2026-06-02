/**
 * Minimal test: "Agent-failed-to-start surfaces distinctly without hanging"
 *
 * Exercises the StartupWindow (apps/runner) and task-lifecycle state machine
 * (apps/api) to verify that a failed-to-start agent:
 *   (a) resolves the outcome promise promptly (does NOT hang),
 *   (b) carries ok=false with the DISTINCT reason,
 *   (c) maps onto the 'agent_failed_to_start' status — never left as
 *       'pending'/'queued'/'running',
 *   (d) is a terminal state in the lifecycle: no transition out.
 *
 * No real process or network is required. The StartupWindow is driven
 * synthetically by calling noteExit() / letting the timer fire with a tiny
 * window.
 */

import {
  StartupWindow,
  AGENT_FAILED_TO_START,
  DEFAULT_STARTUP_WINDOW_MS,
} from './apps/runner/dist/startup-window.js';

import {
  canTransition,
  isTerminal,
  toAgentFailedToStart,
  assertTransition,
  IllegalTaskTransitionError,
} from './apps/api/dist/tasks/task-lifecycle.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
    failures.push(label);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Resolves the StartupWindow outcome with a hard timeout guard so the test
 *  itself never hangs if the implementation is broken. */
async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms} ms: ${label}`)), ms),
    ),
  ]);
}

// ─── 1. DISTINCT constant value ───────────────────────────────────────────────
console.log('\n[1] AGENT_FAILED_TO_START constant');

assert(
  AGENT_FAILED_TO_START === 'agent_failed_to_start',
  'AGENT_FAILED_TO_START constant equals the contracts literal "agent_failed_to_start"',
);

// ─── 2. Early-exit path (process exits before first frame) ────────────────────
console.log('\n[2] StartupWindow — early_exit (no hang)');

{
  const sw = new StartupWindow(10_000); // long window, but we trigger early
  // Simulate process exiting with code 1 before any PTY output arrives.
  sw.noteExit(1);

  let outcome;
  try {
    outcome = await withTimeout(sw.outcome, 200, 'early_exit outcome');
  } catch (err) {
    assert(false, `outcome promise did NOT resolve promptly on noteExit(): ${err.message}`);
    outcome = null;
  }

  if (outcome !== null) {
    assert(outcome !== undefined, 'outcome resolved (not undefined)');
    assert(outcome.ok === false, 'early_exit outcome.ok is false');
    assert(outcome.reason === 'early_exit', 'early_exit outcome.reason is "early_exit"');
    assert(outcome.exitCode === 1, `early_exit outcome.exitCode is 1 (got ${outcome.exitCode})`);
  }
}

// ─── 3. Startup-timeout path (no first frame within window) ───────────────────
console.log('\n[3] StartupWindow — startup_timeout (no hang)');

{
  // Use a tiny 30 ms window to keep the test fast.
  const sw = new StartupWindow(30);
  // Do NOT call noteFirstFrame() or noteExit() — let the timer fire.

  let outcome;
  try {
    // Allow up to 500 ms for the 30 ms timer to fire.
    outcome = await withTimeout(sw.outcome, 500, 'startup_timeout outcome');
  } catch (err) {
    assert(false, `outcome promise did NOT resolve after timeout elapsed: ${err.message}`);
    outcome = null;
  }

  if (outcome !== null) {
    assert(outcome !== undefined, 'outcome resolved after window elapsed');
    assert(outcome.ok === false, 'startup_timeout outcome.ok is false');
    assert(outcome.reason === 'startup_timeout', 'startup_timeout outcome.reason is "startup_timeout"');
    assert(outcome.exitCode === undefined, 'startup_timeout carries no exitCode');
  }
}

// ─── 4. Successful start — ok=true, NOT agent_failed_to_start ─────────────────
console.log('\n[4] StartupWindow — successful start (ok=true, distinct from failure)');

{
  const sw = new StartupWindow(10_000);
  sw.noteFirstFrame(); // first PTY byte arrives

  let outcome;
  try {
    outcome = await withTimeout(sw.outcome, 200, 'success outcome');
  } catch (err) {
    assert(false, `outcome promise did NOT resolve promptly on noteFirstFrame(): ${err.message}`);
    outcome = null;
  }

  if (outcome !== null) {
    assert(outcome.ok === true, 'successful outcome.ok is true');
    assert(!('reason' in outcome), 'successful outcome carries no reason field');
  }
}

// ─── 5. Exit AFTER first frame does NOT retroactively fail the window ──────────
console.log('\n[5] StartupWindow — exit after first frame is ignored');

{
  const sw = new StartupWindow(10_000);
  sw.noteFirstFrame(); // started ok
  sw.noteExit(1);      // late exit: must NOT change the settled outcome

  const outcome = await withTimeout(sw.outcome, 200, 'post-start exit ignored');
  assert(outcome.ok === true, 'outcome remains ok=true after post-start exit');
}

// ─── 6. Outcome settles exactly once (idempotent) ─────────────────────────────
console.log('\n[6] StartupWindow — settles exactly once');

{
  const sw = new StartupWindow(10_000);
  sw.noteExit(1);
  sw.noteExit(2);      // second noteExit must be ignored
  sw.noteFirstFrame(); // should also be ignored after settled

  const outcome = await withTimeout(sw.outcome, 200, 'idempotent settle');
  assert(outcome.ok === false, 'settled outcome stays false');
  assert(outcome.reason === 'early_exit', 'settled reason unchanged');
  assert(outcome.exitCode === 1, `settled exitCode unchanged (expected 1, got ${outcome.exitCode})`);
}

// ─── 7. Lifecycle state machine: agent_failed_to_start is TERMINAL ────────────
console.log('\n[7] task-lifecycle — agent_failed_to_start is a terminal state');

assert(
  isTerminal('agent_failed_to_start'),
  'isTerminal("agent_failed_to_start") is true',
);
assert(
  !isTerminal('pending'),
  'isTerminal("pending") is false',
);
assert(
  !isTerminal('running'),
  'isTerminal("running") is false',
);
assert(
  !canTransition('agent_failed_to_start', 'pending'),
  'no transition out of agent_failed_to_start -> pending',
);
assert(
  !canTransition('agent_failed_to_start', 'running'),
  'no transition out of agent_failed_to_start -> running',
);
assert(
  !canTransition('agent_failed_to_start', 'completed'),
  'no transition out of agent_failed_to_start -> completed',
);

// ─── 8. Lifecycle: valid transitions INTO agent_failed_to_start ───────────────
console.log('\n[8] task-lifecycle — valid paths into agent_failed_to_start');

for (const from of ['pending', 'queued', 'running']) {
  assert(
    canTransition(from, 'agent_failed_to_start'),
    `canTransition("${from}", "agent_failed_to_start") is true`,
  );
}

// awaiting_input has no path to agent_failed_to_start per the spec
assert(
  !canTransition('awaiting_input', 'agent_failed_to_start'),
  'canTransition("awaiting_input", "agent_failed_to_start") is false (spec: not defined)',
);

// ─── 9. toAgentFailedToStart helper ───────────────────────────────────────────
console.log('\n[9] task-lifecycle — toAgentFailedToStart helper');

assert(
  toAgentFailedToStart('pending') === 'agent_failed_to_start',
  'toAgentFailedToStart("pending") returns "agent_failed_to_start"',
);
assert(
  toAgentFailedToStart('queued') === 'agent_failed_to_start',
  'toAgentFailedToStart("queued") returns "agent_failed_to_start"',
);
assert(
  toAgentFailedToStart('running') === 'agent_failed_to_start',
  'toAgentFailedToStart("running") returns "agent_failed_to_start"',
);

// Illegal transition throws
let threw = false;
try {
  toAgentFailedToStart('awaiting_input');
} catch (err) {
  threw = err instanceof IllegalTaskTransitionError || err.name === 'IllegalTaskTransitionError';
}
assert(threw, 'toAgentFailedToStart("awaiting_input") throws IllegalTaskTransitionError');

// ─── 10. assertTransition rejects completed -> agent_failed_to_start ──────────
console.log('\n[10] task-lifecycle — completed is already terminal, cannot re-transition');

let threw2 = false;
try {
  assertTransition('completed', 'agent_failed_to_start');
} catch (err) {
  threw2 = true;
}
assert(threw2, 'assertTransition("completed", "agent_failed_to_start") throws');

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error('Failed assertions:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log('All assertions passed.');
  process.exit(0);
}
