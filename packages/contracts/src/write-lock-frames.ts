import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Write-lock / takeover frames (write-lock-and-takeover spec, D7).
 *
 * The orchestrator maintains an application-layer single-writer/multi-reader
 * lease per session: `Map<sessionId, { writerClientId, leaseExpiry }>`. Raw
 * keystrokes are lock-gated; structured one-shot approvals are lock-independent.
 */

// ---------------------------------------------------------------------------
// Lease state shape
// ---------------------------------------------------------------------------

/**
 * The per-session lease value: the single client holding raw write, and the
 * expiry past which the lease is released if not renewed by heartbeat.
 */
export const WriteLeaseSchema = z.object({
  writerClientId: z.string().min(1),
  /** Epoch milliseconds at which the lease expires without a renewing heartbeat. */
  leaseExpiry: z.number().int().nonnegative(),
});
export type WriteLease = z.infer<typeof WriteLeaseSchema>;

/**
 * The full lease map shape: `sessionId` -> lease. Modeled as a record so the
 * inferred type is exactly `Record<sessionId, { writerClientId, leaseExpiry }>`.
 */
export const WriteLeaseMapSchema = z.record(z.string(), WriteLeaseSchema);
export type WriteLeaseMap = z.infer<typeof WriteLeaseMapSchema>;

// ---------------------------------------------------------------------------
// Keystroke frame (lock-gated raw write)
// ---------------------------------------------------------------------------

/**
 * Client -> server: raw keystroke input for the PTY. Forwarded ONLY when the
 * sending client holds the write lease; otherwise dropped (not an approval).
 * `data` is base64-encoded opaque input bytes.
 */
export const KeystrokeFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('keystroke'),
  sessionId: z.string().min(1),
  /** Base64-encoded raw input bytes destined for the PTY. */
  data: z.string(),
});
export type KeystrokeFrame = z.infer<typeof KeystrokeFrameSchema>;

// ---------------------------------------------------------------------------
// Heartbeat frame (lease renewal)
// ---------------------------------------------------------------------------

/**
 * Client -> server: the lease holder renews its lease, advancing `leaseExpiry`.
 */
export const HeartbeatFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('heartbeat'),
  sessionId: z.string().min(1),
  writerClientId: z.string().min(1),
});
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;

// ---------------------------------------------------------------------------
// Takeover-request frame (preemptive takeover)
// ---------------------------------------------------------------------------

/**
 * Client -> server: a reader preemptively takes over the lease, demoting the
 * current holder to reader.
 */
export const TakeoverRequestFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('takeover_request'),
  sessionId: z.string().min(1),
  /** The client requesting to become the new writer. */
  clientId: z.string().min(1),
});
export type TakeoverRequestFrame = z.infer<typeof TakeoverRequestFrameSchema>;

/**
 * Server -> clients: the lease for a session changed (granted, renewed,
 * taken-over, expired, or released). `lease` is null when the session has no
 * current writer.
 */
export const LeaseStateFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('lease_state'),
  sessionId: z.string().min(1),
  lease: WriteLeaseSchema.nullable(),
});
export type LeaseStateFrame = z.infer<typeof LeaseStateFrameSchema>;
