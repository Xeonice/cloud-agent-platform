import type {
  BeginSandboxCleanupAttemptResult,
  SandboxCleanupAttemptEvidence,
  SandboxRunOwnerRecord,
} from '@cap-console/sandbox-core';
import {
  SANDBOX_CLEANUP_ATTEMPT_MAX,
  sandboxCleanupAttemptPlaceholder,
} from '@cap-console/sandbox-core';

export interface InMemoryCleanupAttemptTransition {
  readonly result: BeginSandboxCleanupAttemptResult;
  readonly nextOwner?: SandboxRunOwnerRecord;
}

/**
 * Pure state transition for the in-memory cleanup-attempt allocator. Keeping
 * the persisted-attempt ceiling here lets the boundary be verified without
 * billions of state-machine iterations or mutation of the store's private map.
 * This module is intentionally internal to the provider center.
 */
export function planInMemoryCleanupAttempt(
  owner: SandboxRunOwnerRecord,
  current: SandboxCleanupAttemptEvidence | null,
  attemptId: string,
): InMemoryCleanupAttemptTransition {
  if (current?.attemptId === attemptId) {
    return { result: { kind: 'replayed', evidence: current } };
  }
  if (owner.cleanupAttemptInFlight === true) {
    return current
      ? { result: { kind: 'in-flight', evidence: current } }
      : { result: { kind: 'conflict' } };
  }
  const attempt = owner.cleanupAttemptCount ?? 0;
  if (attempt >= SANDBOX_CLEANUP_ATTEMPT_MAX) {
    return { result: { kind: 'conflict' } };
  }
  const evidence = sandboxCleanupAttemptPlaceholder(attempt + 1, attemptId);
  return {
    result: { kind: 'allocated', evidence },
    nextOwner: {
      ...owner,
      cleanupAttemptInFlight: true,
      cleanupAttemptCount: evidence.attempt,
      cleanupLastAttemptId: evidence.attemptId,
      cleanupLastOutcome: evidence.outcome,
      cleanupLastProof: evidence.proof,
      cleanupLastCause: evidence.cause,
      cleanupLastRetryable: evidence.retryable,
      cleanupLastObservedAt: evidence.observedAt,
    },
  };
}
