/**
 * Minimal test: "Dual-channel WebSocket stream" requirement.
 *
 * Requirement (design.md D4 / proposal.md):
 *   One WebSocket carries two logically distinct channels:
 *     - a RAW byte-stream channel (PTY output, opaque, never parsed as control)
 *     - a STRUCTURED CONTROL-FRAME channel (every frame validates against
 *       contracts zod schemas)
 *   Frame discrimination is encoded on the top-level `channel` tag
 *   (`"raw"` vs `"control"`) so a raw frame can NEVER be misread as a control
 *   frame, and a malformed raw payload cannot be coerced into a control action.
 *
 *   Additionally, application-layer backpressure limits un-acknowledged bytes
 *   to HIGH_WATER_MARK_BYTES (≤ 500 000) per the spec.
 *
 * This test exercises:
 *   1. RawFrameSchema — valid raw frame parses; a raw frame with `type` field
 *      that matches a control type is STILL accepted as raw (channel wins).
 *   2. ControlFrameSchema — valid pause/resume/ack frames parse; unknown types
 *      are rejected; raw-channel frames are rejected.
 *   3. Channel isolation — a message with `channel:"raw"` is never parsed as a
 *      control frame even if it carries a control-looking payload.
 *   4. BackpressureController — un-acknowledged bytes hit the high-water mark
 *      (500 000) exactly when the spec requires, then resume after the client
 *      drains below the low-water mark.
 */

import {
  RawFrameSchema,
  ControlFrameSchema,
  WsFrameSchema,
  FRAME_CHANNEL,
  HIGH_WATER_MARK_BYTES,
  AckFrameSchema,
  PauseFrameSchema,
  ResumeFrameSchema,
} from './packages/contracts/dist/index.js';

// ---------------------------------------------------------------------------
// Inline BackpressureController (mirrors apps/api/src/terminal/backpressure.ts)
// Used because the API dist cannot resolve workspace: modules in this context.
// ---------------------------------------------------------------------------
const DEFAULT_HIGH_WATER = HIGH_WATER_MARK_BYTES;        // 500 000
const DEFAULT_LOW_WATER  = Math.floor(DEFAULT_HIGH_WATER / 2); // 250 000

class BackpressureController {
  constructor(opts = {}) {
    this.highWaterMark = opts.highWaterMark ?? DEFAULT_HIGH_WATER;
    this.lowWaterMark  = opts.lowWaterMark  ?? DEFAULT_LOW_WATER;
    this._sent   = 0;
    this._acked  = 0;
    this._paused = false;
  }
  get unacknowledgedBytes() { return this._sent - this._acked; }
  get isPaused()            { return this._paused; }

  onSent(seq) {
    if (seq < this._sent) throw new RangeError(`seq must be non-decreasing`);
    this._sent = seq;
    if (!this._paused && this.unacknowledgedBytes >= this.highWaterMark) {
      this._paused = true;
      return 'pause';
    }
    return 'none';
  }

  onAck(seq) {
    if (seq <= this._acked) return 'none';
    this._acked = Math.min(seq, this._sent);
    if (this._paused && this.unacknowledgedBytes < this.lowWaterMark) {
      this._paused = false;
      return 'resume';
    }
    return 'none';
  }

  reset() { this._sent = 0; this._acked = 0; this._paused = false; }

  rebase(seq) {
    if (this._paused) this._paused = false;
    this._sent = seq;
    this._acked = seq;
  }
}

// ---------------------------------------------------------------------------
// Test harness
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

// ---------------------------------------------------------------------------
// 1. RawFrameSchema
// ---------------------------------------------------------------------------
console.log('\n=== 1. RawFrameSchema ===');

{
  const frame = { channel: 'raw', data: Buffer.from('hello PTY').toString('base64'), seq: 9 };
  const r = RawFrameSchema.safeParse(frame);
  assert(r.success, 'valid raw frame parses');
  assert(r.data?.channel === FRAME_CHANNEL.RAW, 'channel tag is "raw"');
}

{
  // A "raw" frame that also carries a control-frame-looking `type` field.
  // The raw schema does NOT include `type`, so it is simply extra; but the frame
  // is still a valid raw frame — the channel tag dominates.
  const frameWithType = { channel: 'raw', data: 'aGk=', seq: 2, type: 'pause' };
  const r = RawFrameSchema.safeParse(frameWithType);
  // zod strips extra keys by default (passthrough is not set), so it still validates.
  assert(r.success, 'raw frame with spurious "type" field still parses as raw');
  // Crucially, it is NOT parsed as a control frame.
  const ctrl = ControlFrameSchema.safeParse(frameWithType);
  assert(!ctrl.success, 'raw frame with channel:"raw" is rejected by ControlFrameSchema');
}

