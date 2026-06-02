/**
 * Application-layer write-lock types for the single-writer / multi-reader lease
 * (design decision D7). The lock is an orchestrator-owned primitive — it is NOT
 * delegated to tmux, which has no single-writer-lease, takeover, or
 * lock-independent-approval semantics.
 *
 * Keystrokes are lock-gated (only the lease holder may forward raw keystrokes to
 * the PTY); structured one-shot approvals are lock-independent and are handled
 * outside this module. This module is the self-contained lease state machine; the
 * gateway/keystroke-path wiring lives in the orchestrator-integration track.
 */

/** Opaque identifier of a terminal session (one per task). */
export type SessionId = string;

/** Opaque identifier of a connected client (a desktop or phone WebSocket). */
export type ClientId = string;

/**
 * The per-session lease record. Mirrors the design's
 * `Map<sessionId, { writerClientId, leaseExpiry }>` shape exactly.
 */
export interface Lease {
  /** The single client currently granted raw write access. */
  readonly writerClientId: ClientId;
  /**
   * Absolute expiry as epoch milliseconds. Once `Date.now()` passes this value
   * without a renewing heartbeat, the lease is considered expired and may be
   * acquired by another client.
   */
  readonly leaseExpiry: number;
}

/** Configuration for lease timing. */
export interface WriteLockOptions {
  /**
   * Time-to-live applied on acquire / heartbeat / takeover, in milliseconds.
   * Each renewing heartbeat advances `leaseExpiry` to `now + leaseTtlMs`.
   */
  readonly leaseTtlMs: number;
}

/** Default lease timing. A short TTL keeps auto-release responsive; heartbeats renew it. */
export const DEFAULT_WRITE_LOCK_OPTIONS: WriteLockOptions = {
  // 30s window: long enough to tolerate a missed heartbeat on a flaky link,
  // short enough that a silently-gone writer frees the lease promptly.
  leaseTtlMs: 30_000,
};

/** Why an acquire / takeover / heartbeat attempt resolved the way it did. */
export enum LeaseOutcome {
  /** The requesting client now holds the lease. */
  Acquired = 'acquired',
  /** The requesting client already held the lease; its expiry was renewed. */
  Renewed = 'renewed',
  /** The requesting client took the lease away from a different holder. */
  TakenOver = 'taken_over',
  /** A different, still-valid holder owns the lease and was not preempted. */
  Denied = 'denied',
}

/** Result of an acquire / takeover / heartbeat operation. */
export interface LeaseResult {
  readonly outcome: LeaseOutcome;
  /** The lease as it stands after the operation, or `null` if none is held. */
  readonly lease: Lease | null;
  /**
   * The client demoted to reader as a side effect (a previous holder displaced
   * by a takeover, or an expired holder replaced on acquire). `null` when no one
   * was demoted.
   */
  readonly demotedClientId: ClientId | null;
}
