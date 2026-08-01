/**
 * What the inline admission pipeline needs back from the guardrails orchestrator.
 *
 * The pipeline used to live inside `GuardrailsService`, so this surface did not
 * exist: it reached whatever it liked through `this.`, and nothing could say how
 * coupled the two were without reading 700 lines. This interface IS that answer,
 * and it is deliberately declared *here* rather than in `guardrails` — the
 * dependency runs one way, so the module layout gate sees an acyclic edge and the
 * directory stays removable on its own.
 *
 * Anything the pipeline owns outright (its provider handle, its diagnostic
 * recorder, its process-local state) is constructor-injected instead of named
 * here. This surface is only for behaviour that remains the orchestrator's.
 */

import type {
  TaskProvisioningDiagnosticCleanupSummary,
  TaskProvisioningStage,
  TaskStatus,
} from '@cap-console/contracts';
import type {
  AgentTerminalLaunchOutcome,
  GitCloneSpec,
  SandboxProviderCapability,
  SandboxProvisionPlan,
  SandboxResolvedEnvironmentMetadata,
  SandboxRunCleanupAuthorityProjection,
  SandboxWorkspaceProgressReporter,
  WorkspaceSource,
} from '@cap-console/sandbox';
import type {
  SandboxConnection,
  SelectedSandboxRun,
} from '@/sandbox/sandbox-provider.port';
import type {
  BegunTaskProvisioningDiagnosticObserver,
  ResumedTaskProvisioningDiagnosticObserver,
  ResumeTaskProvisioningDiagnosticObserverInput,
  TaskProvisioningDiagnosticPrimarySettlementInput,
  TaskProvisioningDiagnosticSettlementController,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-observer.adapter';

/**
 * The terminal session handle, declared structurally.
 *
 * `ITerminalGateway` itself is declared inside `guardrails.service.ts` to break a
 * Nest module cycle. Importing it from there would trade that module cycle for a
 * directory cycle, so the one call this pipeline makes is named on the port and
 * the gateway never crosses the boundary as a type.
 */
export interface InlineTerminalSession {
  readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
}

/**
 * The subset of the orchestrator's logger this pipeline writes through.
 *
 * It is reached through the port rather than owned, because the log context is
 * observable: the guardrails suite asserts on messages emitted under the
 * orchestrator's context, and swaps the logger field *after* construction. A
 * logger captured at construction time, or created here with its own context,
 * would silently move those messages somewhere nobody is reading.
 */
export interface InlineAdmissionLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface InlineAdmissionOrchestratorPort {
  /** Read per call — the field it returns is replaceable after construction. */
  logger(): InlineAdmissionLogger;

  /** Drop per-task runtime registrations after a settled or superseded attempt. */
  clearAdmissionRuntime(taskId: string): void;

  /**
   * Re-prove that this attempt still owns the running transition. Every provider
   * boundary in the pipeline is fenced by this, so a terminal transition that won
   * during an await cannot start or continue stale work.
   */
  waitForRunningAdmission(
    taskId: string,
    transitionToken: string,
    signal?: AbortSignal,
  ): Promise<boolean>;

  settleProvisioningDiagnostics(
    attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    input: TaskProvisioningDiagnosticPrimarySettlementInput,
  ): Promise<void>;

  settleCleanupDiagnostics(
    settlement: TaskProvisioningDiagnosticSettlementController | undefined,
    evidence:
      | SandboxRunCleanupAuthorityProjection
      | TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<void>;

  tryResumeProvisioningDiagnostics(
    input: ResumeTaskProvisioningDiagnosticObserverInput,
  ): Promise<ResumedTaskProvisioningDiagnosticObserver | undefined>;

  forceFail(
    taskId: string,
    cause:
      | 'deadline'
      | 'idle'
      | 'circuit_breaker'
      | 'provision_failed'
      | 'abnormal_exit',
  ): Promise<TaskStatus | undefined>;

  failProvisioning(taskId: string, error: unknown): Promise<TaskStatus | undefined>;

  /** Authoritative terminal status, read through the orchestrator's own fence. */
  terminalTaskStatus(taskId: string): Promise<TaskStatus | undefined>;

  /** Whether the orchestrator has already fenced this task as terminal. */
  isTerminallyFenced(taskId: string): boolean;

  /** The fenced terminal status, if one was recorded with the fence. */
  terminalStatusOf(taskId: string): TaskStatus | undefined;

  /**
   * The union is deliberate: the plan builder infers a `null` clone spec for the
   * workspace-plan path and a real one for the compatibility path, and collapsing
   * that here would force a cast at the call site instead of stating the fact.
   */
  resolveProvisionPlan(
    taskId: string,
  ): Promise<SandboxProvisionPlan<GitCloneSpec> | SandboxProvisionPlan<null>>;

  resolveWorkspaceSource(
    taskId: string,
    plan: { readonly workspace?: unknown; readonly cloneSpec?: unknown },
    capabilities: readonly SandboxProviderCapability[],
  ): Promise<WorkspaceSource | undefined>;

  resolveSelectedRun(taskId: string): Promise<SelectedSandboxRun | null>;

  buildWorkspaceProgressChain(options: {
    readonly checkpoint?: (stage: TaskProvisioningStage) => Promise<void>;
    readonly forward?: SandboxWorkspaceProgressReporter;
  }): SandboxWorkspaceProgressReporter;

  /** Stash the live connection handle the orchestrator hands to terminal teardown. */
  registerConnection(taskId: string, connection: SandboxConnection): void;

  /**
   * Publish `SandboxProvisioned` for this (legacy) provisioning path
   * (add-domain-event-bus 4.9).
   *
   * Declared here rather than injecting the bus into this pipeline for two
   * reasons. The payload must be assembled identically to the durable path's, so
   * both go through one builder on the orchestrator side; and publishing must be
   * unable to disturb provisioning, so it goes through the orchestrator's single
   * swallowing publish seam. Everything this method needs is a value the caller
   * already holds — no lookup is performed to satisfy it.
   *
   * Returns `void` and never throws: it is an observation, not a step.
   */
  publishSandboxProvisioned(source: {
    readonly taskId: string;
    readonly connection: SandboxConnection;
    readonly selectedRun: SelectedSandboxRun | null | undefined;
    readonly plan: {
      readonly runtimeId: string;
      readonly executionMode: 'interactive-pty' | 'headless-exec';
      readonly environment?: SandboxResolvedEnvironmentMetadata | null;
    };
  }): void;

  /**
   * Publish the run-level `TaskSuperseded` for ONE pipeline run
   * (add-domain-event-bus 4.10).
   *
   * Called at most once per run, from the run's single exit, never from the
   * individual internal supersession checks — a run that passes several of those
   * observed ONE supersession, and publishing per check would report a task as
   * superseded up to nine times. `fenceToken` is the transition token this run
   * was fenced with: the losing side's own token, which is all an observer here
   * holds. No superseder identity is passed because no observation point has one.
   */
  publishRunSupersession(taskId: string, fenceToken: string): void;

  /** Whether a terminal gateway has been resolved yet. */
  hasTerminalGateway(): boolean;

  /**
   * Dial the sandbox terminal out and register the session. Only ever called
   * after {@link hasTerminalGateway} reports true, so an absent gateway is the
   * caller's branch to make rather than a silent no-op here.
   */
  openTerminalSession(
    connection: SandboxConnection,
    selectedRun: SelectedSandboxRun | null,
  ): InlineTerminalSession;
}
