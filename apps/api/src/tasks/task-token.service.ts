import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * Per-task `TASK_TOKEN` issuance + verification (runner-dialback-and-creds 8.3,
 * consumed by the handshake verifier 8.2).
 *
 * A `TASK_TOKEN` is minted at task creation and:
 *  - is scoped to EXACTLY ONE task — a token issued for task A never validates a
 *    dial-back claiming task B;
 *  - is NON-REUSABLE across tasks — each task gets its own random token, and a
 *    token is bound to the single `taskId` it was issued for;
 *  - has a BOUNDED TTL — after the TTL elapses the token no longer verifies, so a
 *    leaked token cannot authenticate a dial-back indefinitely.
 *
 * This is the runner trust domain (a sandbox dialling back), DISTINCT from the
 * operator `AUTH_TOKEN`. Tokens are held in memory only and never persisted; an
 * orchestrator restart invalidates outstanding tokens, consistent with their
 * short-lived, single-use intent.
 */

/** Default bound on how long an issued `TASK_TOKEN` remains valid, in ms. */
export const DEFAULT_TASK_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface IssuedToken {
  /** The single task this token authenticates a dial-back for. */
  readonly taskId: string;
  /** The secret token value (random, single-task-scoped). */
  readonly token: string;
  /** Absolute epoch-ms after which the token no longer verifies. */
  readonly expiresAtEpochMs: number;
}

export interface TaskTokenServiceOptions {
  /** Token validity window in ms; defaults to {@link DEFAULT_TASK_TOKEN_TTL_MS}. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

@Injectable()
export class TaskTokenService {
  /** taskId -> the single issued token for that task. Memory only. */
  private readonly byTask = new Map<string, IssuedToken>();
  /** token value -> issued record, for O(1) verification by presented token. */
  private readonly byToken = new Map<string, IssuedToken>();

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TaskTokenServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TASK_TOKEN_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Issues a fresh, single-task-scoped `TASK_TOKEN` for `taskId` with a bounded
   * TTL. Re-issuing for the same task replaces (and invalidates) any prior token
   * so a task never has two live tokens.
   */
  issue(taskId: string): string {
    const id = taskId?.trim();
    if (!id) {
      throw new Error('Cannot issue a TASK_TOKEN without a taskId');
    }
    // Invalidate any prior token for this task before minting a new one.
    this.revokeForTask(id);

    const token = randomBytes(32).toString('base64url');
    const record: IssuedToken = {
      taskId: id,
      token,
      expiresAtEpochMs: this.now() + this.ttlMs,
    };
    this.byTask.set(id, record);
    this.byToken.set(token, record);
    return token;
  }

  /**
   * Verifies that `token` is a valid, unexpired token bound to EXACTLY
   * `claimedTaskId`. Returns `true` only when all hold:
   *  - the token is known (issued and not revoked),
   *  - it has not passed its TTL, and
   *  - it was issued for `claimedTaskId` (a token for task A claiming task B
   *    fails here).
   *
   * Verification is single-use-friendly but does NOT consume the token, so a
   * runner that briefly reconnects within the TTL re-verifies; expiry and the
   * per-task binding are the hard boundaries.
   */
  verify(claimedTaskId: string, token: string): boolean {
    const id = claimedTaskId?.trim();
    if (!id || !token) {
      return false;
    }
    const record = this.byToken.get(token);
    if (!record) {
      return false;
    }
    if (record.taskId !== id) {
      // Token issued for a different task — reject (A-token claiming task B).
      return false;
    }
    if (this.now() >= record.expiresAtEpochMs) {
      // Expired: lazily purge and reject.
      this.revokeForTask(record.taskId);
      return false;
    }
    return true;
  }

  /** Revokes the token for a task (e.g. at session end). Idempotent. */
  revokeForTask(taskId: string): void {
    const existing = this.byTask.get(taskId);
    if (!existing) {
      return;
    }
    this.byTask.delete(taskId);
    this.byToken.delete(existing.token);
  }
}
