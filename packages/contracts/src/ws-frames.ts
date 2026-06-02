import { z } from 'zod';

/**
 * Dual-channel WebSocket frame protocol (realtime-terminal spec, D4).
 *
 * A single WebSocket carries two logically distinct channels:
 *   - a RAW byte-stream channel reproducing the PTY output, and
 *   - a structured CONTROL-frame channel.
 *
 * Discrimination is encoded on the top-level `channel` tag so a raw frame can
 * NEVER be parsed as a control frame and vice-versa: a raw frame's opaque
 * payload is base64-encoded text under `channel: "raw"`, whereas every control
 * frame is a JSON object under `channel: "control"` further discriminated by
 * its `type`. The two tag spaces do not overlap.
 */

export const FRAME_CHANNEL = {
  RAW: 'raw',
  CONTROL: 'control',
} as const;

// ---------------------------------------------------------------------------
// Raw byte frame
// ---------------------------------------------------------------------------

/**
 * A raw PTY-output frame. `data` is the base64 encoding of the opaque byte
 * payload — it is never inspected or parsed as a control frame.
 *
 * `seq` is a monotonically increasing byte offset / sequence used by the ACK
 * protocol to acknowledge drained output.
 */
export const RawFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.RAW),
  /** Base64-encoded opaque PTY bytes. */
  data: z.string(),
  /** Cumulative byte sequence offset of the last byte in `data`. */
  seq: z.number().int().nonnegative(),
});
export type RawFrame = z.infer<typeof RawFrameSchema>;

// ---------------------------------------------------------------------------
// Control frames — flow control (pause / resume / ack)
// ---------------------------------------------------------------------------

/**
 * Server -> client: the orchestrator paused the PTY because un-acknowledged
 * output reached the high-water mark.
 */
export const PauseFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('pause'),
});
export type PauseFrame = z.infer<typeof PauseFrameSchema>;

/**
 * Server -> client: the orchestrator resumed the PTY after the client drained
 * below the low-water mark.
 */
export const ResumeFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('resume'),
});
export type ResumeFrame = z.infer<typeof ResumeFrameSchema>;

/**
 * Client -> server: acknowledgement that bytes up to and including `seq` have
 * been drained/rendered. The server uses this to advance its drained-output
 * counter and decide pause/resume.
 */
export const AckFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('ack'),
  /** The highest raw-frame `seq` the client has drained. */
  seq: z.number().int().nonnegative(),
});
export type AckFrame = z.infer<typeof AckFrameSchema>;

/**
 * The application-layer high-water mark for un-acknowledged raw output, in
 * bytes. The orchestrator MUST NOT exceed this before calling `pty.pause()`.
 */
export const HIGH_WATER_MARK_BYTES = 500_000 as const;
