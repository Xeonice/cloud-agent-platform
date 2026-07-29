/**
 * Process-local bookkeeping for the inline admission pipeline.
 *
 * These six containers used to be six separate private fields on
 * `GuardrailsService`, cleared by five separate `delete` calls on the shared
 * terminal path. Nothing named them as one thing, so "what state does inline
 * admission own?" could only be answered by grepping a 4,500-line class for a
 * naming convention — and the convention did not cover the 347-line block that
 * writes most of it.
 *
 * Gathering them here is what makes the pipeline removable: on the day inline
 * admission is retired, deleting this file turns every remaining use into a
 * compile error, so the removal checklist comes from the compiler instead of
 * from a reviewer's reading.
 *
 * This is bookkeeping, never authority. Inline admission has no durable cleanup
 * owner to recover after a restart, so everything here is deliberately
 * process-local and deliberately forgotten at terminal settlement.
 */

import type {
  TaskProvisioningDiagnosticCommandKind,
  TaskProvisioningDiagnosticOperation,
  TaskProvisioningDiagnosticStage,
} from '@cap/contracts';
import type {
  BegunTaskProvisioningDiagnosticObserver,
  TaskProvisioningDiagnosticPrimarySettlementInput,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-observer.adapter';

/** Last successfully accepted provider fact, for terminal-winner settlement. */
export interface InlineProvisioningDiagnosticPosition {
  readonly stage: TaskProvisioningDiagnosticStage;
  readonly operation: TaskProvisioningDiagnosticOperation;
  readonly commandKind?: TaskProvisioningDiagnosticCommandKind | null;
}

/**
 * A provider failure staged before the Task terminal CAS. It is neither
 * persisted nor logged until that CAS has confirmed `failed`.
 */
export interface InlineProvisioningFailureCandidate {
  readonly settlement: TaskProvisioningDiagnosticPrimarySettlementInput;
  readonly providerBoundaryCrossed: boolean;
}

export class InlineAdmissionState {
  /**
   * Inline admission has no durable cleanup owner to recover after restart.
   * Retain only the current process-local diagnostic controller so natural
   * terminal settlement can append bounded cleanup evidence to the same
   * attempt. Evidence plumbing, never cleanup authority.
   */
  readonly diagnosticAttempts = new Map<
    string,
    BegunTaskProvisioningDiagnosticObserver
  >();

  readonly diagnosticPositions = new Map<
    string,
    InlineProvisioningDiagnosticPosition
  >();

  readonly provisioningFailureCandidates = new Map<
    string,
    InlineProvisioningFailureCandidate
  >();

  /** The provider promise was invoked; terminal cleanup must be observed. */
  readonly providerBoundariesCrossed = new Set<string>();

  /** Provider boundary was never crossed; the primary already owns not_required. */
  readonly cleanupNotRequired = new Set<string>();

  /**
   * Inline admission has no durable lease signal, so each in-flight provider
   * call owns one process-local cancellation source. The Task terminal fence
   * aborts it synchronously; provider boundary guards still re-read the
   * persisted running transition for cross-replica cancellation.
   */
  readonly provisioningAbortControllers = new Map<string, AbortController>();

  /**
   * Drop everything retained for one task.
   *
   * Terminal settlement previously spelled this out as five separate deletions
   * in a row, which is a defect surface: a seventh container added later is
   * only cleaned up if whoever adds it remembers this exact spot. The abort
   * controllers are excluded on purpose — they are released by the provisioning
   * path itself and aborted by the terminal fence, both of which run before
   * settlement reaches here.
   */
  forget(taskId: string): void {
    this.diagnosticAttempts.delete(taskId);
    this.diagnosticPositions.delete(taskId);
    this.provisioningFailureCandidates.delete(taskId);
    this.providerBoundariesCrossed.delete(taskId);
    this.cleanupNotRequired.delete(taskId);
  }
}
