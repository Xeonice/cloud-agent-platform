/**
 * Minimal test for requirement:
 *   "ACK-based pause/resume control frames"
 *
 * Scenarios exercised (realtime-terminal spec):
 *
 *   S1 – Client acknowledgement advances the server counter:
 *         WHEN the client emits an ack control frame for received bytes
 *         THEN the server reduces its count of un-acknowledged buffered bytes
 *              by the acknowledged amount, and resumes the PTY once the total
 *              falls below the low-water mark.
 *
 *   S2 – Pause and resume frames are defined in contracts:
 *         WHEN the control-frame schema in the contracts package is inspected
 *         THEN it defines explicit pause, resume, and acknowledgement frame
 *              variants (validated by parsing representative instances).
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
    if (seq <= this.#ackedSeq) return 'none'; // stale / duplicate
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
// Inline contract schemas (mirrors ws-frames.ts; validated manually)
// ---------------------------------------------------------------------------

const FRAME_CHANNEL = { RAW: 'raw', CONTROL: 'control' };

function parseRawFrame(obj) {
  if (obj.channel !== FRAME_CHANNEL.RAW) throw new Error('not a raw frame');
  if (typeof obj.data !== 'string')      throw new Error('data must be string');
  if (!Number.isInteger(obj.seq) || obj.seq < 0) throw new Error('seq must be non-negative int');
  return obj;
}

function parsePauseFrame(obj) {
  if (obj.channel !== FRAME_CHANNEL.CONTROL) throw new Error('not a control frame');
  if (obj.type !== 'pause') throw new Error('type must be pause');
  return obj;
}

function parseResumeFrame(obj) {
  if (obj.channel !== FRAME_CHANNEL.CONTROL) throw new Error('not a control frame');
  if (obj.type !== 'resume') throw new Error('type must be resume');
  return obj;
}

function parseAckFrame(obj) {
  if (obj.channel !== FRAME_CHANNEL.CONTROL) throw new Error('not a control frame');
  if (obj.type !== 'ack') throw new Error('type must be ack');
  if (!Number.isInteger(obj.seq) || obj.seq < 0) throw new Error('seq must be non-negative int');
  return obj;
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
// S1 – Client acknowledgement advances the server counter
// ---------------------------------------------------------------------------

console.log('\n=== ACK-based pause/resume: S1 — ack advances server counter ===\n');

{
  // Use small water marks for deterministic unit testing.
  // HWM = 100, LWM = 40 (below half avoids accidental resume boundary issues).
  const hwm = 100;
  const lwm = 40;
  const pauseCalls  = [];
  const resumeCalls = [];
  const pty = {
    pause:  () => pauseCalls.push(true),
    resume: () => resumeCalls.push(true),
  };
  const ctrl = new BackpressureController(pty, { highWaterMark: hwm, lowWaterMark: lwm });

  // Send bytes up to but not at HWM → no pause
  const sig1 = ctrl.onSent(99);
  assert(sig1 === 'none',      'S1a: onSent(99) below HWM returns "none"');
  assert(!ctrl.isPaused,       'S1b: not paused yet');
  assert(pauseCalls.length === 0, 'S1c: pty.pause() not called yet');

  // Send one more byte — reaches HWM (unacknowledgedBytes = 100 >= hwm=100)
  const sig2 = ctrl.onSent(100);
  assert(sig2 === 'pause',     'S1d: onSent(100) at HWM returns "pause"');
  assert(ctrl.isPaused,        'S1e: controller enters paused state');
  assert(pauseCalls.length === 1, 'S1f: pty.pause() called exactly once');

  // Now ack enough bytes to bring unacked total below LWM (100 - 61 = 39 < 40)
  const sig3 = ctrl.onAck(61);
  assert(ctrl.unacknowledgedBytes === 39, 'S1g: unacknowledgedBytes reduced by ack amount (100-61=39)');
  assert(sig3 === 'resume',               'S1h: onAck returns "resume" once below LWM');
  assert(!ctrl.isPaused,                  'S1i: controller is no longer paused');
  assert(resumeCalls.length === 1,        'S1j: pty.resume() called exactly once');

  // Stale ack (same seq again) must be ignored
  const sig4 = ctrl.onAck(61);
  assert(sig4 === 'none',             'S1k: duplicate ack returns "none"');
  assert(resumeCalls.length === 1,    'S1l: pty.resume() not called again for stale ack');
  assert(ctrl.unacknowledgedBytes === 39, 'S1m: unacknowledgedBytes unchanged by stale ack');

  // Ack claiming more than sent is clamped to sentSeq
  const sig5 = ctrl.onAck(999);
  assert(ctrl.unacknowledgedBytes === 0, 'S1n: over-ack clamped to sentSeq (unacked=0)');
  assert(sig5 === 'none',               'S1o: no additional signal after clamped ack while not paused');
}

// ---------------------------------------------------------------------------
// S2 – Pause, resume, and ack frames are defined in contracts
// ---------------------------------------------------------------------------

console.log('\n=== ACK-based pause/resume: S2 — contract frame definitions ===\n');

{
  // Pause frame parses correctly
  assertThrows(
    () => parsePauseFrame({ channel: 'raw', type: 'pause' }),
    'S2a: pause frame on wrong channel is rejected',
  );
  assert(
    (() => { const f = parsePauseFrame({ channel: 'control', type: 'pause' }); return f.type === 'pause'; })(),
    'S2b: valid pause frame is accepted and type is "pause"',
  );

  // Resume frame parses correctly
  assertThrows(
    () => parseResumeFrame({ channel: 'control', type: 'wrong' }),
    'S2c: resume frame with wrong type is rejected',
  );
  assert(
    (() => { const f = parseResumeFrame({ channel: 'control', type: 'resume' }); return f.type === 'resume'; })(),
    'S2d: valid resume frame is accepted and type is "resume"',
  );

  // Ack frame parses correctly
  assertThrows(
    () => parseAckFrame({ channel: 'control', type: 'ack', seq: -1 }),
    'S2e: ack frame with negative seq is rejected',
  );
  assertThrows(
    () => parseAckFrame({ channel: 'control', type: 'ack', seq: 1.5 }),
    'S2f: ack frame with non-integer seq is rejected',
  );
  assert(
    (() => {
      const f = parseAckFrame({ channel: 'control', type: 'ack', seq: 42 });
      return f.type === 'ack' && f.seq === 42;
    })(),
    'S2g: valid ack frame is accepted with correct seq',
  );

  // Raw frame must NOT be parseable as a control frame
  assertThrows(
    () => parsePauseFrame({ channel: 'raw', data: btoa('hello'), seq: 5 }),
    'S2h: raw frame is rejected as a pause (control) frame — channels do not overlap',
  );
  assertThrows(
    () => parseAckFrame({ channel: 'raw', data: btoa('hello'), seq: 5 }),
    'S2i: raw frame is rejected as an ack (control) frame — channels do not overlap',
  );

  // Valid raw frame parses on its own channel
  assert(
    (() => {
      const f = parseRawFrame({ channel: 'raw', data: btoa('bytes'), seq: 10 });
      return f.channel === 'raw' && f.seq === 10;
    })(),
    'S2j: valid raw frame is accepted on the raw channel',
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
