import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Snapshot + tail-replay reconnect frames (realtime-terminal spec, D5).
 *
 * On reconnect the orchestrator first delivers the most recent headless
 * SerializeAddon snapshot (which records the cols/rows it was captured at so a
 * differently-sized client can reconcile geometry), then replays the tail of
 * `session.log` appended after the snapshot.
 */

/**
 * A headless SerializeAddon snapshot of the live terminal frame.
 *
 * `data` is the serialized frame (ANSI text reconstructing the visible frame).
 * `cols`/`rows` record the geometry at capture time for size reconciliation.
 * `seq` is the `session.log` byte offset the snapshot was taken at, so the
 * subsequent tail replay starts exactly after it.
 */
export const SnapshotFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('snapshot'),
  /** Serialized SerializeAddon frame content. */
  data: z.string(),
  /** Terminal columns at capture time. */
  cols: z.number().int().positive(),
  /** Terminal rows at capture time. */
  rows: z.number().int().positive(),
  /** `session.log` byte offset this snapshot corresponds to. */
  seq: z.number().int().nonnegative(),
});
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>;

/**
 * Server -> client: a tail-replay segment of `session.log` bytes appended
 * after the preceding snapshot. `data` is base64-encoded opaque bytes; `final`
 * marks the last segment so the client knows replay is complete and live
 * streaming resumes.
 */
export const TailReplayFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('tail_replay'),
  /** Base64-encoded session.log tail bytes. */
  data: z.string(),
  /** Cumulative `session.log` byte offset of the last byte in this segment. */
  seq: z.number().int().nonnegative(),
  /** True on the final tail segment; live streaming resumes after it. */
  final: z.boolean(),
});
export type TailReplayFrame = z.infer<typeof TailReplayFrameSchema>;

/**
 * Client -> server: a request to begin reconnect restoration, optionally
 * carrying the last `seq` the client already holds so the server can skip
 * already-delivered bytes, plus the client's current geometry.
 */
export const ReconnectFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('reconnect'),
  /** Highest `seq` the reconnecting client already has, if any. */
  lastSeq: z.number().int().nonnegative().optional(),
  /** Reconnecting client's terminal columns. */
  cols: z.number().int().positive().optional(),
  /** Reconnecting client's terminal rows. */
  rows: z.number().int().positive().optional(),
});
export type ReconnectFrame = z.infer<typeof ReconnectFrameSchema>;

/**
 * Client -> server: terminal geometry sync (VR.8).
 *
 * Sent whenever the browser terminal is resized (initial fit + container
 * resize). The orchestrator dispatches it to the runner PTY's `resize()` so
 * the PTY cols/rows stay in sync with the browser, making the "identical
 * cols and rows" parity precondition reachable at runtime.
 */
export const ResizeFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('resize'),
  /** New terminal column count. */
  cols: z.number().int().positive(),
  /** New terminal row count. */
  rows: z.number().int().positive(),
});
export type ResizeFrame = z.infer<typeof ResizeFrameSchema>;
