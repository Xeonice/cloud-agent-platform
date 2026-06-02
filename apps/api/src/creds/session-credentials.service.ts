import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  SessionCredential,
  type SessionCredentialSnapshot,
  type SessionEndReason,
} from './session-credential';

/**
 * Ephemeral session-scoped credential provider (track runner-dialback-and-creds,
 * 8.4).
 *
 * Provisions and tears down the per-session credentials that are the **primary
 * safety boundary** for a task (design D8). Every credential is:
 *
 * - minted in process memory only and **never persisted** (no DB row, no file,
 *   no log of the secret) beyond the session lifetime;
 * - **scoped to exactly one session** (one task run) and never shared across
 *   tasks; and
 * - **destroyed when the session ends** — completion, failure, or teardown —
 *   after which it can no longer authenticate.
 *
 * Cross-track wiring (isolation note in tasks.md, track 14, task 12.1b): the
 * teardown CALL SITES live in the tasks lifecycle and the guardrails (deadline /
 * idle / circuit-breaker force-fail) paths. Those callers invoke
 * {@link SessionCredentialsService.destroyForSession} at every terminal/teardown
 * transition. This module owns the provider; it does not reach into the
 * lifecycle itself.
 *
 * Because the store is in-memory, an orchestrator restart inherently destroys
 * all outstanding credentials — consistent with "never persisted beyond the
 * session". An optional {@link OnModuleDestroy} hook also revokes everything on
 * graceful shutdown.
 */
@Injectable()
export class SessionCredentialsService implements OnModuleDestroy {
  /** sessionId -> live credential. Memory only; never serialized to storage. */
  private readonly credentials = new Map<string, SessionCredential>();

  /** Number of sessions currently holding a live (non-destroyed) credential. */
  get activeCount(): number {
    return this.credentials.size;
  }

  /**
   * Provisions a fresh ephemeral credential for a session. Throws if the session
   * already has a live credential — a session is provisioned exactly once, and a
   * credential is never silently reused or shared across tasks.
   */
  provisionForSession(sessionId: string): SessionCredential {
    const id = sessionId?.trim();
    if (!id) {
      throw new Error('Cannot provision a credential without a sessionId');
    }
    if (this.credentials.has(id)) {
      throw new Error(`Session ${id} already has a provisioned credential`);
    }
    const credential = SessionCredential.mint(id);
    this.credentials.set(id, credential);
    return credential;
  }

  /** Returns the live credential for a session, or `undefined` if none/destroyed. */
  getForSession(sessionId: string): SessionCredential | undefined {
    return this.credentials.get(sessionId);
  }

  /** True while a session holds a live, non-destroyed credential. */
  hasActiveCredential(sessionId: string): boolean {
    const credential = this.credentials.get(sessionId);
    return credential !== undefined && !credential.isDestroyed;
  }

  /**
   * Authenticates a presented secret against a session's live credential.
   * Returns `false` for an unknown or already-destroyed session, which is how
   * "credentials are revoked at session end" becomes observable to callers.
   */
  verify(sessionId: string, presentedSecret: string): boolean {
    const credential = this.credentials.get(sessionId);
    if (!credential) {
      return false;
    }
    return credential.matches(presentedSecret);
  }

  /**
   * Destroys a session's credential at session end (completion, failure, or
   * teardown). The secret is zeroed so it can no longer authenticate, and the
   * entry is dropped from the in-memory store. Idempotent: destroying an unknown
   * or already-destroyed session is a safe no-op.
   *
   * This is the integration call site wired from the tasks lifecycle and the
   * guardrails teardown paths in track 14.
   *
   * @returns `true` if a live credential was destroyed, `false` if there was
   *   nothing to destroy.
   */
  destroyForSession(sessionId: string, _reason: SessionEndReason = 'teardown'): boolean {
    const credential = this.credentials.get(sessionId);
    if (!credential) {
      return false;
    }
    credential.destroy();
    this.credentials.delete(sessionId);
    return true;
  }

  /** Non-secret snapshots of all live credentials, safe for logging/metrics. */
  snapshot(): SessionCredentialSnapshot[] {
    return [...this.credentials.values()].map((credential) => credential.snapshot());
  }

  /**
   * Destroys every outstanding credential — used on graceful shutdown so no
   * secret outlives the process. Pairs with the in-memory store guaranteeing
   * nothing survives a hard restart either.
   */
  destroyAll(reason: SessionEndReason = 'teardown'): void {
    for (const sessionId of [...this.credentials.keys()]) {
      this.destroyForSession(sessionId, reason);
    }
  }

  /** NestJS shutdown hook: revoke all credentials when the module tears down. */
  onModuleDestroy(): void {
    this.destroyAll('teardown');
  }
}
