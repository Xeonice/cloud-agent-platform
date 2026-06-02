import { Injectable } from '@nestjs/common';

import {
  DEFAULT_WRITE_LOCK_OPTIONS,
  Lease,
  LeaseOutcome,
  LeaseResult,
  WriteLockOptions,
  type ClientId,
  type SessionId,
} from './write-lock.types';

/**
 * Application-layer single-writer / multi-reader write lock (design D7).
 *
 * The orchestrator owns one lease per session via a
 * `Map<sessionId, { writerClientId, leaseExpiry }>`. At most one client holds the
 * raw-write lease at a time; every other connected client is a reader that still
 * receives the read stream. The four behaviors implemented here:
 *
 *  - 7.1 single-writer / multi-reader grant — `acquire` grants the lease to at
 *        most one client; a second client is denied and remains a reader.
 *  - 7.2 heartbeat renewal + expiry release — `heartbeat` advances `leaseExpiry`;
 *        a lease whose `leaseExpiry` has passed without renewal is treated as
 *        released and may be acquired by a new writer.
 *  - 7.3 auto-release on disconnect — `releaseOnDisconnect` drops the lease
 *        immediately when the writer's connection goes away, without waiting for
 *        `leaseExpiry`.
 *  - 7.4 preemptive takeover — `takeover` lets a reader seize the lease from the
 *        current holder, demoting that holder to a reader who can no longer send
 *        raw keystrokes.
 *
 * Keystroke gating itself (consulting `isWriter` on the keystroke path) and
 * lock-independent approvals live on the gateway and are wired by the
 * orchestrator-integration track; this service is the pure lease state machine.
 *
 * Time is read via an injectable `now()` clock so the expiry logic is
 * deterministically testable.
 */
@Injectable()
export class WriteLockService {
  private readonly leases = new Map<SessionId, Lease>();

  private readonly options: WriteLockOptions;

  private readonly now: () => number;

  constructor(options?: Partial<WriteLockOptions>, clock: () => number = Date.now) {
    this.options = { ...DEFAULT_WRITE_LOCK_OPTIONS, ...options };
    this.now = clock;
  }

  /**
   * 7.1 — Attempt to acquire the write lease for `sessionId` on behalf of
   * `clientId`. Grants raw write to at most one client at a time:
   *  - If no live lease exists (never held, or expired without heartbeat), the
   *    requester becomes the writer (`Acquired`); an expired prior holder is
   *    reported as `demotedClientId`.
   *  - If the requester already holds a live lease, its expiry is renewed
   *    (`Renewed`).
   *  - If a different client holds a live lease, the requester is denied and
   *    remains a reader (`Denied`); the existing lease is unchanged.
   *
   * Acquire never preempts a live holder — that is what {@link takeover} is for.
   */
  acquire(sessionId: SessionId, clientId: ClientId): LeaseResult {
    const current = this.leases.get(sessionId);

    if (current === undefined) {
      return this.grant(sessionId, clientId, LeaseOutcome.Acquired, null);
    }

    if (this.isExpired(current)) {
      // Stale holder: free it and grant to the requester, reporting the demotion.
      const demoted = current.writerClientId === clientId ? null : current.writerClientId;
      return this.grant(sessionId, clientId, LeaseOutcome.Acquired, demoted);
    }

    if (current.writerClientId === clientId) {
      return this.grant(sessionId, clientId, LeaseOutcome.Renewed, null);
    }

    // A different client holds a live lease — the requester stays a reader.
    return {
      outcome: LeaseOutcome.Denied,
      lease: current,
      demotedClientId: null,
    };
  }

  /**
   * 7.2 — Heartbeat renewal. When the current holder sends a heartbeat before
   * `leaseExpiry`, advance `leaseExpiry` to `now + leaseTtlMs` and keep the lease
   * (`Renewed`).
   *
   * A heartbeat from a non-holder, or from the prior holder after the lease has
   * already expired and been released, does NOT silently re-grant the lease — it
   * resolves to `Denied` (caller may then explicitly {@link acquire}). This keeps
   * expiry meaningful: once `leaseExpiry` passes without a renewing heartbeat, the
   * session is available to a new writer.
   */
  heartbeat(sessionId: SessionId, clientId: ClientId): LeaseResult {
    const current = this.leases.get(sessionId);

    if (current === undefined || current.writerClientId !== clientId) {
      return { outcome: LeaseOutcome.Denied, lease: current ?? null, demotedClientId: null };
    }

    if (this.isExpired(current)) {
      // The holder let the lease lapse; release it so a new writer may acquire.
      this.leases.delete(sessionId);
      return { outcome: LeaseOutcome.Denied, lease: null, demotedClientId: null };
    }

    return this.grant(sessionId, clientId, LeaseOutcome.Renewed, null);
  }

  /**
   * 7.4 — Preemptive takeover. A reader seizes the lease for `sessionId`
   * regardless of whether a (live) holder currently exists. The requester becomes
   * the new writer; the previous holder — if any and different — is reported as
   * `demotedClientId` so the caller can demote it to a reader that can no longer
   * send raw keystrokes.
   */
  takeover(sessionId: SessionId, clientId: ClientId): LeaseResult {
    const current = this.leases.get(sessionId);
    const previousHolder =
      current !== undefined && current.writerClientId !== clientId ? current.writerClientId : null;

    const outcome = previousHolder !== null ? LeaseOutcome.TakenOver : LeaseOutcome.Acquired;
    return this.grant(sessionId, clientId, outcome, previousHolder);
  }

  /**
   * 7.3 — Immediate auto-release on writer disconnect. If `clientId` currently
   * holds the lease for `sessionId`, drop it now (do not wait for `leaseExpiry`)
   * so another client may acquire it. Returns `true` if a lease was released.
   *
   * A disconnect from a non-holder (a reader) is a no-op and returns `false`.
   */
  releaseOnDisconnect(sessionId: SessionId, clientId: ClientId): boolean {
    const current = this.leases.get(sessionId);
    if (current === undefined || current.writerClientId !== clientId) {
      return false;
    }
    this.leases.delete(sessionId);
    return true;
  }

  /**
   * Convenience for the keystroke gate (7.5, wired elsewhere): true only when
   * `clientId` holds a live, unexpired lease for `sessionId`.
   */
  isWriter(sessionId: SessionId, clientId: ClientId): boolean {
    const lease = this.getLease(sessionId);
    return lease !== null && lease.writerClientId === clientId;
  }

  /**
   * Inspect the current lease for a session, or `null` if none is held. A lease
   * whose `leaseExpiry` has passed is treated as released: it is lazily purged and
   * reported as absent.
   */
  getLease(sessionId: SessionId): Lease | null {
    const current = this.leases.get(sessionId);
    if (current === undefined) {
      return null;
    }
    if (this.isExpired(current)) {
      this.leases.delete(sessionId);
      return null;
    }
    return current;
  }

  /** Write (or overwrite) the lease for `sessionId` to `clientId` with a fresh TTL. */
  private grant(
    sessionId: SessionId,
    clientId: ClientId,
    outcome: LeaseOutcome,
    demotedClientId: ClientId | null,
  ): LeaseResult {
    const lease: Lease = {
      writerClientId: clientId,
      leaseExpiry: this.now() + this.options.leaseTtlMs,
    };
    this.leases.set(sessionId, lease);
    return { outcome, lease, demotedClientId };
  }

  private isExpired(lease: Lease): boolean {
    return this.now() >= lease.leaseExpiry;
  }
}
