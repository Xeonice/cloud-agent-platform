/**
 * Minimal test for requirement:
 *   "Circuit breaker on repeated start/turn failure"
 *
 * Requirement semantics (from circuit-breaker.ts JSDoc):
 *   1. Consecutive failures up to threshold - 1 do NOT trip the breaker.
 *   2. On reaching the threshold the breaker trips: onTrip is called exactly
 *      once and isTripped() returns true.
 *   3. A success before the threshold resets the consecutive counter to 0.
 *   4. Once tripped, further failures are ignored (no re-trip, onTrip not
 *      re-fired).
 *   5. A success on an already-tripped task is a no-op (stays tripped).
 *   6. Invalid threshold (0 or non-integer) throws on construction.
 *   7. turn_failure kind also counts toward the threshold.
 */

// ---- inline the class so we don't need a transpile step ----

class CircuitBreaker {
  constructor(options) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new Error(
        `Circuit breaker threshold must be a positive integer, received: ${String(options.threshold)}`,
      );
    }
    this.threshold = options.threshold;
    this.onTrip = options.onTrip;
    this.states = new Map();
  }

  consecutiveFailures(taskId) {
    return this.states.get(taskId)?.consecutiveFailures ?? 0;
  }

  isTripped(taskId) {
    return this.states.get(taskId)?.tripped ?? false;
  }

  recordFailure(taskId, _kind = 'agent_failed_to_start') {
    const state = this.states.get(taskId) ?? { consecutiveFailures: 0, tripped: false };
    if (state.tripped) {
      this.states.set(taskId, state);
      return false;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.threshold) {
      state.tripped = true;
      this.states.set(taskId, state);
      this.onTrip(taskId, state.consecutiveFailures);
      return true;
    }
    this.states.set(taskId, state);
    return false;
  }

  recordSuccess(taskId) {
    const state = this.states.get(taskId);
    if (!state || state.tripped) return;
    state.consecutiveFailures = 0;
    this.states.set(taskId, state);
  }

  forget(taskId) { this.states.delete(taskId); }
  forgetAll() { this.states.clear(); }
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

console.log('\n=== Circuit-breaker: repeated start/turn failure ===\n');

// T1: failures below threshold do not trip
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 3, onTrip: (id, n) => trips.push({ id, n }) });

  const r1 = cb.recordFailure('task-1');
  const r2 = cb.recordFailure('task-1');

  assert(r1 === false, 'T1a: 1st failure returns false (not tripped)');
  assert(r2 === false, 'T1b: 2nd failure returns false (not tripped)');
  assert(cb.isTripped('task-1') === false, 'T1c: isTripped is false below threshold');
  assert(cb.consecutiveFailures('task-1') === 2, 'T1d: consecutive count is 2');
  assert(trips.length === 0, 'T1e: onTrip not called below threshold');
}

// T2: reaching threshold trips the breaker exactly once
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 3, onTrip: (id, n) => trips.push({ id, n }) });

  cb.recordFailure('task-2');
  cb.recordFailure('task-2');
  const r3 = cb.recordFailure('task-2'); // threshold hit

  assert(r3 === true, 'T2a: 3rd failure (threshold) returns true');
  assert(cb.isTripped('task-2') === true, 'T2b: isTripped is true after threshold');
  assert(trips.length === 1, 'T2c: onTrip called exactly once');
  assert(trips[0].id === 'task-2', 'T2d: onTrip receives correct taskId');
  assert(trips[0].n === 3, 'T2e: onTrip receives correct failure count');
}

// T3: once tripped, further failures are ignored
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 2, onTrip: (id, n) => trips.push({ id, n }) });

  cb.recordFailure('task-3');
  cb.recordFailure('task-3'); // trips
  const r4 = cb.recordFailure('task-3'); // should be ignored
  const r5 = cb.recordFailure('task-3'); // should be ignored

  assert(r4 === false, 'T3a: failure after trip returns false');
  assert(r5 === false, 'T3b: second failure after trip returns false');
  assert(trips.length === 1, 'T3c: onTrip still only called once (latch)');
}

// T4: a success before threshold resets the counter
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 3, onTrip: (id, n) => trips.push({ id, n }) });

  cb.recordFailure('task-4');
  cb.recordFailure('task-4'); // count = 2
  cb.recordSuccess('task-4'); // count reset to 0
  assert(cb.consecutiveFailures('task-4') === 0, 'T4a: success resets counter');

  // Now needs full threshold again to trip
  cb.recordFailure('task-4');
  cb.recordFailure('task-4');
  assert(cb.isTripped('task-4') === false, 'T4b: still not tripped after partial re-accumulation');
  cb.recordFailure('task-4'); // now at threshold
  assert(cb.isTripped('task-4') === true, 'T4c: trips after re-accumulating full threshold');
  assert(trips.length === 1, 'T4d: onTrip called exactly once');
}

// T5: success on already-tripped task is a no-op
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 1, onTrip: (id, n) => trips.push({ id, n }) });

  cb.recordFailure('task-5'); // trips immediately (threshold=1)
  assert(cb.isTripped('task-5') === true, 'T5a: tripped at threshold 1');
  cb.recordSuccess('task-5'); // should be no-op
  assert(cb.isTripped('task-5') === true, 'T5b: success does not un-trip the breaker');
}

// T6: turn_failure kind also counts toward threshold
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 2, onTrip: (id, n) => trips.push({ id, n }) });

  cb.recordFailure('task-6', 'turn_failure');
  const r = cb.recordFailure('task-6', 'turn_failure');

  assert(r === true, 'T6a: turn_failure kind trips the breaker at threshold');
  assert(cb.isTripped('task-6') === true, 'T6b: isTripped true after turn_failure trip');
}

// T7: invalid threshold throws on construction
{
  assertThrows(() => new CircuitBreaker({ threshold: 0, onTrip: () => {} }), 'T7a: threshold=0 throws');
  assertThrows(() => new CircuitBreaker({ threshold: -1, onTrip: () => {} }), 'T7b: threshold=-1 throws');
  assertThrows(() => new CircuitBreaker({ threshold: 1.5, onTrip: () => {} }), 'T7c: threshold=1.5 throws');
}

// T8: multiple tasks are tracked independently
{
  const trips = [];
  const cb = new CircuitBreaker({ threshold: 2, onTrip: (id, n) => trips.push(id) });

  cb.recordFailure('alpha');
  cb.recordFailure('beta');
  cb.recordFailure('beta'); // beta trips

  assert(cb.isTripped('alpha') === false, 'T8a: alpha not tripped');
  assert(cb.isTripped('beta') === true, 'T8b: beta tripped independently');
  assert(trips.length === 1 && trips[0] === 'beta', 'T8c: only beta tripped');
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
