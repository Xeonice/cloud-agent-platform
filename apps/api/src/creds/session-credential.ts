import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Ephemeral, session-scoped credential (session-scoped credentials track, 8.4).
 *
 * Design D8 / spec "Ephemeral credentials destroyed with the session": the
 * sandbox-scoped credentials provisioned for a task are the **primary safety
 * boundary** for that task — not the partial-coverage Codex hook policy engine.
 * They are therefore:
 *
 * - **ephemeral**          — held only in process memory, never written to disk,
 *                            a database, or logs, and never persisted beyond the
 *                            session lifetime;
 * - **single-session**     — bound to exactly one session (one task run) and
 *                            never shared across tasks; and
 * - **destroyed at end**   — revoked when the session ends, whether by
 *                            completion, failure, or teardown, after which they
 *                            can no longer authenticate.
 *
 * This value object models a minted credential. It deliberately does not expose
 * its secret material through `toJSON`/`toString` so it cannot accidentally be
 * serialized into a log line or response body. The owning provider zeroes the
 * secret on destruction.
 */

/** Why a session's credentials were destroyed. Mirrors the session-end causes. */
export type SessionEndReason = 'completed' | 'failed' | 'teardown';

export interface SessionCredentialSnapshot {
  /** Stable id of this credential (safe to log; not the secret). */
  readonly id: string;
  /** The single session/task this credential is scoped to. */
  readonly sessionId: string;
  /** Epoch millis at which the credential was minted. */
  readonly issuedAtEpochMs: number;
  /** True once the credential has been destroyed and can no longer authenticate. */
  readonly destroyed: boolean;
}

export class SessionCredential {
  /** Stable, non-secret identifier (safe to log/correlate). */
  readonly id: string;
  /** The one session this credential authenticates; never reused for another. */
  readonly sessionId: string;
  readonly issuedAtEpochMs: number;

  /** Secret material, kept private and zeroed on destroy. Never serialized. */
  private secret: string | null;
  private destroyedFlag = false;

  constructor(params: {
    sessionId: string;
    secret: string;
    id?: string;
    issuedAtEpochMs?: number;
  }) {
    this.id = params.id ?? randomUUID();
    this.sessionId = params.sessionId;
    this.secret = params.secret;
    this.issuedAtEpochMs = params.issuedAtEpochMs ?? Date.now();
  }

  /** True once destroyed; a destroyed credential can no longer authenticate. */
  get isDestroyed(): boolean {
    return this.destroyedFlag;
  }

  /**
   * Returns the secret material, or throws if the credential has been destroyed.
   * Callers that hand the secret to a sandbox MUST do so transiently and never
   * persist it.
   */
  reveal(): string {
    if (this.destroyedFlag || this.secret === null) {
      throw new Error(
        `Session credential ${this.id} for session ${this.sessionId} has been destroyed`,
      );
    }
    return this.secret;
  }

  /**
   * Verifies a presented secret against this credential. Always returns `false`
   * once destroyed, which is what makes "destroyed credentials can no longer
   * authenticate" observable.
   */
  matches(presented: string): boolean {
    if (this.destroyedFlag || this.secret === null) {
      return false;
    }
    return this.secret === presented;
  }

  /**
   * Destroys the credential: zeroes the secret so it can no longer authenticate
   * and marks it destroyed. Idempotent — destroying twice is a no-op.
   */
  destroy(): void {
    this.secret = null;
    this.destroyedFlag = true;
  }

  /** Non-secret snapshot, safe for logging/metrics. */
  snapshot(): SessionCredentialSnapshot {
    return {
      id: this.id,
      sessionId: this.sessionId,
      issuedAtEpochMs: this.issuedAtEpochMs,
      destroyed: this.destroyedFlag,
    };
  }

  /**
   * Guard against accidental secret leakage: serializing the credential never
   * exposes the secret material.
   */
  toJSON(): SessionCredentialSnapshot {
    return this.snapshot();
  }

  /** Mints a fresh credential with cryptographically-random secret material. */
  static mint(sessionId: string, secretBytes = 32): SessionCredential {
    if (!sessionId?.trim()) {
      throw new Error('Cannot mint a session credential without a sessionId');
    }
    const secret = randomBytes(secretBytes).toString('base64url');
    return new SessionCredential({ sessionId, secret });
  }
}
