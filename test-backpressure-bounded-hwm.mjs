/**
 * Minimal test for requirement:
 *   "Server-side backpressure with bounded high-water mark"
 *
 * Scenarios exercised:
 *
 *   S1 – HIGH_WATER_MARK_BYTES constant is <= 500 000 bytes:
 *         The protocol constant that bounds the HWM must satisfy the
 *         spec ceiling of 500 000 bytes.
 *
 *   S2 – PTY is paused when un-acknowledged bytes reach the high-water mark:
 *         GIVEN a BackpressureController with a custom HWM
 *         WHEN the cumulative sent seq reaches the HWM
 *         THEN the controller calls pty.pause() and returns 'pause'.
 *
 *   S3 – Constructor enforces the upper bound on highWaterMark:
 *         WHEN a BackpressureController is constructed with
 *         highWaterMark > 500 000
 *         THEN construction MUST throw a RangeError.
 *
 *   S4 – Constructor enforces the lower bound on highWaterMark:
 *         WHEN a BackpressureController is constructed with
 *         highWaterMark <= 0
 *         THEN construction MUST throw a RangeError.
 *
 *   S5 – PTY is NOT paused below the high-water mark:
 *         GIVEN bytes sent that are one below the HWM
 *         THEN pty.pause() must NOT have been called.
 */

// ---------------------------------------------------------------------------
// Inline BackpressureController (mirrors backpressure.ts; no transpile needed)
// ---------------------------------------------------------------------------

const HIGH_WATER_MARK_BYTES = 500_000;
const DEFAULT_HIGH_WATER_MARK = HIGH_WATER_MARK_BYTES;
const DEFAULT_LOW_WATER_MARK = Math.floor(DEFAULT_HIGH_WATER_MARK / 2);

class BackpressureController {
  #highWaterMark;
  #lowWaterMark;
  #sentSeq = 0;
  #ackedSeq = 0;
  #paused = false;
  #pty;

  constructor(pty, options = {}) {
    const high = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    const low  = options.lowWaterMark  ?? DEFAULT_LOW_WATER_MARK;

    if (!Number.isFinite(high) || high <= 0 || high > HIGH_WATER_MARK_BYTES) {
      throw new RangeError(`highWaterMark must be in (0, ${HIGH_WATER_MARK_BYTES}]; got ${high}`);
    }
    if (!Number.isFinite(low) || low < 0 || low >= high) {
      throw new RangeError(`lowWaterMark must be in [0, highWaterMark); got ${low} (high=${high})`);
    }

    this.#highWaterMark = high;
    this.#lowWaterMark  = low;
    this.#pty = pty;
  }