{
  // Missing seq — invalid raw frame.
  const bad = { channel: 'raw', data: 'aGk=' };
  const r = RawFrameSchema.safeParse(bad);
  assert(!r.success, 'raw frame without seq is rejected');
}

// ---------------------------------------------------------------------------
// 2. ControlFrameSchema — flow control frames
// ---------------------------------------------------------------------------
console.log('\n=== 2. ControlFrameSchema — flow control ===');

{
  const pause = { channel: 'control', type: 'pause' };
  const r = ControlFrameSchema.safeParse(pause);
  assert(r.success, 'pause control frame parses');
  assert(r.data?.type === 'pause', 'pause frame type is "pause"');
}

{
  const resume = { channel: 'control', type: 'resume' };
  const r = ControlFrameSchema.safeParse(resume);
  assert(r.success, 'resume control frame parses');
}

{
  const ack = { channel: 'control', type: 'ack', seq: 1024 };
  const r = ControlFrameSchema.safeParse(ack);
  assert(r.success, 'ack control frame with valid seq parses');
}

{
  // ACK with negative seq — invalid per schema (nonnegative).
  const badAck = { channel: 'control', type: 'ack', seq: -1 };
  const r = ControlFrameSchema.safeParse(badAck);
  assert(!r.success, 'ack frame with negative seq is rejected');
}

{
  // Unknown control type.
  const unknown = { channel: 'control', type: 'fly_me_to_the_moon' };
  const r = ControlFrameSchema.safeParse(unknown);
  assert(!r.success, 'unknown control type is rejected');
}

// ---------------------------------------------------------------------------
// 3. Channel isolation — raw frame NEVER parsed as control frame
// ---------------------------------------------------------------------------
console.log('\n=== 3. Channel isolation ===');

{
  // A frame whose channel is "raw" but whose body looks exactly like a valid
  // pause control frame.  ControlFrameSchema MUST reject it.
  const disguised = { channel: 'raw', data: 'abc=', seq: 0, type: 'pause' };
  const asControl = ControlFrameSchema.safeParse(disguised);
  assert(!asControl.success, 'frame with channel:"raw" is never parsed as a control frame');
}

{
  // Similarly, a control-channel frame with channel:"control" and type:"ack"
  // MUST NOT be accepted by RawFrameSchema.
  const ctrlFrame = { channel: 'control', type: 'ack', seq: 5 };
  const asRaw = RawFrameSchema.safeParse(ctrlFrame);
  assert(!asRaw.success, 'frame with channel:"control" is never parsed as a raw frame');
}

{
  // Discrimination test via WsFrameSchema (the full union):
  // A raw frame yields channel=="raw".
  const rawMsg = JSON.stringify({ channel: 'raw', data: 'dGVzdA==', seq: 4 });
  const obj = JSON.parse(rawMsg);
  const r = WsFrameSchema.safeParse(obj);
  assert(r.success && r.data.channel === 'raw', 'WsFrameSchema routes raw msg to raw channel');

  // A control frame yields channel=="control".
  const ctrlMsg = JSON.stringify({ channel: 'control', type: 'pause' });
  const obj2 = JSON.parse(ctrlMsg);
  const r2 = WsFrameSchema.safeParse(obj2);
  assert(r2.success && r2.data.channel === 'control', 'WsFrameSchema routes control msg to control channel');
}

// ---------------------------------------------------------------------------
// 4. BackpressureController — high-water mark and resume hysteresis
// ---------------------------------------------------------------------------
console.log('\n=== 4. BackpressureController backpressure ===');

{
  // Spec: HIGH_WATER_MARK_BYTES ≤ 500 000.
  assert(HIGH_WATER_MARK_BYTES === 500_000, 'HIGH_WATER_MARK_BYTES is exactly 500 000');

  const bp = new BackpressureController();
  assert(bp.highWaterMark === 500_000, 'default highWaterMark is 500 000');
  assert(bp.lowWaterMark  === 250_000, 'default lowWaterMark is 250 000 (half of HWM)');
}

{
  // Sending bytes up to but NOT reaching the HWM does NOT pause.
  const bp = new BackpressureController();
  const sig1 = bp.onSent(499_999);
  assert(sig1 === 'none', 'no pause signal before high-water mark');
  assert(!bp.isPaused, 'PTY not paused before HWM');
}

{
  // Reaching exactly the HWM triggers a pause.
  const bp = new BackpressureController();
  const sig = bp.onSent(500_000);
  assert(sig === 'pause', 'pause signal emitted when HWM is reached');
  assert(bp.isPaused, 'PTY is paused at HWM');
  assert(bp.unacknowledgedBytes === 500_000, 'unacknowledged bytes equals HWM');
}

