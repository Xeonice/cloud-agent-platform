/**
 * @cap/api — server-side application-layer backpressure (Track 5, tasks 5.2/5.3).
 *
 * WebSocket exposes no native flow control, and xterm.js cannot keep pace with a
 * GB/s PTY producer (D3). The orchestrator therefore tracks, per client, how many
 * raw output bytes it has streamed but the client has NOT yet acknowledged. When
 * that un-acknowledged total reaches a bounded high-water mark it pauses the PTY
 * (`pty.pause()`); when the client drains below a low-water mark it resumes it
 * (`pty.resume()`).
 *
 * Counting is driven by the monotonically increasing raw-frame `seq` (a cumulative
 * byte offset, per the contracts `RawFrameSchema`): each raw frame advances the
 * "sent" offset, and each client `ack` frame advances the "drained" offset. The
 * gap between them is the un-acknowledged byte count this controller bounds.
 */
import { HIGH_WATER_MARK_BYTES } from '@cap/contracts';

/**
 * The high-water mark for un-acknowledged raw output, in bytes. Sourced from the
 * contracts package so the server bound and the protocol constant never drift.
 * The spec requires this not exceed 500 000 bytes.
 */
export const DEFAULT_HIGH_WATER_MARK = HIGH_WATER_MARK_BYTES;

/**
 * The low-water mark for resume hysteresis: the PTY resumes only once the
 * un-acknowledged total drains below this, not the instant it dips under the
 * high-water mark, to avoid pause/resume churn. Defaults to half the high-water
 * mark (250 000 bytes).
 */
export const DEFAULT_LOW_WATER_MARK = Math.floor(DEFAULT_HIGH_WATER_MARK / 2);

/** The minimal PTY surface this controller drives. node-pty satisfies it. */
export interface PausablePty {
  pause(): void;
  resume(): void;
}

/** Tunable water marks. Invalid configurations are rejected at construction. */
export interface BackpressureOptions {
  /** High-water mark in bytes; MUST be > 0 and <= 500 000. */
  highWaterMark?: number;
  /** Low-water mark in bytes; MUST be >= 0 and < the high-water mark. */
  lowWaterMark?: number;
}

/**
 * Per-client application-layer backpressure controller.
 *
 * One instance is created per connected client streaming a task's raw output.
 * The caller:
 *   - calls {@link onSent} with the cumulative `seq` of every raw frame it emits,
 *   - calls {@link onAck} when the client sends an `ack` control frame, and
 *   - acts on the returned {@link FlowSignal} to emit `pause`/`resume` control
 *     frames and call `pty.pause()` / `pty.resume()`.
 *
 * When a {@link PausablePty} is supplied the controller drives it directly so the
 * gateway only has to forward the matching `pause`/`resume` control frame.
 */
export class BackpressureController {
  readonly highWaterMark: number;
  readonly lowWaterMark: number;

  /** Cumulative byte offset of the most recent raw frame sent to the client. */
  private sentSeq = 0;
  /** Cumulative byte offset the client has acknowledged (drained). */
  private ackedSeq = 0;
  /** Whether the PTY is currently paused due to this client's backpressure. */
  private paused = false;

  private pty?: PausablePty;

  constructor(pty?: PausablePty, options: BackpressureOptions = {}) {
    const high = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    const low = options.lowWaterMark ?? DEFAULT_LOW_WATER_MARK;

    if (!Number.isFinite(high) || high <= 0 || high > HIGH_WATER_MARK_BYTES) {
      throw new RangeError(
        `highWaterMark must be in (0, ${HIGH_WATER_MARK_BYTES}]; got ${high}`,
      );
    }
    if (!Number.isFinite(low) || low < 0 || low >= high) {
      throw new RangeError(
        `lowWaterMark must be in [0, highWaterMark); got ${low} (high=${high})`,
      );
    }

    this.pty = pty;
    this.highWaterMark = high;
    this.lowWaterMark = low;
  }

  /** Un-acknowledged bytes currently buffered against this client. */
  get unacknowledgedBytes(): number {
    return this.sentSeq - this.ackedSeq;
  }

  /** Whether the PTY is currently paused because of this client. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Record that a raw frame whose last byte sits at cumulative offset `seq` was
   * sent to the client. Returns a {@link FlowSignal}: `'pause'` when this send
   * pushed the un-acknowledged total to the high-water mark (and the PTY was not
   * already paused), otherwise `'none'`.
   *
   * `seq` is the cumulative byte offset of the last byte in the frame (matching
   * `RawFrameSchema.seq`); it must be monotonically non-decreasing.
   */
  onSent(seq: number): FlowSignal {
    if (seq < this.sentSeq) {
      throw new RangeError(
        `sent seq must be monotonically non-decreasing; got ${seq} after ${this.sentSeq}`,
      );
    }
    this.sentSeq = seq;

    if (!this.paused && this.unacknowledgedBytes >= this.highWaterMark) {
      this.paused = true;
      this.pty?.pause();
      return 'pause';
    }
    return 'none';
  }

  /**
   * Consume a client acknowledgement control frame: advance the drained-output
   * counter to the acknowledged cumulative `seq`. Returns `'resume'` when the
   * drain brought the un-acknowledged total below the low-water mark while the
   * PTY was paused (and resumes it), otherwise `'none'`.
   *
   * Stale or duplicate acks (a `seq` at or below the current acked offset) are
   * ignored so the counter never moves backwards.
   */
  onAck(seq: number): FlowSignal {
    if (seq <= this.ackedSeq) {
      // Stale/duplicate ack — nothing drains, no state change.
      return 'none';
    }
    // An ack can never claim more than has actually been sent.
    this.ackedSeq = Math.min(seq, this.sentSeq);

    if (this.paused && this.unacknowledgedBytes < this.lowWaterMark) {
      this.paused = false;
      this.pty?.resume();
      return 'resume';
    }
    return 'none';
  }

  /**
   * Reset counters and clear the paused state, resuming the PTY if this client
   * had paused it. Used when a client disconnects so a wedged pause cannot
   * outlive the client that caused it.
   */
  reset(): void {
    if (this.paused) {
      this.paused = false;
      this.pty?.resume();
    }
    this.sentSeq = 0;
    this.ackedSeq = 0;
  }

  /**
   * Attach (or replace) the PTY that this controller drives for pause/resume.
   * Called by the gateway when the PTY session is known (at PTY-attach time),
   * wiring the real producer so `pty.pause()` / `pty.resume()` actually halt it
   * rather than silently no-op'ing (VR.9).
   */
  setPty(pty: PausablePty | undefined): void {
    this.pty = pty;
  }

  /**
   * Rebase both counters to a cumulative byte offset, treating everything up to
   * `seq` as already sent AND acknowledged. Used after a snapshot + tail-replay
   * reconnect: the client now holds every byte up to `seq`, so the gateway's
   * next raw frame carries a cumulative `seq` past this point and the
   * un-acknowledged total restarts from zero. Resumes the PTY if this client had
   * paused it before the rebase.
   */
  rebase(seq: number): void {
    if (seq < 0 || !Number.isFinite(seq)) {
      throw new RangeError(`rebase seq must be a non-negative number; got ${seq}`);
    }
    if (this.paused) {
      this.paused = false;
      this.pty?.resume();
    }
    this.sentSeq = seq;
    this.ackedSeq = seq;
  }
}

/**
 * The flow-control action a {@link BackpressureController} call implies. The
 * gateway translates this into the matching contracts `pause`/`resume` control
 * frame; `'none'` means no flow-control frame is emitted.
 */
export type FlowSignal = 'pause' | 'resume' | 'none';
