/**
 * Everything the guardrails orchestrator is allowed to ask of inline admission.
 *
 * The reverse direction — what this pipeline needs back from the orchestrator —
 * is {@link InlineAdmissionOrchestratorPort}. Both are declared here, in the
 * directory being isolated, so the coupling is countable from one place and the
 * dependency still runs one way.
 *
 * Declaring this rather than letting `GuardrailsService` hold the concrete class
 * buys one specific thing: the surface cannot grow by accident. A new public
 * method on `InlineAdmissionPipeline` is invisible to the orchestrator until
 * someone adds it here, which is the moment to ask whether the pipeline being
 * retired should be acquiring new callers at all.
 *
 * On the day inline admission is deleted, this file is the removal checklist —
 * ten entries, each one a call site the compiler will point at.
 */

import type { TaskStatus } from '@cap-console/contracts';
import type { AdmissionTransitionResult } from '@/task-operations/task-operations.port';
import type { BegunTaskProvisioningDiagnosticObserver } from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-observer.adapter';

export interface InlineAdmissionPort {
  /**
   * Provision the sandbox and start the run, synchronously, inside the accepting
   * request. Returns the transition result the orchestrator would have produced
   * when this code was inlined in `startRunningAfterCapacity`.
   */
  run(
    taskId: string,
    transitionToken: string,
    diagnosticAttempt?: BegunTaskProvisioningDiagnosticObserver,
  ): Promise<AdmissionTransitionResult | 'failed'>;

  /** The terminal fence aborts an in-flight provider call synchronously. */
  abortProvisioning(taskId: string): void;

  /** Recover this task's retained diagnostic attempt for terminal settlement. */
  resolveTerminalDiagnosticAttempt(
    taskId: string,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined>;

  /** Whether a provider boundary was crossed and so cleanup must be observed. */
  providerBoundaryCrossed(taskId: string): boolean;

  /** Whether the primary settlement already owns `not_required` for cleanup. */
  cleanupNotRequired(taskId: string): boolean;

  markCleanupNotRequired(taskId: string): void;

  /** Settle the retained attempt against a terminal transition this path lost. */
  settleTerminalPrimary(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    status: TaskStatus | undefined,
    providerBoundaryCrossed: boolean,
  ): Promise<void>;

  /** Settle an attempt superseded before or during provisioning. */
  settleProvisioningSupersession(
    taskId: string,
    diagnosticAttempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    error?: unknown,
    providerBoundaryCrossed?: boolean,
  ): Promise<void>;

  /** Retain a freshly begun attempt so terminal settlement can append to it. */
  rememberBegunAttempt(
    taskId: string,
    attempt: BegunTaskProvisioningDiagnosticObserver,
  ): void;

  /** Drop everything retained for a task that has finished settling. */
  forget(taskId: string): void;
}