{
  // ACKing only slightly — remaining unacked still >= LWM — does NOT resume.
  // Send 500k (pause). Ack 249k => unacked = 251k >= LWM (250k) => no resume.
  const bp = new BackpressureController();
  bp.onSent(500_000);           // triggers pause
  const sig = bp.onAck(249_000); // drains 249k; unacked = 251k >= LWM (250k)
  assert(sig === 'none', 'no resume when still above low-water mark');
  assert(bp.isPaused, 'PTY remains paused above LWM');
}

{
  // ACKing enough to cross below LWM DOES resume.
  const bp = new BackpressureController();
  bp.onSent(500_000);             // pause
  const sig = bp.onAck(251_000);  // unacked = 249k, which is < LWM (250k)
  assert(sig === 'resume', 'resume signal emitted when drain crosses low-water mark');
  assert(!bp.isPaused, 'PTY resumes after crossing LWM');
}

{
  // A stale ACK (seq <= already acked) is ignored; no state change.
  const bp = new BackpressureController();
  bp.onSent(500_000);
  bp.onAck(251_000);   // resumes
  const sig = bp.onAck(100_000);  // stale
  assert(sig === 'none', 'stale ACK is ignored');
}

{
  // rebase() resets both counters so subsequent sends produce fresh backpressure.
  const bp = new BackpressureController();
  bp.onSent(500_000);  // pause
  bp.rebase(500_000);  // reconnect: client already has those bytes
  assert(!bp.isPaused, 'rebase clears paused state');
  assert(bp.unacknowledgedBytes === 0, 'rebase resets unacknowledged bytes to zero');
  // Now another HWM worth of bytes triggers pause again.
  const sig = bp.onSent(1_000_000);  // sent 500k MORE since rebase
  assert(sig === 'pause', 'pause fires again after rebase when HWM is reached');
}

{
  // reset() clears all state.
  const bp = new BackpressureController();
  bp.onSent(500_000);
  bp.reset();
  assert(!bp.isPaused, 'reset clears paused state');
  assert(bp.unacknowledgedBytes === 0, 'reset clears unacknowledged bytes');
}

// ---------------------------------------------------------------------------
// 5. Gateway message discrimination (logic mirrored from terminal.gateway.ts)
// ---------------------------------------------------------------------------
console.log('\n=== 5. Gateway dual-channel discrimination logic ===');

/**
 * Mirrors the gateway's parseFrame + dispatch logic:
 * - Returns 'raw' for a valid raw frame message
 * - Returns 'control' for a valid control frame message
 * - Returns 'drop' for anything that fails validation
 */
function gatewayDiscriminate(message) {
  let obj;
  try { obj = JSON.parse(message); } catch { return 'drop'; }
  if (typeof obj !== 'object' || obj === null) return 'drop';
  const ch = obj.channel;
  if (ch !== FRAME_CHANNEL.RAW && ch !== FRAME_CHANNEL.CONTROL) return 'drop';

  if (ch === FRAME_CHANNEL.RAW) {
    // Raw channel: the payload is opaque; never parsed as control.
    return RawFrameSchema.safeParse(obj).success ? 'raw' : 'drop';
  }
  // Control channel: validated against the full ControlFrameSchema.
  return ControlFrameSchema.safeParse(obj).success ? 'control' : 'drop';
}

{
  const rawMsg = JSON.stringify({ channel: 'raw', data: Buffer.from('PTY bytes').toString('base64'), seq: 9 });
  assert(gatewayDiscriminate(rawMsg) === 'raw', 'gateway routes valid raw PTY message to raw channel');
}

{
  const ctrlMsg = JSON.stringify({ channel: 'control', type: 'ack', seq: 42 });
  assert(gatewayDiscriminate(ctrlMsg) === 'control', 'gateway routes valid ack control frame to control channel');
}

{
  // A raw-channel message whose body looks like a control frame MUST route as raw
  // (if valid raw schema) or be dropped; it MUST NOT become a control action.
  const sneaky = JSON.stringify({ channel: 'raw', data: 'dGVzdA==', seq: 0, type: 'pause' });
  const result = gatewayDiscriminate(sneaky);
  assert(result === 'raw', 'sneaky raw frame with "type":"pause" routes as raw, never as control');
}

{
  // Non-JSON payload is always dropped.
  assert(gatewayDiscriminate('not json') === 'drop', 'non-JSON payload is dropped');
}

{
  // Missing `channel` tag is dropped.
  const noChannel = JSON.stringify({ type: 'pause' });
  assert(gatewayDiscriminate(noChannel) === 'drop', 'frame missing channel tag is dropped');
}

{
  // Unknown channel value is dropped.
  const unknownCh = JSON.stringify({ channel: 'admin', type: 'pause' });
  assert(gatewayDiscriminate(unknownCh) === 'drop', 'unknown channel value is dropped');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nSome tests FAILED.`);
  process.exit(1);
} else {
  console.log(`\nAll tests PASSED.`);
}