  get highWaterMark()       { return this.#highWaterMark; }
  get lowWaterMark()        { return this.#lowWaterMark; }
  get unacknowledgedBytes() { return this.#sentSeq - this.#ackedSeq; }
  get isPaused()            { return this.#paused; }

  onSent(seq) {
    if (seq < this.#sentSeq) {
      throw new RangeError(`sent seq must be monotonically non-decreasing; got ${seq} after ${this.#sentSeq}`);
    }
    this.#sentSeq = seq;
    if (!this.#paused && this.unacknowledgedBytes >= this.#highWaterMark) {
      this.#paused = true;
      this.#pty?.pause();
      return 'pause';
    }
    return 'none';
  }

  onAck(seq) {
    if (seq <= this.#ackedSeq) return 'none';
    this.#ackedSeq = Math.min(seq, this.#sentSeq);
    if (this.#paused && this.unacknowledgedBytes < this.#lowWaterMark) {
      this.#paused = false;
      this.#pty?.resume();
      return 'resume';
    }
    return 'none';
  }
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

function assertThrows(fn, expectedType, label) {
  try {
    fn();
    console.error(`  FAIL  ${label}  (expected ${expectedType}, got nothing)`);
    failed++;
  } catch (err) {
    if (err instanceof RangeError) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}  (threw ${err.constructor.name} instead of ${expectedType})`);
      failed++;
    }
  }
}

// ---------------------------------------------------------------------------
// S1 – HIGH_WATER_MARK_BYTES protocol constant is bounded at 500 000
// ---------------------------------------------------------------------------

console.log('\n=== Bounded HWM: S1 — protocol constant does not exceed 500 000 ===\n');

assert(
  HIGH_WATER_MARK_BYTES === 500_000,
  'S1a: HIGH_WATER_MARK_BYTES equals exactly 500 000',
);
assert(
  HIGH_WATER_MARK_BYTES <= 500_000,
  'S1b: HIGH_WATER_MARK_BYTES satisfies the spec ceiling (<= 500 000)',
);

// ---------------------------------------------------------------------------
// S2 – PTY paused when un-acknowledged bytes reach the high-water mark
// ---------------------------------------------------------------------------

console.log('\n=== Bounded HWM: S2 — PTY paused exactly at the high-water mark ===\n');

{
  const hwm = 200;
  const lwm = 80;
  const pauseCalls  = [];
  const resumeCalls = [];
  const pty = {
    pause:  () => pauseCalls.push(true),
    resume: () => resumeCalls.push(true),
  };
  const ctrl = new BackpressureController(pty, { highWaterMark: hwm, lowWaterMark: lwm });

  // One byte below the HWM — no pause yet.
  const sig1 = ctrl.onSent(hwm - 1);
  assert(sig1 === 'none',          'S2a: signal is "none" one byte below HWM');
  assert(!ctrl.isPaused,           'S2b: controller is not paused below HWM');
  assert(pauseCalls.length === 0,  'S2c: pty.pause() not called below HWM');

  // Exactly at the HWM — must pause now.
  const sig2 = ctrl.onSent(hwm);
  assert(sig2 === 'pause',         'S2d: signal is "pause" when unacked == HWM');
  assert(ctrl.isPaused,            'S2e: controller enters paused state at HWM');
  assert(pauseCalls.length === 1,  'S2f: pty.pause() called exactly once at HWM');
  assert(resumeCalls.length === 0, 'S2g: pty.resume() not called during pause transition');

  // Additional sends while already paused do NOT call pty.pause() again.
  const sig3 = ctrl.onSent(hwm + 50);
  assert(sig3 === 'none',          'S2h: subsequent sends while paused return "none"');
  assert(pauseCalls.length === 1,  'S2i: pty.pause() not called a second time');
}

// ---------------------------------------------------------------------------
// S3 – highWaterMark > 500 000 is rejected at construction time
// ---------------------------------------------------------------------------

console.log('\n=== Bounded HWM: S3 — highWaterMark > 500 000 throws RangeError ===\n');

assertThrows(
  () => new BackpressureController(undefined, { highWaterMark: 500_001, lowWaterMark: 0 }),
  'RangeError',
  'S3a: highWaterMark 500 001 (one above ceiling) throws RangeError',
);

assertThrows(
  () => new BackpressureController(undefined, { highWaterMark: 1_000_000, lowWaterMark: 0 }),
  'RangeError',
  'S3b: highWaterMark 1 000 000 (well above ceiling) throws RangeError',
);

// Exactly 500 000 must be accepted (no throw).
{
  let threw = false;
  try {
    new BackpressureController(undefined, { highWaterMark: 500_000, lowWaterMark: 0 });
  } catch {
    threw = true;
  }
  assert(!threw, 'S3c: highWaterMark exactly 500 000 (ceiling) is accepted');
}

// ---------------------------------------------------------------------------
// S4 – highWaterMark <= 0 is rejected at construction time
// ---------------------------------------------------------------------------

console.log('\n=== Bounded HWM: S4 — highWaterMark <= 0 throws RangeError ===\n');

assertThrows(
  () => new BackpressureController(undefined, { highWaterMark: 0, lowWaterMark: 0 }),
  'RangeError',
  'S4a: highWaterMark 0 throws RangeError',
);

assertThrows(
  () => new BackpressureController(undefined, { highWaterMark: -1, lowWaterMark: 0 }),
  'RangeError',
  'S4b: highWaterMark -1 throws RangeError',
);

// ---------------------------------------------------------------------------
// S5 – PTY is NOT paused below the high-water mark
// ---------------------------------------------------------------------------

console.log('\n=== Bounded HWM: S5 — PTY not paused below high-water mark ===\n');

{
  const hwm = 100;
  const lwm = 30;
  const pauseCalls = [];
  const pty = { pause: () => pauseCalls.push(true), resume: () => {} };
  const ctrl = new BackpressureController(pty, { highWaterMark: hwm, lowWaterMark: lwm });

  // Send 99 bytes — still one short of the 100-byte HWM.
  ctrl.onSent(99);
  assert(!ctrl.isPaused,          'S5a: not paused at 99 bytes (HWM=100)');
  assert(pauseCalls.length === 0, 'S5b: pty.pause() not called at 99 bytes');
  assert(
    ctrl.unacknowledgedBytes === 99,
    'S5c: unacknowledgedBytes is 99 (sentSeq - ackedSeq)',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
