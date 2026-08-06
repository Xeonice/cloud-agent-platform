import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  DomainEvent,
  DomainEventEnvironmentSnapshot,
  DomainEventProviderFamily,
  DomainEventSandboxReference,
  DomainEventType,
  TaskProvisioningDiagnosticCleanupSummary,
  TaskProvisioningStage,
  TaskStatus,
} from '@cap-console/contracts';
import {
  SANDBOX_PROVIDER_FAMILIES,
  TERMINAL_TASK_STATUSES,
} from '@cap-console/contracts';
import {
  DOMAIN_EVENT_BUS,
  type DomainEventBusPort,
} from '@/domain-events/domain-event-bus.port';
import {
  AdmissionTransitionIndeterminateError,
  TASK_OPERATIONS,
  type AdmissionTransitionResult,
  type TaskOperationsPort,
} from '@/task-operations/task-operations.port';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '@/prisma/prisma.service';
import { SessionCredentialsService } from '@/creds/session-credentials.service';
import {
  SANDBOX_PROVIDER,
  type SandboxConnection,
  type SandboxProvider,
  type SelectedSandboxRun,
} from '@/sandbox/sandbox-provider.port';
import {
  buildSandboxProvisionPlan,
  createExactHostGitCredential,
  forceFailSettlePlan,
  selectDeliverySandboxProvider,
  selectSandboxProvider,
  snapshotSandboxProvisionContext,
  terminalSettlePlan,
  isSandboxRuntimeModelSetupError,
  isSandboxProvisioningCapacityError,
  isSandboxProvisioningStageError,
  isSandboxWorkspaceMaterializationError,
  isSandboxCleanupCoordinationPendingError,
  isSandboxWorkspaceTransferDetachedSignal,
  type AgentTerminalLaunchOutcome,
  type SandboxDetachedWorkspaceTransferJob,
  type SandboxWorkspaceTransferDetachment,
  type SandboxTerminalPtyMode,
  type SandboxSettlePlan,
  type SandboxRunCleanupAuthorityProjection,
  type SandboxResolvedEnvironmentMetadata,
  type SandboxProviderCapability,
  type SandboxWorkspaceProgressEvent,
  type SandboxWorkspaceProgressReporter,
  type WorkspaceSource,
} from '@cap-console/sandbox';
import {
  TaskAdmissionCoordinationError,
  TaskAdmissionLeaseLostError,
  TaskAdmissionProcessingError,
  type TaskAdmissionClaim,
  type TaskAdmissionParkedJobPort,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionProcessResult,
  type TaskAdmissionTerminalFailure,
  type TaskAdmissionTerminalRecovery,
} from '@/admission-coordination/task-admission.types';
import {
  createThrottledTransferProgressWriter,
  type ThrottledTransferProgressWriter,
} from './transfer-progress-throttle';
import { triageParkedAdmissionMarkers } from '@/admission-coordination/parked-admission-triage';
import type { ProvisionLookup } from '@/provision-lookup/provision-lookup.port';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
  type ProvisioningAuditFailure,
} from '@/audit/audit-recorder.port';
import { ForgeTargetResolver } from '@/forge/forge-target-resolver';
import { DefaultForgeRegistry } from '@/forge/forge-registry';
import {
  TaskBranchResolutionError,
  TaskBranchResolver,
  isTaskBranchResolutionError,
} from '@/forge/task-branch-resolver';
import { isWorkspaceSourceResolutionError } from '@/sandbox/workspace-source-resolver';
import { ConcurrencySemaphore } from './semaphore';
import { DeadlineWatcher } from './deadline-watcher';
import { IdleTracker } from './idle-tracker';
import { CircuitBreaker, type FailureKind } from './circuit-breaker';
import {
  CAPACITY_PROJECTION_PORT,
  type CapacityProjectionPort,
} from '@/runner-metrics/capacity-projection.port';
import { NOOP_SESSION_TRANSCRIPT_CAPTURE } from '@/session-transcripts/session-transcript.port';
import {
  createDetachedRunnerMinutes,
  RUNNER_MINUTES_PORT,
  type RunnerMinutesPort,
} from '@/runner-metrics/runner-minutes-ledger.port';
import {
  runWithTaskLog,
  runWithTaskProvisioningAttemptLog,
} from '@/observability/log-context';
import type { RuntimeOutputFailure } from '@/agent-runtime/agent-runtime.port';
import {
  isProvisioningTaskFailureCode,
  isRuntimeTaskFailureCode,
  taskFailureFromRecord,
  type ProvisioningTaskFailureCode,
  type RuntimeTaskFailureCode,
} from '@/task-failure/task-failure';
import {
  classifyRuntimeModelRejectionEvidence,
  type RuntimeModelRejectionEvidence,
} from '@/agent-runtime/runtime-model-rejection-evidence';
import { isValidMaxConcurrentTasks } from '@/task-concurrency/limit';
import {
  TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
  type TaskProvisioningDiagnosticRecorderPort,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  type TaskProvisioningDiagnosticsWriteGatePort,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import {
  classifyTaskProvisioningDiagnosticPrimaryFailure,
  taskProvisioningDiagnosticCauseFromFailureCode,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-primary.classifier';
import {
  TaskProvisioningDiagnosticsObserverLifecycle,
  type TaskProvisioningDiagnosticsObserverLifecyclePort,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-observer-lifecycle.port';
import {
  type BeginTaskProvisioningDiagnosticObserverInput,
  type BegunTaskProvisioningDiagnosticObserver,
  type ResumedTaskProvisioningDiagnosticObserver,
  type TaskProvisioningDiagnosticSettlementController,
  type TaskProvisioningDiagnosticPrimarySettlementInput,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-observer.adapter';

const EXIT_FAILURE_CLASSIFICATION_TIMEOUT_MS = 2_000;
const TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS = 2_000;
const SANDBOX_CLEANUP_TERMINAL_POLICY_MAX_ATTEMPTS_DEFAULT = 3;
type ImmediateRuntimeFailureCode =
  | RuntimeOutputFailure['code']
  | 'runtime_model_setup_failed';

interface DurableTerminalCleanupOptions {
  readonly disposition?: 'superseded-remove' | 'terminal-retain';
  readonly sessionReason?: 'completed' | 'failed';
  readonly captureTranscript?: boolean;
  readonly deliverWorkspace?: boolean;
  readonly diagnostics?: BegunTaskProvisioningDiagnosticObserver['diagnostics'];
  readonly diagnosticSettlement?: TaskProvisioningDiagnosticSettlementController;
}

interface DurableTerminalTaskSnapshot {
  readonly status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'agent_failed_to_start';
  readonly failureCode: string | null;
}



type RecoveredFailedAdmission =
  | { readonly kind: 'provisioning'; readonly causeCode: ProvisioningTaskFailureCode }
  | { readonly kind: 'runtime' }
  | { readonly kind: 'generic' };

/**
 * Guardrails integration (integration 12.1b).
 *
 * Composes the four self-contained guardrail classes — the concurrency semaphore
 * (12.1), wall-clock deadline watcher (12.2), idle tracker (12.3), and start/turn
 * circuit breaker (12.4) — and WIRES their cross-track call sites:
 *
 *  - capacity mirror: durable admission reserves capacity in the database and
 *    reflects the granted slot here. Nothing offers into the semaphore's local
 *    backlog any more — the in-request pipeline that did was retired — so it
 *    carries no queue-promotion callback; a durable acceptance that loses the
 *    capacity race is settled `queued` on its work ROW and re-claimed there.
 *  - force-fail + teardown + slot-release: the deadline / idle / circuit-breaker
 *    callbacks transition the task to `failed`, tear down its session-scoped
 *    credentials (the primary safety boundary), and release its concurrency
 *    slot. Under the connect-in model there is no per-task `TASK_TOKEN` to
 *    revoke — the session-scoped credentials are the sole authentication
 *    boundary.
 *
 * The guardrail CLASSES own no task state and perform no writes; this service is
 * the integration seam that turns their decisions into lifecycle transitions and
 * session teardown. It depends on the {@link SandboxProvider} PORT by token
 * (9.1b), not a concrete impl.
 */

/**
 * The resolved exit status of a terminated sandbox session, mapped to a
 * guardrail outcome by {@link GuardrailsService.recordExit} (4.3). Structurally
 * matches the terminal bridge's `AioExitStatus` so the gateway can pass its
 * resolved status straight through, without coupling guardrails to the terminal
 * module's internals.
 */
export interface ExitStatus {
  /** The numeric exit code, or `null` when it could not be resolved. */
  readonly code: number | null;
  /**
   * True when the session terminated abnormally (the WS closed before the
   * session was established, or the exit status could not be resolved). An
   * abnormal termination maps to `recordFailure` regardless of `code`.
   */
  readonly abnormal: boolean;
}

/**
 * Narrow slice of the terminal gateway that this service depends on (4.2).
 *
 * Declared as a structural interface — rather than importing the concrete
 * `TerminalGateway` — to BREAK the module cycle: `TerminalModule` imports
 * `GuardrailsModule` (the gateway injects `GuardrailsService`), so a direct
 * dependency back on the gateway would form `GuardrailsModule -> TerminalModule
 * -> GuardrailsModule`. The runtime gateway instance satisfies this shape; it is
 * resolved lazily via {@link ModuleRef} in {@link GuardrailsService.onModuleInit}.
 */
export interface ITerminalGateway {
  /**
   * Open a task's terminal session under the connect-in model: dial the sandbox
   * terminal OUT (an `AioPtyClient` to `connection.wsUrl`) and register the
   * `TerminalSession`. Idempotent for an already-open task.
   */
  openSession(
    connection: SandboxConnection,
    selectedRun?: SelectedSandboxRun | null,
    options?: {
      /** Recovery must prove an existing session and never launch a new one. */
      readonly mode?: SandboxTerminalPtyMode;
      readonly signal?: AbortSignal;
      readonly beforeAgentLaunch?: () => Promise<void>;
    },
  ): {
    readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
  };
  /** Remove a task's terminal session (e.g. on completion/teardown). */
  unregisterSession(taskId: string): void;
  /**
   * Compatibility-named seam returning bounded owner-output failure evidence.
   * It does not require full raw `session.log` recording to be enabled.
   */
  readSessionLogTail(taskId: string): Promise<string>;
}

/**
 * DI token the terminal gateway is re-provided under (in `TerminalModule`) so
 * this service can resolve it LAZILY by token via {@link ModuleRef} without a
 * value import of `TerminalGateway` — keeping the `GuardrailsModule <->
 * TerminalModule` cycle out of the module graph entirely (4.2).
 */
export const TERMINAL_GATEWAY_TOKEN = 'TERMINAL_GATEWAY';

/**
 * Narrow slice of the `SessionTranscriptService` this service depends on
 * (persist-session-transcripts 3.1). Declared as a STRUCTURAL interface — rather
 * than importing the concrete `SessionTranscriptService` from the tasks module —
 * to avoid a value import across the `GuardrailsModule -> TasksModule` boundary
 * here; the Integration track (I.2) supplies the real provider under
 * {@link TRANSCRIPT_SERVICE_TOKEN} (resolved from the already-imported
 * `TasksModule`). The runtime service instance satisfies this shape.
 */
export interface ITranscriptCapture {
  /**
   * Persist the task's codex rollout to durable storage while the container is
   * still present (gzipped archive + index upsert). Best-effort by contract: it
   * logs and swallows its own errors and resolves to a status flag, never
   * throwing — but the guardrails call sites still wrap it defensively so even a
   * surprise throw can never block a terminal transition / teardown / slot release.
   */
  capture(taskId: string): Promise<unknown>;
}

/**
 * DI token the `SessionTranscriptService` is supplied under to this service by
 * the Integration track (I.2), so the Track-3 capture call sites bind to a live
 * provider WITHOUT a value import of the tasks-module service — mirroring the
 * lazy, token-based wiring used for the terminal gateway (4.2).
 */
export const TRANSCRIPT_SERVICE_TOKEN = 'TRANSCRIPT_SERVICE';

export interface GuardrailsConfig {
  /**
   * Max tasks running concurrently. Seeded from env `MAX_CONCURRENT_TASKS` at
   * construction; the persisted system-level setting (when a `SystemSettings`
   * row exists) overrides it at bootstrap via
   * {@link GuardrailsService.loadPersistedCeiling}, and a settings save pushes
   * a new value at runtime via
   * {@link GuardrailsService.setMaxConcurrentTasks} — so the effective ceiling
   * resolves as `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5`.
   */
  readonly maxConcurrentTasks: number;
  /**
   * OPERATOR-LEVEL default idle ceiling in ms (`MAX_IDLE_MS`), applied to tasks
   * created WITHOUT a per-task `idleTimeoutMs`. `null` ⇒ no default: idle
   * reclamation is OFF unless a task opts in. A per-task `idleTimeoutMs` always
   * overrides this. (Renamed from the prior always-on `maxIdleMs`.)
   */
  readonly defaultIdleTimeoutMs: number | null;
  /** Consecutive start/turn failures that trip the circuit breaker. */
  readonly circuitBreakerThreshold: number;
  /** Short evidence-write bound; diagnostics never become admission authority. */
  readonly diagnosticWriteTimeoutMs?: number;
  /**
   * Bounded reconciliation policy. A positive value permits the exact
   * generation owner to atomically relinquish after that many persisted
   * physical attempts; invalid/absent values use the safe product default.
   */
  readonly cleanupTerminalPolicyMaxAttempts?: number;
}

/** Defaults sourced from env at module construction; safe for local/dev. */
export const DEFAULT_GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 5,
  // Idle reclamation is OPT-IN and OFF by default: no implicit ceiling. An
  // operator sets `MAX_IDLE_MS` for a global default, or a task supplies its own
  // `idleTimeoutMs`; with neither, a task is never force-failed for idleness.
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS,
  cleanupTerminalPolicyMaxAttempts:
    SANDBOX_CLEANUP_TERMINAL_POLICY_MAX_ATTEMPTS_DEFAULT,
};

/**
 * Optional per-task admission context. Guardrail limits are opt-in:
 * an absent `idleTimeoutMs` leaves idle reclamation to the operator-level default
 * (off when unset); an absent `deadlineMs` means no wall-clock deadline.
 */
export interface GuardrailParams {
  /** Wall-clock deadline in ms from admission; absent ⇒ no deadline. */
  readonly deadlineMs?: number;
  /** Per-task idle ceiling in ms; absent ⇒ operator-level default (off when unset). */
  readonly idleTimeoutMs?: number;
  /** Account owner on whose behalf queued/running lifecycle transitions occur. */
  readonly userId?: string;
}

/** Final database/status fence run after attach is proven, before local restore. */
export interface GuardrailsReadoptOptions {
  readonly beforeCommit?: () => Promise<boolean>;
}

/**
 * Result of a startup re-adoption attempt.
 *
 * `absent` is provider-attested and may enter orphan reclamation;
 * `superseded` means the final task/admission fence rejected the restore and
 * must be re-read by the caller. Indeterminate attach outcomes reject instead
 * of being collapsed into either result.
 */
export type GuardrailsReadoptResult = 'attached' | 'absent' | 'superseded';

/**
 * What the provisioning path holds when it publishes `SandboxProvisioned`.
 *
 * Structural on purpose: the durable seam passes the plan it built and the run
 * it re-read strictly. It does not have to fetch anything to satisfy this
 * shape, which is the "no new data pipeline" rule expressed as a type.
 */
export interface SandboxProvisionedEventSource {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly selectedRun: SelectedSandboxRun | null | undefined;
  readonly plan: {
    readonly runtimeId: string;
    readonly executionMode: 'interactive-pty' | 'headless-exec';
    readonly environment?: SandboxResolvedEnvironmentMetadata | null;
  };
}

/**
 * ── `SandboxProvisioned` payload builders (add-domain-event-bus 4.5 / 4.9) ────
 *
 * ONE copy, and now only one caller: the second provisioning path these
 * builders were shared with — the retired in-request pipeline, which published
 * through the orchestrator port — is gone. Keeping a single copy is still what
 * prevents the drift the payload exists to prevent, and it is what a second
 * provisioning path would have to reuse rather than reimplement.
 *
 * All three are pure functions of values the seam already holds. No provider
 * call, no database read, no resolver — the requirement, written as code.
 */
function domainEventProviderFamily(
  source: SandboxProvisionedEventSource,
): DomainEventProviderFamily {
  const observed =
    source.selectedRun?.environment?.providerFamily ??
    source.plan.environment?.providerFamily;
  // `SandboxEnvironmentProviderFamily` is deliberately open (a third party may
  // register a family this build has never heard of) while the event vocabulary
  // is closed. Narrowing THROUGH the single declaration keeps the two from
  // drifting and, more importantly, keeps an unknown family from failing
  // validation and dropping an otherwise perfectly good event: `unknown` is the
  // honest answer, and the schema admits it for exactly this reason.
  return (SANDBOX_PROVIDER_FAMILIES as readonly string[]).includes(
    observed as string,
  )
    ? (observed as DomainEventProviderFamily)
    : 'unknown';
}

function domainEventSandboxReference(
  source: SandboxProvisionedEventSource,
): DomainEventSandboxReference {
  return {
    baseUrl: source.connection.baseUrl,
    wsUrl: source.connection.wsUrl,
    // Optional in the schema because the selected-run lookup is allowed to come
    // back empty; the connection above always exists at the publish point.
    ...(source.selectedRun?.providerId === undefined
      ? {}
      : { providerId: source.selectedRun.providerId }),
    ...(source.selectedRun?.providerSandboxId === undefined
      ? {}
      : { providerSandboxId: source.selectedRun.providerSandboxId }),
  };
}

function domainEventEnvironmentSnapshot(
  source: SandboxProvisionedEventSource,
): DomainEventEnvironmentSnapshot {
  const environment = source.plan.environment ?? undefined;
  return {
    // Required: both paths hold them unconditionally as provision-context fields.
    runtimeId: source.plan.runtimeId,
    executionMode: source.plan.executionMode,
    // Optional: the pinned environment exists only for an explicit model intent,
    // so a runtime-default task legitimately carries none of these.
    ...(environment?.environmentId === undefined
      ? {}
      : { environmentId: environment.environmentId }),
    ...(environment?.name === undefined ? {} : { name: environment.name }),
    ...(environment?.sourceKind === undefined
      ? {}
      : { sourceKind: environment.sourceKind }),
    ...(environment?.sourceRef === undefined
      ? {}
      : { sourceRef: environment.sourceRef }),
    ...(environment?.digest === undefined ? {} : { digest: environment.digest }),
    ...(environment?.checksum === undefined
      ? {}
      : { checksum: environment.checksum }),
  };
}

@Injectable()
export class GuardrailsService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(GuardrailsService.name);

  /**
   * The task operations are resolved lazily in {@link onModuleInit} (not injected in the
   * constructor) to BREAK the Tasks<->Guardrails construction cycle: TasksService
   * @Optional-injects GuardrailsService (GUARDRAILS_SERVICE_TOKEN), and a
   * constructor-time dependency back on TasksService made NestFactory.create()
   * deadlock — the app silently exited 0 mid-bootstrap (no listen). Resolving it
   * after all providers are instantiated gives both sides the real instance.
   */
  private tasks!: TaskOperationsPort;

  /**
   * The terminal gateway, resolved lazily in {@link onModuleInit} (not injected
   * in the constructor) to break the `GuardrailsModule <-> TerminalModule`
   * construction cycle — the gateway injects this service, so a constructor-time
   * dependency back on it would deadlock NestFactory.create() the same way the
   * Tasks cycle did. Optional: when the terminal module is not present (e.g. a
   * guardrails-only unit context) this stays undefined and provisioning still
   * captures the connection handle without opening a session. (4.2)
   */
  private gateway?: ITerminalGateway;

  /**
   * Forge result-delivery dependencies (add-multi-forge-task-delivery), resolved
   * lazily in {@link onModuleInit} via {@link ModuleRef} (like {@link tasks}).
   * Optional: absent in a guardrails-only unit context, in which case push-back
   * is skipped. The Forge module has no dependency back on guardrails, so this is
   * a one-way lazy lookup with no cycle.
   */
  private forgeResolver?: ForgeTargetResolver;
  private forgeRegistry?: DefaultForgeRegistry;
  /** Shared immutable branch semantics for clone/recovery and PR base intent. */
  private branchResolver?: TaskBranchResolver;

  private readonly semaphore: ConcurrencySemaphore;
  private readonly deadlines: DeadlineWatcher;
  private readonly idle: IdleTracker;
  private readonly breaker: CircuitBreaker;
  /**
   * Operator-level default idle ceiling (ms) for tasks created without a per-task
   * `idleTimeoutMs`; `null` ⇒ no default (idle reclamation off unless opted in).
   */
  private readonly defaultIdleTimeoutMs: number | null;
  private readonly diagnosticWriteTimeoutMs: number;
  /**
   * The OWNER of the provisioning-diagnostic observer lifecycle
   * (collapse-three-collaborator-groups).
   *
   * Beginning and resuming an observer left this class whole, gate reading
   * included. What remains here is one collaborator that answers with an
   * observer or with the "no observer" result, so no call site below evaluates
   * a deployment switch or inspects whether a recorder was wired.
   */
  private readonly provisioningDiagnostics: TaskProvisioningDiagnosticsObserverLifecyclePort;
  private readonly cleanupTerminalPolicyMaxAttempts: number;
  /**
   * One valid durable claim owns one process execution. Retain the settled
   * promise for the lifetime of the claim object so concurrent and sequential
   * re-entry cannot repeat capacity reservation, diagnostic operations, or a
   * provider boundary. A newly claimed expired lease is a distinct object and
   * therefore starts its own fenced attempt. This is only same-process
   * coalescing for the Worker's stable claim object; the database lease and
   * SandboxRun ownership fence remain the cloned/cross-replica authority.
   */
  private readonly durableAdmissionsByClaim = new WeakMap<
    TaskAdmissionProcessorContext['claim'],
    Promise<TaskAdmissionProcessResult>
  >();
  private readonly durableTerminalRecoveriesByClaim = new WeakMap<
    TaskAdmissionProcessorContext['claim'],
    Promise<TaskAdmissionTerminalRecovery>
  >();
  /** Coalesces duplicate startup readoption and keeps terminal fences live. */
  private readonly readoptionsInFlight = new Map<
    string,
    Promise<GuardrailsReadoptResult>
  >();
  /**
   * Exact durable fence retained for a re-adopted runtime. If a different API
   * replica wins the Task terminal transition, a later local exit can re-read
   * this fence and discard only process-local accounting without repeating the
   * winner's provider teardown or result delivery.
   */
  private readonly readoptionAuthorityChecks = new Map<
    string,
    () => Promise<boolean>
  >();
  /** Counts local terminal settlement owners; a provisional fence is not ownership. */
  private readonly terminalSettlementsInFlight = new Map<string, number>();
  /** Per-process terminal fence retained only while an admission flow is in flight. */
  private readonly terminalTasks = new Set<string>();
  /** Known local Task-CAS winner used to avoid projecting every supersession as cancellation. */
  private readonly terminalTaskStatuses = new Map<string, TaskStatus>();
  /** Desired guardrail plan, consumed only if the matching Task CAS wins. */
  private readonly forcedTerminalPlans = new Map<
    string,
    {
      readonly status: 'completed' | 'failed';
      readonly plan: SandboxSettlePlan;
    }
  >();

  /**
   * The resolved OWNER of the per-process ledger of task running intervals
   * (admission→terminal), the source for the DERIVED runner-minutes metric
   * (be-metrics 5.4). The guardrails service is the admission/terminal seam, so
   * it is the natural place to OBSERVE running durations; the `Task` table
   * persists only `createdAt`, so this timing is observed in-process and resets
   * on restart — which is exactly why the metric is labeled derived accounting,
   * not billing.
   *
   * Observing is all this service does now. The ledger STATE lives in a provider
   * under `runner-metrics` (extract-runner-minutes-ledger) and is reached only
   * through {@link RunnerMinutesPort}; this member is filled by the
   * {@link RUNNER_MINUTES_PORT} lookup in `onModuleInit` and stays unset when
   * that module is not wired into the context.
   */
  private ownedRunnerMinutes?: RunnerMinutesPort;

  /**
   * The injector-less fallback for an instance that never resolves the owner.
   *
   * The guardrails unit spec constructs this service POSITIONALLY with no
   * injector, so `onModuleInit` never runs there while its assertions still
   * read recorded intervals reflectively. Those assertions are all NEGATIVE
   * (no interval left open), so a no-op double would satisfy every one of them
   * vacuously — hence a real ledger, produced by the port's detached factory.
   * In a booted application the accessor below prefers the resolved owner, so
   * this instance is BYPASSED rather than replaced and records nothing.
   */
  private readonly detachedRunnerMinutes: RunnerMinutesPort =
    createDetachedRunnerMinutes();

  /**
   * The member every runner-minutes write site names, unchanged in spelling so
   * the recording calls keep their existing text.
   *
   * It is deliberately an ACCESSOR over two differently-named backing members
   * rather than one field the lookup assigns to: the dependency-budget ratchet
   * counts `\b`-anchored raw-source references to the accessed member, strips
   * no comments, and would count an assignment just as it counts a call — so a
   * field-plus-assignment shape would MOVE the reference this change removes
   * instead of removing it.
   */
  private get runnerMinutes(): RunnerMinutesPort {
    return this.ownedRunnerMinutes ?? this.detachedRunnerMinutes;
  }

  /**
   * The addressable {@link SandboxConnection} handle returned by `provision()`
   * for each running task, keyed by taskId. Captured at `startRunning` (4.1) so
   * the terminal gateway can open an `AioPtyClient` to `connection.wsUrl`; the
   * integration track hands this handle through to the gateway (4.2). Cleared on
   * teardown when the task settles.
   */
  private readonly connections = new Map<string, SandboxConnection>();
  /** Process-local timer/accounting mirror; database Task status owns capacity. */
  private readonly durableRuntimeArmed = new Set<string>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly creds: SessionCredentialsService,
    @Optional()
    @Inject(SANDBOX_PROVIDER)
    private readonly sandbox?: SandboxProvider,
    @Optional() config: GuardrailsConfig = DEFAULT_GUARDRAILS_CONFIG,
    @Optional()
    private readonly provisionLookup?: ProvisionLookup,
    /**
     * Best-effort audit recorder (6.2), injected by the {@link AUDIT_RECORDER_TOKEN}
     * (verify-phase wiring in `app.module.ts`). Optional so the service still
     * constructs without it; when absent, transitions proceed unaudited.
     * Ordinary lifecycle/progress calls are best-effort. Durable provisioning
     * terminal detail is acknowledged before cleanup so recovery can retry it.
     */
    @Optional()
    @Inject(AUDIT_RECORDER_TOKEN)
    private readonly audit?: AuditRecorderPort,
    /**
     * Prisma client for the bootstrap-time persisted-ceiling read and the
     * post-terminal-CAS durable-work/Task authority checks. Optional so
     * guardrails-only unit contexts still construct without a database; when
     * absent, {@link loadPersistedCeiling} degrades to the env-seeded ceiling,
     * while production durable terminal recovery fails closed. Ordinary slot
     * admission still does not read this client: the in-memory ceiling is
     * updated only at bootstrap load and on a settings-save push.
     */
    @Optional()
    private readonly prisma?: PrismaService,
    /**
     * Best-effort durable transcript capture (persist-session-transcripts 3.1),
     * supplied under {@link TRANSCRIPT_SERVICE_TOKEN} by the Integration track
     * (I.2) from the already-imported `TasksModule`.
     *
     * collapse-three-collaborator-groups — NON-optional now. The composition
     * binds this token to the capture owner, or to the no-op stand-in when no
     * capture provider is composed, and the default below covers the positional
     * construction that has no injector at all. So this member is always an
     * implementation and the capture site below has no presence to branch on.
     * The default is a parameter default rather than a required parameter
     * because TypeScript forbids a required parameter after an optional one, and
     * the three parameters ahead of this one are genuinely optional. The
     * provider is best-effort by contract, but the call site still wraps it
     * defensively so even a surprise throw can never block a terminal
     * transition / teardown / slot release.
     */
    @Inject(TRANSCRIPT_SERVICE_TOKEN)
    private readonly transcripts: ITranscriptCapture = NOOP_SESSION_TRANSCRIPT_CAPTURE,
    /**
     * Evidence-only recorder and its independent, default-closed write switch.
     * They sit last to preserve construction compatibility in focused tests.
     */
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTIC_RECORDER)
    private readonly provisioningDiagnosticRecorder?: TaskProvisioningDiagnosticRecorderPort,
    @Optional()
    @Inject(TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE)
    private readonly provisioningDiagnosticWriteGate?: TaskProvisioningDiagnosticsWriteGatePort,
    /**
     * The in-process domain event bus (add-domain-event-bus D12). ELEVENTH and
     * LAST on purpose: nine specs outside this directory construct this service
     * positionally and pass only the leading arguments, so anything but a
     * trailing optional parameter would break them — and not breaking them IS
     * the characterization baseline.
     *
     * Optional in the strongest sense: when the cutover toggle is closed the
     * composition root does not bind the bus provider at all, so production
     * rollback and those nine specs run the SAME `this.bus === undefined` path.
     * Every publish site therefore reads `this.bus?.publish(...)` through
     * {@link publishDomainEvent}, which additionally swallows a throwing bus so
     * no lifecycle transition, teardown, or slot release can ever be failed by
     * an observer.
     */
    @Optional()
    @Inject(DOMAIN_EVENT_BUS)
    private readonly bus?: DomainEventBusPort,
  ) {
    // collapse-three-collaborator-groups — the two diagnostics collaborators are
    // read ONCE, here, and handed to the lifecycle owner built at the end of
    // this constructor, which performs every begin/resume now that the wrappers
    // are gone. A second read would be a second reference to a budgeted symbol
    // with no second consumer behind it.
    const diagnosticCollaborators = {
      recorder: this.provisioningDiagnosticRecorder,
      writeGate: this.provisioningDiagnosticWriteGate,
    };

    // The semaphore is the durable path's local capacity mirror: durable
    // admission reserves against the database and calls
    // {@link restoreDurableAdmissionSlot} to reflect the reservation here, and
    // every terminal settlement releases through it. It has no queue promotion
    // callback any more — nothing enqueues, because the retired inline pipeline
    // was the only producer of process-local queued admissions.
    this.semaphore = new ConcurrencySemaphore({
      maxConcurrentTasks: config.maxConcurrentTasks,
    });

    // Operator-level idle default (off when null); per-task idleTimeoutMs overrides.
    this.defaultIdleTimeoutMs = config.defaultIdleTimeoutMs;
    const configuredDiagnosticWriteTimeoutMs =
      config.diagnosticWriteTimeoutMs;
    this.diagnosticWriteTimeoutMs =
      configuredDiagnosticWriteTimeoutMs !== undefined &&
      Number.isSafeInteger(configuredDiagnosticWriteTimeoutMs) &&
      configuredDiagnosticWriteTimeoutMs > 0
        ? configuredDiagnosticWriteTimeoutMs
        : TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS;
    // The owner is built from the collaborators read at the top of this
    // constructor, so an instance created POSITIONALLY — with no injector, which
    // is how the frozen out-of-directory specs construct this service — opens
    // and resumes diagnostics from exactly the doubles it was handed. A wired
    // application passes the container-resolved pair through the same two
    // parameters, so there is one construction path rather than a DI path and a
    // test path. The configured write bound travels with them: it is this
    // service's config, and it still bounds the write now that the write lives
    // behind the port.
    this.provisioningDiagnostics =
      new TaskProvisioningDiagnosticsObserverLifecycle({
        ...diagnosticCollaborators,
        writeTimeoutMs: this.diagnosticWriteTimeoutMs,
      });
    const configuredCleanupTerminalPolicyMaxAttempts =
      config.cleanupTerminalPolicyMaxAttempts;
    this.cleanupTerminalPolicyMaxAttempts =
      configuredCleanupTerminalPolicyMaxAttempts !== undefined &&
      Number.isSafeInteger(configuredCleanupTerminalPolicyMaxAttempts) &&
      configuredCleanupTerminalPolicyMaxAttempts > 0
        ? configuredCleanupTerminalPolicyMaxAttempts
        : SANDBOX_CLEANUP_TERMINAL_POLICY_MAX_ATTEMPTS_DEFAULT;

    // force-fail call sites (12.2 / 12.3 / 12.4) all converge on `forceFail`.
    this.deadlines = new DeadlineWatcher({
      onDeadlineExceeded: (taskId) => void this.forceFail(taskId, 'deadline'),
    });
    // Idle ceilings are per-task now (supplied to `idle.start`), so the tracker no
    // longer carries a single process-wide `maxIdleMs`.
    this.idle = new IdleTracker({
      onIdleExceeded: (taskId) => void this.forceFail(taskId, 'idle'),
    });
    this.breaker = new CircuitBreaker({
      threshold: config.circuitBreakerThreshold,
      onTrip: (taskId) => void this.forceFail(taskId, 'circuit_breaker'),
    });
  }

  /**
   * Resolve the task-operations port and the terminal gateway after all providers are
   * instantiated, breaking the construction cycles (see the `tasks`/`gateway`
   * field docs). `strict: false` lets the lookup cross module boundaries to the
   * TasksModule / TerminalModule providers.
   *
   * The gateway is OPTIONAL: when the terminal module is not present (e.g. a
   * guardrails-only unit context) the lookup is swallowed and `gateway` stays
   * undefined, so provisioning still captures the connection handle without
   * opening a session (4.2).
   */
  onModuleInit(): void {
    this.tasks = this.moduleRef.get<TaskOperationsPort>(TASK_OPERATIONS, {
      strict: false,
    });
    try {
      this.gateway = this.moduleRef.get<ITerminalGateway>(TERMINAL_GATEWAY_TOKEN, {
        strict: false,
      });
    } catch {
      // Terminal module not wired in this context — provisioning still captures
      // the connection handle; no terminal session is opened.
      this.gateway = undefined;
    }
    try {
      this.forgeResolver = this.moduleRef.get(ForgeTargetResolver, { strict: false });
      this.forgeRegistry = this.moduleRef.get(DefaultForgeRegistry, { strict: false });
      this.branchResolver = this.moduleRef.get(TaskBranchResolver, { strict: false });
    } catch {
      // Forge module not wired in this context — result delivery is skipped.
      this.forgeResolver = undefined;
      this.forgeRegistry = undefined;
      this.branchResolver = undefined;
    }
    try {
      this.ownedRunnerMinutes = this.moduleRef.get<RunnerMinutesPort>(
        RUNNER_MINUTES_PORT,
        { strict: false },
      );
    } catch {
      // The runner-metrics module is not wired in this context — the member is
      // left unset so the accessor keeps returning the detached fallback, which
      // is a real ledger and goes on accounting for this instance alone.
    }
    try {
      // collapse-three-collaborator-groups — hand the admission state to the
      // projection's OWNER once, at boot, the mirror image of the lookup above.
      // The semaphore is the live read-only reading the projection needs, so the
      // owner re-reads it per projection and `/metrics` still reflects the exact
      // admission state at request time. This service no longer derives, holds,
      // or forwards anything about that projection.
      this.moduleRef
        .get<CapacityProjectionPort>(CAPACITY_PROJECTION_PORT, {
          strict: false,
        })
        .bindSource(this.semaphore);
    } catch {
      // The runner-metrics module is not wired in this context — nothing reads
      // the projection here either, so there is no source to register.
    }
  }

  /**
   * Apply the persisted system-level slot ceiling once the application has
   * bootstrapped (configurable-task-slots). The env value seeded the semaphore
   * at construction; this load lets a previously saved setting win across
   * restarts even when no other bootstrap participant asks for it.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.loadPersistedCeiling();
  }

  /**
   * Runtime pass-through to the semaphore's slot-ceiling setter
   * (configurable-task-slots): the settings save path pushes a validated value
   * here synchronously after its upsert so the new ceiling takes effect without
   * a restart. Raising promotes queued tasks in FIFO order immediately;
   * lowering never evicts running tasks (the count converges as tasks release).
   * A non-positive or non-integer value is rejected by the semaphore (throws)
   * without mutating the ceiling, the running set, or the queue. Env
   * `MAX_CONCURRENT_TASKS` remains only the construction-time seed.
   */
  setMaxConcurrentTasks(maxConcurrentTasks: number): void {
    this.semaphore.setMaxConcurrentTasks(maxConcurrentTasks);
  }

  /**
   * THE publish seam for this service (add-domain-event-bus 4.2).
   *
   * Two guarantees, both load-bearing:
   *  - `this.bus?.` — with no bus bound (cutover closed, or the positional
   *    construction used by the nine out-of-directory specs) this is a no-op
   *    that touches nothing.
   *  - the `try` — the bus contract says `publish` does not throw, but a
   *    lifecycle transition may not depend on an observer keeping its contract.
   *    A throwing bus is logged and swallowed here, so the terminal transition,
   *    the teardown, the runner-minutes close and the slot release all proceed
   *    exactly as they did before this change.
   *
   * Being synchronous and non-throwing is also what makes it safe to call from
   * inside the readoption commit window, which forbids `await` between its final
   * terminal check and the committed restore.
   */
  private publishDomainEvent(event: DomainEvent): void {
    try {
      this.bus?.publish(event);
    } catch (error) {
      this.logger.warn(
        `publishing domain event ${event.type} for task ${event.taskId} failed (lifecycle unaffected): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * THE `SandboxProvisioned` publish (add-domain-event-bus 4.5 / 4.9).
   *
   * There is one provisioning path left, so `admissionMode` is no longer a
   * parameter: it was the discriminator a subscriber used to tell the durable
   * seam from the retired in-request pipeline, and only one of the two can
   * publish. It stays on the payload — the event's schema still carries it —
   * but the value is fixed at the single publish point rather than travelling
   * as an argument that no caller can vary.
   */
  private publishSandboxProvisioned(
    source: SandboxProvisionedEventSource,
  ): void {
    this.publishDomainEvent({
      ...this.domainEventEnvelope('sandbox.provisioned', source.taskId),
      admissionMode: 'durable',
      providerFamily: domainEventProviderFamily(source),
      sandbox: domainEventSandboxReference(source),
      environment: domainEventEnvironmentSnapshot(source),
    });
  }

  /** The envelope every published event carries; `eventId` is fresh per call. */
  private domainEventEnvelope<TType extends DomainEventType>(
    type: TType,
    taskId: string,
  ): { eventId: string; occurredAt: string; type: TType; taskId: string } {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      type,
      taskId,
    };
  }

  /**
   * Load the persisted system-level ceiling — the single `SystemSettings` row —
   * into the live semaphore, AFTER the env construction seed, so the effective
   * ceiling resolves as `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5` and the
   * persisted value wins across restarts (configurable-task-slots).
   *
   * Called from {@link onApplicationBootstrap} here AND awaited by the tasks
   * startup recovery BEFORE it re-offers DB `queued` tasks (ceiling-first
   * ordering, so re-offer admits against the persisted ceiling rather than the
   * env seed). Idempotent — the double call is harmless. Returns the effective
   * ceiling after the load; degrades to the current (env-seeded) ceiling when
   * no row exists, no prisma client is wired, the stored value is invalid, or
   * the read fails — bootstrap must never crash on a missing/unreadable row.
   */
  async loadPersistedCeiling(): Promise<number> {
    if (!this.prisma) {
      return this.semaphore.maxConcurrentTasks;
    }
    try {
      const row = await this.prisma.systemSettings.findFirst();
      const persisted = row?.maxConcurrentTasks;
      // Defensive validity guard (contracts constrain writes to 1–20 already):
      // an invalid stored value is ignored rather than thrown by the setter.
      if (isValidMaxConcurrentTasks(persisted)) {
        this.semaphore.setMaxConcurrentTasks(persisted);
        this.logger.log(`slot ceiling loaded from system settings: ${persisted}`);
      }
    } catch (err) {
      this.logger.warn(
        `loading persisted slot ceiling failed (keeping ceiling ${
          this.semaphore.maxConcurrentTasks
        }): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.semaphore.maxConcurrentTasks;
  }

  /**
   * Durable admission path — the ONLY admission path. Capacity is linearized by
   * TasksService against the shared database and mirrored into the local
   * semaphore; nothing enters a process-local queue any more.
   */
  processDurableAdmission(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionProcessResult> {
    const existing = this.durableAdmissionsByClaim.get(context.claim);
    if (existing) return existing;
    const processing = this.processDurableAdmissionOnce(context);
    this.durableAdmissionsByClaim.set(context.claim, processing);
    return processing;
  }

  private async processDurableAdmissionOnce(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionProcessResult> {
    const { claim, lease } = context;
    const taskId = claim.taskId;
    if (
      claim.sourceState === 'succeeded' ||
      claim.taskStatus === 'completed' ||
      claim.taskStatus === 'failed' ||
      claim.taskStatus === 'cancelled' ||
      claim.taskStatus === 'agent_failed_to_start'
    ) {
      // Succeeded Work is reopened only for recoverTerminal. Guard against a
      // misbound processor or forged in-memory context before capacity,
      // diagnostics, or a provider boundary can be touched.
      throw new TaskAdmissionLeaseLostError(taskId);
    }
    await lease.authorize();

    let fence = lease.currentTaskFence();
    if (fence.status === 'pending' || fence.status === 'queued') {
      const targets =
        fence.status === 'pending'
          ? (['queued', 'running'] as const)
          : (['running'] as const);
      lease.beginTaskTransition(targets);
      let reservation;
      try {
        reservation = await this.tasks.reserveDurableAdmissionCapacity({
          taskId,
          leaseToken: claim.leaseToken,
          expectedStatus: fence.status,
          expectedLifecycleVersion: fence.lifecycleVersion,
          fallbackMaxConcurrentTasks: this.semaphore.maxConcurrentTasks,
          transitionToken: randomUUID(),
        });
      } catch (error) {
        lease.rollbackTaskTransition();
        throw error;
      }
      if (reservation.outcome === 'superseded') {
        lease.rollbackTaskTransition();
        throw new TaskAdmissionLeaseLostError(taskId);
      }
      if (reservation.outcome === 'running') {
        // The reservation transaction has already committed the durable slot.
        // Mirror it before the next lease await so the local ceiling matches
        // the database's decision across a lease-loss/crash window.
        this.restoreDurableAdmissionSlot(taskId);
      }
      if (reservation.transitioned) {
        lease.commitTaskTransition({
          status: reservation.status,
          lifecycleVersion: reservation.lifecycleVersion,
        });
      } else {
        lease.rollbackTaskTransition();
      }
      await lease.authorize();
      fence = lease.currentTaskFence();
      if (reservation.outcome === 'queued') {
        return { kind: 'queued', stage: claim.stage };
      }
    }

    if (fence.status !== 'running' && fence.status !== 'awaiting_input') {
      throw new TaskAdmissionLeaseLostError(taskId);
    }

    // The DB transaction above is the durable capacity authority. Mirror its
    // running winner into the process-local semaphore, which is this replica's
    // view of that authority. restoreRunning is idempotent.
    this.restoreDurableAdmissionSlot(taskId);

    const interruptsPreviousDiagnostic =
      claim.sourceState === 'running' || claim.sourceState === 'retrying';
    const diagnosticBeginInput: BeginTaskProvisioningDiagnosticObserverInput =
      claim.sourceState === 'retrying'
        ? {
            taskId,
            admissionMode: 'durable',
            expectedAttempt: claim.attempt,
            activeDisposition: 'interrupt',
            retry: {
              stage: claim.stage,
              cause: taskProvisioningDiagnosticCauseFromFailureCode(
                claim.causeCode,
              ),
            },
          }
        : {
            taskId,
            admissionMode: 'durable',
            expectedAttempt: claim.attempt,
            ...(interruptsPreviousDiagnostic
              ? { activeDisposition: 'interrupt' as const }
              : {}),
          };
    // A parked resume continues the SAME diagnostic attempt it parked under
    // (spec: a park/resume cycle within one transfer appears within one
    // diagnostic attempt): resume the persisted attempt instead of beginning
    // one, which would conflict with the attempt left active while parked.
    const diagnosticAttempt =
      claim.sourceState === 'parked'
        ? await this.provisioningDiagnostics.tryResume({
            taskId,
            admissionMode: 'durable',
            attempt: claim.attempt,
          })
        : await this.beginProvisioningDiagnostics(diagnosticBeginInput);
    const processRunning = () =>
      this.processDurableAdmissionAfterCapacity(context, diagnosticAttempt);
    return diagnosticAttempt
      ? runWithTaskProvisioningAttemptLog(
          diagnosticAttempt.context,
          processRunning,
        )
      : processRunning();
  }

  /** Continue only after durable capacity and the current task fence are proven. */
  private async processDurableAdmissionAfterCapacity(
    context: TaskAdmissionProcessorContext,
    diagnosticAttempt?: BegunTaskProvisioningDiagnosticObserver,
  ): Promise<TaskAdmissionProcessResult> {
    const { claim, lease, signal } = context;
    const taskId = claim.taskId;
    await this.armDurableRuntime(taskId, lease);
    const sandbox = this.sandbox;
    if (!sandbox) {
      await this.settleProvisioningDiagnostics(diagnosticAttempt, {
        state: 'failed',
        stage: 'provider_selection',
        operation: 'provider_select',
        outcome: 'failed',
        cause: 'provider_unavailable',
        retryable: false,
        exitCode: null,
        completion: 'mark_if_complete',
      });
      throw new TaskAdmissionProcessingError(
        'provisioning_unknown',
        claim.stage,
        false,
      );
    }

    let providerBoundaryCrossed = false;
    let providerSelectionFailed = false;
    // add-repo-content-store: the resolved workspace-source variant is ambient
    // evidence the failure classifier cannot recover from an error value, so it
    // is retained here for the catch below. Never provisioning authority.
    let workspaceSourceKind: WorkspaceSource['kind'] | undefined;
    try {
      await lease.checkpoint('sandbox_creation');
      await lease.authorize();
      // detach-workspace-clone D4: a claim resuming work behind an existing
      // live SandboxRun (parked-transfer resume or expired-lease re-claim)
      // must win the atomic conditional ownership re-stamp at this reclaim
      // checkpoint boundary — where the durable checkpoint write above has
      // just fenced any superseded lease token — before any provider boundary
      // is crossed. A stale waker fails the compare and self-terminates.
      await this.restampSandboxOwnershipAtReclaim(taskId, claim.leaseToken);
      const provisionPlan = await this.resolveProvisionPlan(taskId);
      await lease.authorize();
      this.assertDurableClaimMatchesProvisionPlan(claim, provisionPlan);

      const selected = (() => {
        try {
          return selectSandboxProvider(
            sandbox,
            provisionPlan.requiredCapabilities,
          );
        } catch (error) {
          // Some provider composites still surface capability assertion failures
          // as a generic Error. Preserve that original value for the existing
          // admission classifier while retaining the known diagnostic boundary.
          providerSelectionFailed = true;
          throw error;
        }
      })();
      await lease.authorize();
      // add-repo-content-store: the workspace origin is selected from the
      // SELECTED provider's declared capabilities, so it must be resolved after
      // selection and before the provision boundary.
      const workspaceSource = await this.resolveWorkspaceSource(
        taskId,
        provisionPlan,
        selected.capabilities,
      );
      workspaceSourceKind = workspaceSource?.kind;
      await lease.authorize();
      const provisionContext = snapshotSandboxProvisionContext({
        taskId,
        ...(diagnosticAttempt === undefined
          ? {}
          : { diagnostics: diagnosticAttempt.diagnostics }),
        cloneSpec: provisionPlan.cloneSpec,
        ...(workspaceSource === undefined ? {} : { workspaceSource }),
        modelIntent: provisionPlan.modelIntent,
        runtimeId: provisionPlan.runtimeId,
        executionMode: provisionPlan.executionMode,
        environment: provisionPlan.environment,
        resources: provisionPlan.resources,
        workspace: provisionPlan.workspace,
        ownership: Object.freeze({
          ownerGeneration: claim.leaseToken,
          resourceGeneration: randomUUID(),
        }),
        cancellationSignal: signal,
        externalBoundaryGuard: async () => lease.authorize(),
        beforeProvisioningBoundary: (event) => lease.checkpoint(event.stage),
        onProvisioningProgress: (event) => {
          // Provider-composite phases have different physical ordering. They
          // are audit-only hints; monotonic durable checkpoints remain owned
          // by the admission worker and are written after provision returns.
          void this.recordAudit(() =>
            this.audit?.recordProvisioningProgress(
              taskId,
              event.stage,
              claim.attempt,
            ),
          );
        },
        onWorkspaceProgress: this.buildWorkspaceProgressChain({
          // detach-workspace-clone D11: the shared progress chain. The durable
          // checkpoint hook is the only load-bearing step; a rejected
          // checkpoint write fences a superseded holder at the write point and
          // must propagate.
          checkpoint: (stage) => lease.checkpoint(stage),
          transferProgress: createThrottledTransferProgressWriter({
            write: (stage, progress) => lease.transferProgress(stage, progress),
          }),
          forward: provisionPlan.onWorkspaceProgress,
        }),
        beforeWorkspaceBoundary: async (event) => {
          if (event.position === 'before') {
            await lease.checkpoint(event.stage);
          } else {
            await lease.authorize();
          }
        },
        // detach-workspace-clone D3/D9: opt the durable chain into
        // cooperative parking. A detaching transfer unwinds provision with
        // the typed signal caught below; a parked resume additionally routes
        // marker evidence through the claim-path-owned three-way triage
        // before any relaunch.
        workspaceTransferDetachment:
          this.buildWorkspaceTransferDetachment(claim),
      });
      providerBoundaryCrossed = true;
      const connection = await selected.provider.provision(provisionContext);
      const selectedRun = await this.resolveSelectedRunStrict(taskId);
      if (
        !selectedRun?.owner?.ownership ||
        selectedRun.owner.ownership.ownerGeneration !== claim.leaseToken
      ) {
        throw new TaskAdmissionLeaseLostError(taskId);
      }
      await lease.authorize();

      // Providers execute readiness/runtime setup in different physical orders.
      // A successful composite provision proves both completed, so project them
      // only now in the stable provider-neutral order without regressing a
      // workspace checkpoint.
      await lease.checkpoint('runtime_setup');
      await lease.authorize();
      await lease.checkpoint('readiness');
      await lease.authorize();

      this.connections.set(taskId, connection);
      // Durable `SandboxProvisioned` (add-domain-event-bus 4.5), 1 of the 2
      // provisioning paths. Ordering is the requirement, not an accident: it is
      // published only after `provision(...)` returned, after the ownership
      // re-verification above proved this attempt still holds the fence, and
      // after the connection was registered. A provision that throws, is
      // cancelled, unwinds for a detaching transfer, or loses that re-check
      // never reaches this line, so those attempts publish nothing.
      //
      // Every value comes from what this seam ALREADY holds — the provision plan
      // it just built and the selected run it just re-read. No new provider call,
      // no new database read, no new resolver.
      this.publishSandboxProvisioned({
        taskId,
        connection,
        selectedRun,
        plan: provisionPlan,
      });
      await lease.checkpoint('agent_launch');
      await lease.authorize();
      const gateway = this.gateway;
      if (!gateway) {
        throw new TaskAdmissionProcessingError(
          'provisioning_unknown',
          'agent_launch',
          false,
        );
      }
      const session = gateway.openSession(connection, selectedRun, {
        signal,
        beforeAgentLaunch: () => lease.authorize(),
      });
      const launchDecision = await session.launchDecision;
      if (launchDecision.kind === 'fenced') {
        throw new TaskAdmissionLeaseLostError(taskId);
      }
      if (
        launchDecision.kind !== 'launched' &&
        launchDecision.kind !== 'attached'
      ) {
        throw new TaskAdmissionProcessingError(
          'provisioning_unknown',
          'agent_launch',
          false,
        );
      }
      await lease.authorize();
      await lease.checkpoint('complete');
      await this.settleProvisioningDiagnostics(diagnosticAttempt, {
        state: 'succeeded',
        stage: 'agent_launch',
        operation: 'agent_launch',
        commandKind: 'agent_launch',
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        exitCode: null,
        completion: 'leave_partial',
      });
      return { kind: 'succeeded' };
    } catch (error) {
      // detach-workspace-clone D3: a detaching workspace transfer is a typed
      // control-flow signal, not a failure. The sandbox and its detached
      // clone job survive; the worker settles this claim as `parked`
      // (releasing its maxInFlight slot) and registers the probe/kill seam
      // with the lightweight parked observer loop. The diagnostic attempt is
      // deliberately left open: the park/resume cycle continues it, and the
      // durable store's park CAS remains the sole authority on whether this
      // worker still held the lease.
      if (isSandboxWorkspaceTransferDetachedSignal(error)) {
        return {
          kind: 'parked',
          stage: 'workspace_transfer',
          job: wrapDetachedWorkspaceTransferJob(error.job),
        };
      }
      // A DB/lease acknowledgement failure aborts the worker signal as well,
      // but it is not proof that ownership was superseded. Preserve the live
      // resource for expiry replay instead of deleting it as lease-lost work.
      if (error instanceof TaskAdmissionCoordinationError) throw error;
      if (isCleanupCoordinationPending(error)) {
        const primary = sandboxCleanupCoordinationPrimary(error);
        // Provider cleanup may wrap the lease/coordination exception raised by
        // an external boundary guard. That value is orchestration authority,
        // not a provisioning outcome. Likewise an aborted worker no longer has
        // authority to project a competing ordinary primary.
        if (
          primary !== undefined &&
          !signal.aborted &&
          !isTaskAdmissionControlSignal(primary)
        ) {
          await this.settleProvisioningDiagnostics(diagnosticAttempt, {
            ...classifyTaskProvisioningDiagnosticPrimaryFailure(
              primary,
              claim.stage,
              { ...(workspaceSourceKind === undefined ? {} : { workspaceSourceKind }) },
            ),
            completion: 'leave_partial',
          });
        }
        throw new TaskAdmissionCoordinationError(
          'checkpoint',
          taskId,
          error,
        );
      }
      if (
        signal.aborted ||
        error instanceof TaskAdmissionLeaseLostError
      ) {
        // Lost lease authority cannot distinguish an operator terminal CAS from
        // a replay owner transfer without another race-prone read. Never cross
        // a physical cleanup boundary here: terminal recovery is audit-first,
        // while a nonterminal successor reuses/readopts the persisted owner.
        throw new TaskAdmissionLeaseLostError(taskId);
      }
      const classified = classifyDurableAdmissionError(error, claim.stage);
      await this.settleProvisioningDiagnostics(diagnosticAttempt, {
        ...(providerSelectionFailed
          ? {
              state: 'failed' as const,
              stage: 'provider_selection' as const,
              operation: 'provider_select' as const,
              outcome: 'failed' as const,
              cause: 'provider_unavailable' as const,
              retryable: false,
              exitCode: null,
            }
          : classifyTaskProvisioningDiagnosticPrimaryFailure(
              error,
              classified.stage,
              { ...(workspaceSourceKind === undefined ? {} : { workspaceSourceKind }) },
            )),
        completion: providerBoundaryCrossed
          ? 'leave_partial'
          : 'mark_if_complete',
      });
      throw classified;
    }
  }

  async settleDurableAdmissionFailure(
    context: TaskAdmissionProcessorContext,
    failure: TaskAdmissionTerminalFailure,
  ): Promise<boolean> {
    const fence = context.lease.currentTaskFence();
    if (
      fence.status !== 'pending' &&
      fence.status !== 'queued' &&
      fence.status !== 'running' &&
      fence.status !== 'awaiting_input'
    ) {
      return false;
    }
    return this.tasks.settleDurableAdmissionFailure({
      taskId: context.claim.taskId,
      leaseToken: context.claim.leaseToken,
      attempt: context.claim.attempt,
      expectedStatus: fence.status,
      expectedLifecycleVersion: fence.lifecycleVersion,
      stage: failure.stage,
      causeCode: failure.causeCode,
    });
  }

  recoverDurableTerminalAdmission(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery> {
    const existing = this.durableTerminalRecoveriesByClaim.get(context.claim);
    if (existing) return existing;
    const recovery = this.recoverDurableTerminalAdmissionOnce(context);
    this.durableTerminalRecoveriesByClaim.set(context.claim, recovery);
    return recovery;
  }

  private async recoverDurableTerminalAdmissionOnce(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery> {
    await context.lease.authorize();
    const task = await this.requireTerminalTaskSnapshot(context);
    const taskId = context.claim.taskId;

    const diagnosticAttempt = await this.provisioningDiagnostics.tryResume({
      taskId,
      admissionMode: 'durable',
      attempt: context.claim.attempt,
    });
    const recoverTerminal = () =>
      this.recoverDurableTerminalAdmissionWithTask(
        context,
        task,
        diagnosticAttempt,
      );
    return diagnosticAttempt
      ? runWithTaskProvisioningAttemptLog(
          diagnosticAttempt.context,
          recoverTerminal,
        )
      : recoverTerminal();
  }

  private async recoverDurableTerminalAdmissionWithTask(
    context: TaskAdmissionProcessorContext,
    task: DurableTerminalTaskSnapshot,
    diagnosticAttempt?: ResumedTaskProvisioningDiagnosticObserver,
  ): Promise<TaskAdmissionTerminalRecovery> {
    const taskId = context.claim.taskId;

    if (task.status === 'cancelled') {
      await this.requireTaskCancellationAudit(taskId);
      await this.continueDurableTerminalCleanup(
        context,
        diagnosticAttempt,
        {
          disposition: 'superseded-remove',
          sessionReason: 'failed',
          captureTranscript: true,
        },
      );
      await context.lease.authorize();
      return { state: 'cancelled', stage: context.claim.stage };
    }

    if (task.status === 'completed') {
      await this.continueDurableTerminalCleanup(
        context,
        diagnosticAttempt,
        {
          disposition: 'terminal-retain',
          sessionReason: 'completed',
          captureTranscript: true,
          deliverWorkspace: true,
        },
      );
      await context.lease.authorize();
      return context.claim.stage === 'complete'
        ? { state: 'succeeded', stage: 'complete' }
        : { state: 'cancelled', stage: context.claim.stage };
    }

    if (task.status === 'agent_failed_to_start') {
      await this.continueDurableTerminalCleanup(
        context,
        diagnosticAttempt,
        {
          disposition: 'terminal-retain',
          sessionReason: 'failed',
          captureTranscript: true,
        },
      );
      await context.lease.authorize();
      return {
        state: 'failed',
        stage:
          context.claim.stage === 'complete'
            ? 'complete'
            : 'agent_launch',
        causeCode: 'provisioning_unknown',
      };
    }

    const failed = this.classifyRecoveredFailedAdmission(
      context.claim.causeCode,
      task.failureCode,
      taskId,
    );
    if (failed.kind === 'provisioning') {
      const failure = taskFailureFromRecord({
        failureCode: failed.causeCode,
        failureAt: new Date(),
        failureExitCode: null,
      });
      if (!failure || 'runtime' in failure) {
        throw new TaskAdmissionCoordinationError(
          'checkpoint',
          taskId,
          new Error('terminal provisioning failure classification is invalid'),
        );
      }
      await this.requireProvisioningFailureAudit(
        taskId,
        context.claim.stage,
        context.claim.attempt,
        failure,
      );
      await this.continueDurableTerminalCleanup(
        context,
        diagnosticAttempt,
      );
      await context.lease.authorize();
      return {
        state: 'failed',
        stage: context.claim.stage,
        causeCode: failed.causeCode,
      };
    }

    await this.continueDurableTerminalCleanup(
      context,
      diagnosticAttempt,
      {
        disposition: 'terminal-retain',
        sessionReason: 'failed',
        captureTranscript: true,
      },
    );
    await context.lease.authorize();
    if (failed.kind === 'runtime' && context.claim.stage === 'complete') {
      return { state: 'succeeded', stage: 'complete' };
    }
    return context.claim.stage === 'complete'
      ? { state: 'succeeded', stage: 'complete' }
      : {
          state: 'cancelled',
          stage: context.claim.stage,
        };
  }

  /**
   * Preserve the historical two-argument cleanup call when diagnostics are
   * unavailable. Recovery may only attach an exact resumed attempt; it never
   * allocates replacement evidence or replays primary provisioning.
   */
  private async continueDurableTerminalCleanup(
    context: TaskAdmissionProcessorContext,
    diagnosticAttempt?: ResumedTaskProvisioningDiagnosticObserver,
    options?: DurableTerminalCleanupOptions,
  ): Promise<void> {
    // The best-effort diagnostic read may have consumed most of a lease
    // interval. Re-prove DB authority immediately before claiming physical
    // cleanup ownership so diagnostics never widen the external boundary.
    await context.lease.authorize();
    const taskId = context.claim.taskId;
    const ownerGeneration = context.claim.leaseToken;
    try {
      if (!diagnosticAttempt) {
        if (options === undefined) {
          await this.onDurableAdmissionTerminal(taskId, ownerGeneration);
        } else {
          await this.onDurableAdmissionTerminal(
            taskId,
            ownerGeneration,
            options,
          );
        }
        return;
      }
      await this.onDurableAdmissionTerminal(taskId, ownerGeneration, {
        ...(options ?? {}),
        diagnostics: diagnosticAttempt.diagnostics,
        diagnosticSettlement: diagnosticAttempt.settlement,
      });
    } catch (error) {
      // A terminal Task cannot enter the ordinary processing-failure path: its
      // exact SandboxRun still owns capacity until the canonical cleanup state
      // settles. Keep the work lease recoverable whether this was a physical
      // pending result or an ownership/database acknowledgement failure.
      if (error instanceof TaskAdmissionCoordinationError) throw error;
      throw new TaskAdmissionCoordinationError('checkpoint', taskId, error);
    }
  }

  /**
   * RE-ADOPT a task whose sandbox + detached codex session survived an api
   * restart (survive-api-redeploy, guardrails-recovery 4.1). Called by the tasks
   * bootstrap recovery PHASE 0 for every provider-re-adopted taskId, BEFORE the
   * reclaim phase and the queued re-offer, so a still-running task keeps its slot
   * and timers across a redeploy rather than being force-failed.
   *
   * Unlike {@link admit} / {@link startRunning} this performs NO lifecycle
   * transition (the task is KEPT in its current `running`/`awaiting_input` state
   * by the caller) and NO fresh `provision()` (the sandbox already exists — the
   * provider has re-registered its own tracking and supplies the still-valid
   * {@link SandboxConnection} handle here). It:
   *
   *  - restores the task into the semaphore running set without consulting the
   *    current ceiling. Every provider-confirmed survivor is preserved even if
   *    the operator lowered the persisted ceiling while the API was offline;
   *    releases later converge naturally before FIFO admission resumes.
   *  - captures the connection handle (so terminal reconnect / teardown find it)
   *    and hands it to the terminal gateway in attach-only mode. The gateway
   *    must attest an existing named session; absence is returned distinctly,
   *    and an indeterminate probe fails bootstrap closed rather than launching.
   *  - re-arms the idle tracker (when an effective ceiling exists) and the
   *    deadline watcher from the PERSISTED `deadlineMs`/`idleTimeoutMs`, identical
   *    to a task admitted before the restart, and re-opens the runner-minutes
   *    interval so the derived accounting resumes.
   */
  async readopt(
    taskId: string,
    connection: SandboxConnection,
    params: GuardrailParams = {},
    selectedRun?: SelectedSandboxRun | null,
    options: GuardrailsReadoptOptions = {},
  ): Promise<GuardrailsReadoptResult> {
    const existing = this.readoptionsInFlight.get(taskId);
    if (existing) return existing;

    // Defer the actual attach by one microtask so the in-flight marker is
    // installed before any terminal callback can observe this attempt.
    const readoption = Promise.resolve().then(() =>
      this.readoptUntracked(taskId, connection, params, selectedRun, options),
    );
    this.readoptionsInFlight.set(taskId, readoption);
    try {
      return await readoption;
    } finally {
      if (this.readoptionsInFlight.get(taskId) === readoption) {
        this.readoptionsInFlight.delete(taskId);
      }
      this.releaseTerminalFenceIfIdle(taskId);
    }
  }

  private async readoptUntracked(
    taskId: string,
    connection: SandboxConnection,
    params: GuardrailParams,
    selectedRun: SelectedSandboxRun | null | undefined,
    options: GuardrailsReadoptOptions,
  ): Promise<GuardrailsReadoptResult> {
    if (this.terminalTasks.has(taskId)) {
      return 'superseded';
    }

    const gateway = this.gateway;
    if (!gateway) {
      throw new Error(
        `re-adopting task ${taskId} is indeterminate: terminal gateway is unavailable`,
      );
    }

    let session: ReturnType<ITerminalGateway['openSession']>;
    try {
      session = gateway.openSession(connection, selectedRun, {
        mode: 'attach-only',
      });
    } catch (error) {
      gateway.unregisterSession(taskId);
      throw error;
    }

    let launchDecision: AgentTerminalLaunchOutcome;
    try {
      launchDecision = await session.launchDecision;
    } catch (error) {
      gateway.unregisterSession(taskId);
      if (this.terminalTasks.has(taskId)) {
        return 'superseded';
      }
      throw error;
    }

    if (this.terminalTasks.has(taskId)) {
      gateway.unregisterSession(taskId);
      return 'superseded';
    }
    if (launchDecision.kind === 'absent') {
      gateway.unregisterSession(taskId);
      return 'absent';
    }
    if (launchDecision.kind !== 'attached') {
      gateway.unregisterSession(taskId);
      throw new Error(
        `re-adopting task ${taskId} is indeterminate: attach-only terminal decision was ${launchDecision.kind}`,
      );
    }

    try {
      if (this.terminalTasks.has(taskId)) {
        gateway.unregisterSession(taskId);
        return 'superseded';
      }
      if (options.beforeCommit && !(await options.beforeCommit())) {
        gateway.unregisterSession(taskId);
        return 'superseded';
      }
      // No await is permitted after this final terminal check and before all
      // process-local restore state is committed. A racing terminal transition
      // either owns the fence before this point or runs afterwards and clears
      // the just-restored state through the ordinary terminal path.
      if (this.terminalTasks.has(taskId)) {
        gateway.unregisterSession(taskId);
        return 'superseded';
      }

      if (options.beforeCommit) {
        this.readoptionAuthorityChecks.set(taskId, options.beforeCommit);
      }
      const idleMs =
        params.idleTimeoutMs ?? this.defaultIdleTimeoutMs ?? undefined;
      if (idleMs !== undefined) {
        this.idle.start(taskId, idleMs);
      }
      if (params.deadlineMs !== undefined) {
        this.deadlines.armAfter(taskId, params.deadlineMs);
      }
      this.connections.set(taskId, connection);
      this.runnerMinutes.recordStart(taskId);
      // Run-start publish point 1 of 3 (add-domain-event-bus 4.3). Adjacent to
      // the recordStart above, which is neither replaced nor moved. NO
      // `admissionMode`: readoption restores a run after a restart and genuinely
      // does not know which admission path originally admitted it — `startPoint`
      // already says where this run start came from, and guessing the mode would
      // be fabricated data. Synchronous and non-throwing, so it does not violate
      // the no-await rule this commit window runs under.
      this.publishDomainEvent({
        ...this.domainEventEnvelope('task.run_started', taskId),
        startPoint: 'readoption',
      });
      // Recovery accounting intentionally ignores a lowered ceiling and never
      // fires the fresh-admission callback.
      this.semaphore.restoreRunning(taskId);
    } catch (error) {
      this.idle.stop(taskId);
      this.deadlines.clear(taskId);
      this.connections.delete(taskId);
      if (this.readoptionAuthorityChecks.get(taskId) === options.beforeCommit) {
        this.readoptionAuthorityChecks.delete(taskId);
      }
      gateway.unregisterSession(taskId);
      throw error;
    }

    this.logger.log(
      `re-adopted running task ${taskId} (slot restored, attach proven, timers re-armed)`,
    );
    return 'attached';
  }

  /** Record terminal output or a hook event — resets the idle window (12.3). */
  recordActivity(taskId: string): void {
    this.idle.recordActivity(taskId);
  }

  /** Record a start/turn failure for the circuit breaker (12.4). */
  recordFailure(taskId: string, kind: FailureKind = 'agent_failed_to_start'): void {
    this.breaker.recordFailure(taskId, kind);
  }

  /** Record a successful start/turn, resetting the breaker's counter (12.4). */
  recordSuccess(taskId: string): void {
    this.breaker.recordSuccess(taskId);
  }

  /**
   * Map a resolved sandbox exit status to the guardrail outcome (4.3). Under the
   * connect-in model there is no `node-pty` `onExit`: the `AioPtyClient` detects
   * termination by the terminal WS close and resolves the exit status via the
   * sandbox `exec`/`wait` surfaces, then the terminal gateway hands it here.
   *
   * A ZERO exit code maps to {@link recordSuccess}; a NON-ZERO code, an
   * unresolved code (`null`), or an `abnormal` termination (the WS closed before
   * the session was established) maps to {@link recordFailure}. `onTerminal` /
   * `forceFail` / `teardownSandbox` are unaffected — this only resolves the
   * start/turn circuit-breaker outcome from the remote exit signal.
   */
  recordExit(taskId: string, status: ExitStatus): void {
    // structured-logging: bind taskId to the log context for this exit and the
    // fire-and-forget detail/transition calls it spawns (they capture the ALS
    // context), so the ddba-style exit-handling logs all carry `taskId`.
    runWithTaskLog(taskId, () => {
      if (this.terminalTasks.has(taskId)) return;
      if (!status.abnormal && status.code === 0) {
        // Clean exit: the agent finished. Reset the breaker AND drive the task to a
        // terminal `completed` state — under the connect-in model a clean WS-close
        // is a single terminal event with no re-launch, so `completed` (via
        // `TasksService.transition` → `isTerminal` → `onTerminal`) tears down the
        // sandbox/session and frees the slot. Without this the task would linger
        // `running`, leaking its slot until idle reclamation or a restart — a
        // permanent leak once idle reclamation is off by default.
        this.recordSuccess(taskId);
        void this.safeTransition(taskId, 'completed');
      } else if (status.abnormal) {
        this.recordFailure(taskId);
        // Abnormal exit: the sandbox died unexpectedly (WS closed before the session
        // was established, container killed, OOM, or an unresolvable exit code). A
        // dead sandbox cannot recover, so force-fail the task now to release its
        // concurrency slot and admit the next queued task. `safeTransition` and
        // `semaphore.release` tolerate double-calls, so this is safe even when a
        // teardown was already triggered for the same task.
        // record-task-failure-reason: capture the exit code + transcript tail
        // BEFORE teardown so an abnormal failure is diagnosable (best-effort).
        void this.settleFailedRuntimeExit(taskId, status, true);
      } else {
        // Non-zero clean exit: a single connect-in exit is terminal (no re-launch),
        // so this task is done regardless of any breaker threshold. Record the
        // failure for the breaker/audit AND transition to `failed` so the slot is
        // freed on THIS exit rather than waiting for a consecutive-failure threshold
        // that can never accumulate for a one-shot terminal exit.
        this.recordFailure(taskId);
        // record-task-failure-reason: capture the non-zero exit code + transcript
        // tail into the `task.exited` detail event (best-effort), alongside the
        // central generic `task.failed` transition below.
        void this.settleFailedRuntimeExit(taskId, status, false);
      }
    });
  }

  /**
   * Fail a task immediately when its selected runtime reports a definitive auth
   * problem. The task service writes status + cause atomically; its terminal
   * settlement hook owns transcript capture, sandbox teardown, and slot release.
   */
  async failRuntime(
    taskId: string,
    code: ImmediateRuntimeFailureCode,
    exitCode: number | null = null,
    recordBreakerFailure = true,
  ): Promise<boolean> {
    return this.persistRuntimeFailure(
      taskId,
      code,
      exitCode,
      recordBreakerFailure,
    );
  }

  /**
   * The only runtime path that may persist `runtime_model_rejected`. Unknown,
   * unpinned, generic, or presentation-text evidence is ignored rather than
   * stealing the existing auth/network/quota/generic classification.
   */
  async failRuntimeModelRejection(
    taskId: string,
    evidence: RuntimeModelRejectionEvidence,
    exitCode: number | null = null,
    recordBreakerFailure = true,
  ): Promise<boolean> {
    const code = classifyRuntimeModelRejectionEvidence(evidence);
    if (!code) return false;
    return this.persistRuntimeFailure(
      taskId,
      code,
      exitCode,
      recordBreakerFailure,
    );
  }

  private async persistRuntimeFailure(
    taskId: string,
    code: RuntimeTaskFailureCode,
    exitCode: number | null,
    recordBreakerFailure: boolean,
  ): Promise<boolean> {
    if (recordBreakerFailure) this.recordFailure(taskId, 'turn_failure');
    try {
      await this.tasks.failWithRuntimeFailure(taskId, code, exitCode);
      this.clearReadoptionAfterTerminalObservation(taskId);
      return true;
    } catch (err) {
      this.logger.debug(
        `runtime failure transition for task ${taskId} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private async settleFailedRuntimeExit(
    taskId: string,
    status: ExitStatus,
    abnormal: boolean,
  ): Promise<void> {
    let failure: RuntimeOutputFailure | null = null;
    const detail = this.recordExitDetail(taskId, status);
    try {
      failure = await this.withTimeout(
        detail,
        EXIT_FAILURE_CLASSIFICATION_TIMEOUT_MS,
        'runtime failure classification',
      );
    } catch {
      this.logger.debug(
        `exit-detail classification for task ${taskId} timed out/skipped (details redacted)`,
      );
      // Do not keep lifecycle settlement waiting after the bound, but retain the
      // late result. TasksService can CAS-enrich a generic failed winner without
      // repeating teardown or transition audit.
      void detail
        .then(async (lateFailure) => {
          if (!lateFailure) return;
          await this.tasks.failWithRuntimeFailure(
            taskId,
            lateFailure.code,
            status.code,
          );
          this.clearReadoptionAfterTerminalObservation(taskId);
        })
        .catch(() => {
          this.logger.debug(
            `late runtime failure enrichment for task ${taskId} skipped (details redacted)`,
          );
        });
    }
    if (
      failure &&
      (await this.failRuntime(taskId, failure.code, status.code, false))
    ) {
      return;
    }
    if (abnormal) {
      await this.forceFail(taskId, 'abnormal_exit');
    } else {
      await this.safeTransition(taskId, 'failed');
    }
  }

  /**
   * Emit the `task.exited` failure-detail audit (exit code + mapped reason +
   * sampled transcript tail) for a non-success exit (record-task-failure-reason).
   * Fire-and-forget + best-effort: it reads the Gateway's bounded owner-output
   * evidence and records a DETAIL event ALONGSIDE the central `task.failed`
   * transition. Full raw terminal recording may be disabled. ANY failure is
   * swallowed so it can never affect lifecycle, teardown, or slot release.
   */
  private async recordExitDetail(
    taskId: string,
    status: ExitStatus,
  ): Promise<RuntimeOutputFailure | null> {
    let tail = '';
    try {
      tail = (await this.gateway?.readSessionLogTail(taskId)) ?? '';
    } catch {
      this.logger.debug(
        `exit-detail tail for task ${taskId} unavailable (details redacted)`,
      );
    }
    let failure: RuntimeOutputFailure | null = null;
    try {
      failure = await this.tasks.classifyRuntimeOutputFailure(taskId, tail);
    } catch {
      this.logger.debug(
        `runtime failure classification for task ${taskId} skipped (details redacted)`,
      );
    }
    if (this.audit) {
      // Diagnostic persistence is best-effort and must never delay the failed
      // transition, sandbox teardown, or admission-slot release.
      void this.recordAudit(() =>
        this.audit?.recordExited(taskId, status.code, status.abnormal, tail),
      );
    }
    return failure;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Best-effort durable transcript capture invoked at BOTH terminal chokepoints
   * (`onTerminal` 3.2 / `forceFail` 3.3) BEFORE the stop-only `teardownSandbox`,
   * while the container is still present (persist-session-transcripts).
   *
   * The injected service is best-effort by contract (it logs and swallows its
   * own errors, returning a status flag rather than throwing). This wrapper is a
   * defensive SECOND layer: it is awaited so the archive write ordering before
   * the stop holds, but ANY surprise throw / rejection is caught and logged, so
   * the terminal transition, stop-only teardown, and slot release proceed
   * unconditionally. When no capture provider is composed the injected
   * implementation is the no-op stand-in, which captures nothing — so there is
   * no presence to test here and the AWAIT below is unconditional.
   */
  private async captureTranscript(taskId: string): Promise<void> {
    try {
      await this.transcripts.capture(taskId);
    } catch {
      this.logger.warn(
        `transcript capture for task ${taskId} failed (details redacted; swallowed)`,
      );
    }
  }

  /**
   * The {@link SandboxConnection} handle captured for a running task at
   * `provision()` time (4.1), or `undefined` if none is provisioned. The
   * integration track consumes this to hand the handle to the terminal gateway
   * so it opens an `AioPtyClient` to `connection.wsUrl` (4.2).
   */
  connectionFor(taskId: string): SandboxConnection | undefined {
    return this.connections.get(taskId);
  }


  /** Durable create/readopt must fail closed on an indeterminate owner lookup. */
  private async resolveSelectedRunStrict(
    taskId: string,
  ): Promise<SelectedSandboxRun | null> {
    return (await this.sandbox?.getSelectedSandboxRun?.(taskId)) ?? null;
  }

  /**
   * detach-workspace-clone D4: sandbox ownership survives parking by
   * re-stamping the persisted `ownerGeneration` to the resuming claim's lease
   * token at re-claim. The write is one atomic conditional compare against the
   * observed parked generation, so exactly one waker can ever take over a
   * given generation (Temporal stale-task-token pattern): a stale waker fails
   * the compare and self-terminates as a lost lease before crossing the
   * provider boundary, never re-acquiring or tearing down the winner's
   * sandbox. Every other strict `ownerGeneration === leaseToken` equality site
   * is intentionally untouched — after the re-stamp the invariant "current
   * owner generation === current lease token" holds again, so the resumed
   * worker survives the existing post-provision verification unchanged.
   */
  private async restampSandboxOwnershipAtReclaim(
    taskId: string,
    leaseToken: string,
  ): Promise<void> {
    // Prisma-less (or partially stubbed) harnesses keep the historical
    // provider-side owner acquire as the re-stamp authority; production always
    // has the full durable write surface.
    const sandboxRuns = (
      this.prisma as { sandboxRun?: PrismaService['sandboxRun'] } | undefined
    )?.sandboxRun;
    if (
      typeof sandboxRuns?.findFirst !== 'function' ||
      typeof sandboxRuns.updateMany !== 'function'
    ) {
      return;
    }
    // Observe the parked generation on exactly the durable row the conditional
    // write below targets — never through provider/router lookups, which may
    // carry reattach side effects. Atomicity comes from the compare in the
    // UPDATE itself, not from this read.
    let parkedGeneration: string | null | undefined;
    try {
      const liveRun = await sandboxRuns.findFirst({
        where: { taskId, status: { in: ['provisioning', 'running'] } },
        orderBy: { createdAt: 'desc' },
        select: { ownerGeneration: true },
      });
      parkedGeneration = liveRun?.ownerGeneration;
    } catch (error) {
      // An indeterminate owner lookup can neither prove nor disprove a parked
      // predecessor. Keep the lease recoverable instead of failing the task.
      throw new TaskAdmissionCoordinationError('checkpoint', taskId, error);
    }
    if (
      parkedGeneration === undefined ||
      parkedGeneration === null ||
      parkedGeneration === leaseToken
    ) {
      return;
    }
    let restamped: { count: number };
    try {
      restamped = await sandboxRuns.updateMany({
        where: {
          taskId,
          ownerGeneration: parkedGeneration,
          status: { in: ['provisioning', 'running'] },
        },
        data: { ownerGeneration: leaseToken },
      });
    } catch (error) {
      // A failed durable write is indeterminate, not proof of supersession:
      // leave the lease for recovery rather than settling anything locally.
      throw new TaskAdmissionCoordinationError('checkpoint', taskId, error);
    }
    if (restamped.count !== 1) {
      // The conditional compare lost: another waker already re-stamped this
      // generation (or the run settled). Self-terminate as a superseded holder
      // without crossing the provider boundary; the winning attempt's state
      // and events are preserved unmerged.
      throw new TaskAdmissionLeaseLostError(taskId);
    }
  }

  /**
   * detach-workspace-clone D11: the workspace-progress handler additive
   * progress variants (e.g. the detached clone percent/objects/bytes event)
   * flow through. It was shared with the legacy provisioning chain so the two
   * could never drift; that chain has since been retired, leaving the durable
   * one as the only caller. Forwarding is best-effort by contract (a dropped
   * progress write is never an error); the optional durable checkpoint hook is
   * the only load-bearing step and fires only for stage `started` events.
   */
  private buildWorkspaceProgressChain(options: {
    readonly checkpoint?: (stage: TaskProvisioningStage) => Promise<void>;
    /**
     * Best-effort transfer-progress sink (chunk-archive-injection-with-progress
     * D2). Supplied by the durable chain, which owns the work row the progress
     * is written onto.
     */
    readonly transferProgress?: ThrottledTransferProgressWriter;
    readonly forward?: SandboxWorkspaceProgressReporter;
  }): SandboxWorkspaceProgressReporter {
    return async (event: SandboxWorkspaceProgressEvent) => {
      if (event.status === 'started' && options.checkpoint) {
        await options.checkpoint(event.stage);
      }
      if (event.status === 'progress' && options.transferProgress) {
        await options.transferProgress(event.stage, event.progress);
      }
      if (options.forward) {
        try {
          await options.forward(event);
        } catch {
          // Best-effort: durable admission state remains authoritative.
        }
      }
    };
  }

  /**
   * detach-workspace-clone D3/D9: cooperative parking seam for the durable
   * admission chain — since the retirement, the only chain there is. `park`
   * opts the
   * staged materialization into handing back the probe/kill seam instead of
   * holding this worker slot through the transfer. For a claim that resumed a
   * parked row (`claim.parkedLeaseToken` present — both same-process resume
   * and API-restart recovery ride the same expired-lease claim branch), the
   * seam additionally routes the marker evidence gathered in the sandbox
   * through {@link triageParkedAdmissionMarkers}, keeping the three-way
   * decision (alive -> keep parked / exit marker -> settle stage from it /
   * unprovable -> fail the attempt) owned by the claim/processor path with no
   * bootstrap-ordering dependence.
   */
  private buildWorkspaceTransferDetachment(
    claim: TaskAdmissionClaim,
  ): SandboxWorkspaceTransferDetachment {
    return Object.freeze({
      park: true,
      ...(claim.parkedLeaseToken == null
        ? {}
        : {
            resume: Object.freeze({
              triage: (probe: {
                readonly pidAlive: boolean;
                readonly exitMarker: { readonly exitCode: number } | null;
                readonly progressObserved?: boolean;
              }) => triageParkedAdmissionMarkers(probe),
            }),
          }),
    });
  }

  /**
   * A task reached a terminal state on its own (completion/failure). Clear its
   * guardrail timers, tear down its session credentials, and release its slot —
   * which admits the next queued task if any (12.1 slot-release; session-end
   * teardown). Idempotent.
   */
  fenceTerminal(taskId: string, status?: TaskStatus): void {
    // THE one `TaskSettled` seam (add-domain-event-bus 4.4). Computed BEFORE the
    // status is recorded below, so this method's existing idempotency extends to
    // publishing: a repeat fence with the same status re-runs the fence but
    // publishes nothing. Callers that fence without a status (teardown-only
    // paths) settle nothing and therefore publish nothing.
    // Narrowed through TERMINAL_TASK_STATUSES — the SAME declaration the event
    // schema's `status` is built from — so the publish guard and the schema
    // cannot disagree about what "terminal" means, and no cast is needed.
    const settledStatus = TERMINAL_TASK_STATUSES.find(
      (terminal) =>
        terminal === status && this.terminalTaskStatuses.get(taskId) !== status,
    );
    this.terminalTasks.add(taskId);
    if (status !== undefined) this.terminalTaskStatuses.set(taskId, status);
    this.clearTimers(taskId);
    this.runnerMinutes.recordEnd(taskId);
    if (settledStatus !== undefined) {
      this.publishDomainEvent({
        ...this.domainEventEnvelope('task.settled', taskId),
        status: settledStatus,
      });
    }
  }

  async onTerminal(taskId: string, status?: TaskStatus): Promise<void> {
    this.beginTerminalSettlement(taskId);
    // Idempotently establish the fence even for callers that bypass TasksService.
    this.fenceTerminal(taskId, status);
    try {
      if (await this.deferTerminalSettlementToDurableRecovery(taskId)) {
        return;
      }
      const forced = this.forcedTerminalPlans.get(taskId);
      const plan =
        forced && forced.status === status
          ? forced.plan
          : terminalSettlePlan();
      await this.settleTask(taskId, plan);
    } finally {
      this.forcedTerminalPlans.delete(taskId);
      this.readoptionAuthorityChecks.delete(taskId);
      this.endTerminalSettlement(taskId);
      this.releaseTerminalFenceIfIdle(taskId);
    }
  }

  /**
   * Durable admission cleanup is load-bearing: the DB work lease/slot is not
   * released until provider teardown of the exact owner generation succeeds.
   * Unlike the ordinary terminal UX path this method never swallows teardown.
   */
  async onDurableAdmissionTerminal(
    taskId: string,
    ownerGeneration: string,
    options: DurableTerminalCleanupOptions = {},
  ): Promise<void> {
    this.beginTerminalSettlement(taskId);
    this.fenceTerminal(taskId);
    try {
      const disposition = options.disposition ?? 'superseded-remove';
      // Every terminal cleanup keeps the historical transcript chokepoint,
      // including pre-launch/provisioning failures where capture is normally a
      // cheap no-rollout no-op. Callers may opt out only for a proven duplicate.
      if (options.captureTranscript ?? true) {
        await this.captureTranscript(taskId);
      }
      if (options.deliverWorkspace) {
        await this.deliverResult(taskId);
      }
      const sandbox = this.sandbox;
      if (!sandbox) {
        throw new Error('Durable sandbox cleanup provider is unavailable');
      }
      if (!sandbox.claimSandboxCleanupOwnership) {
        throw new Error('Durable sandbox cleanup ownership is unavailable');
      }
      const cleanupClaim = await sandbox.claimSandboxCleanupOwnership(
        taskId,
        ownerGeneration,
      );
      let cleanupAuthority = cleanupClaim.authority;
      if (cleanupClaim.kind === 'authorized') {
        if (!sandbox.getSandboxCleanupAuthority) {
          throw new Error('Durable sandbox cleanup authority read is unavailable');
        }
        try {
          await sandbox.teardownSandbox(taskId, {
            cleanupAuthorization: cleanupClaim.authorization,
            disposition,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          cleanupAuthority = await sandbox.getSandboxCleanupAuthority(taskId);
        } catch (error) {
          if (!isPhysicalCleanupPending(error)) throw error;
          // The router has already persisted the bounded physical evidence.
          // Re-read before deciding: another reconciler may have settled the
          // owner after this caller observed its pending control signal.
          cleanupAuthority = await sandbox.getSandboxCleanupAuthority(taskId);
          if (
            cleanupAuthority.state === 'pending' &&
            cleanupAuthority.attemptCount >=
              this.cleanupTerminalPolicyMaxAttempts &&
            (cleanupAuthority.lastAttemptOutcome === 'failed' ||
              cleanupAuthority.lastAttemptOutcome === 'indeterminate')
          ) {
            if (!sandbox.failSandboxCleanupByTerminalPolicy) {
              await this.settleCleanupDiagnostics(
                options.diagnosticSettlement,
                cleanupAuthority,
              );
              throw new Error(
                'Durable sandbox cleanup terminal policy is unavailable',
              );
            }
            try {
              cleanupAuthority =
                await sandbox.failSandboxCleanupByTerminalPolicy(
                  cleanupClaim.authorization,
                  cleanupAuthority.attemptCount,
                );
            } catch (policyError) {
              // The physical pending outcome predates the coordination error
              // from applying terminal policy. Preserve that evidence without
              // allowing the diagnostic sink to decide cleanup authority.
              await this.settleCleanupDiagnostics(
                options.diagnosticSettlement,
                cleanupAuthority,
              );
              throw policyError;
            }
          }
          if (cleanupAuthority.state === 'pending') {
            // The deleting SandboxRun remains the sole retry/slot authority,
            // but its already-persisted physical outcome must also stay
            // queryable in the task diagnostic ledger. Evidence persistence is
            // bounded and non-authoritative inside settleCleanupDiagnostics.
            await this.settleCleanupDiagnostics(
              options.diagnosticSettlement,
              cleanupAuthority,
            );
            throw error;
          }
        }
      }
      if (
        cleanupClaim.kind === 'authorized' &&
        cleanupAuthority.state === 'pending' &&
        cleanupAuthority.attemptCount >=
          this.cleanupTerminalPolicyMaxAttempts &&
        (cleanupAuthority.lastAttemptOutcome === 'failed' ||
          cleanupAuthority.lastAttemptOutcome === 'indeterminate')
      ) {
        if (!sandbox.failSandboxCleanupByTerminalPolicy) {
          await this.settleCleanupDiagnostics(
            options.diagnosticSettlement,
            cleanupAuthority,
          );
          throw new Error(
            'Durable sandbox cleanup terminal policy is unavailable',
          );
        }
        try {
          cleanupAuthority = await sandbox.failSandboxCleanupByTerminalPolicy(
            cleanupClaim.authorization,
            cleanupAuthority.attemptCount,
          );
        } catch (policyError) {
          await this.settleCleanupDiagnostics(
            options.diagnosticSettlement,
            cleanupAuthority,
          );
          throw policyError;
        }
      }
      if (cleanupAuthority.state === 'pending') {
        await this.settleCleanupDiagnostics(
          options.diagnosticSettlement,
          cleanupAuthority,
        );
        throw new Error('Durable sandbox cleanup remains pending');
      }
      await this.settleCleanupDiagnostics(
        options.diagnosticSettlement,
        cleanupAuthority,
      );
      this.connections.delete(taskId);
      this.teardownSession(taskId, options.sessionReason ?? 'failed');
      this.semaphore.release(taskId);
    } finally {
      this.readoptionAuthorityChecks.delete(taskId);
      this.endTerminalSettlement(taskId);
      this.releaseTerminalFenceIfIdle(taskId);
    }
  }

  /** Mirror a DB-authorized durable running task into the local ceiling. */
  restoreDurableAdmissionSlot(taskId: string): void {
    // This mirror is replica-local: it keeps THIS process's ceiling honest
    // about a slot the database already granted. The database reservation, not
    // this set, is the capacity authority across replicas.
    this.semaphore.restoreRunning(taskId);
  }

  /**
   * A terminal Task CAS invalidates the worker fence before this read. If its
   * durable work is still unfinished, only terminal recovery may perform the
   * exact-owner teardown and release the mirrored slot. A failed authority
   * read is conservatively treated the same way: releasing on uncertainty can
   * over-admit while a provisioning/running/deleting owner is still live.
   */
  private async deferTerminalSettlementToDurableRecovery(
    taskId: string,
  ): Promise<boolean> {
    if (!this.prisma) return false;
    try {
      const work = await this.prisma.taskAdmissionWork.findUnique({
        where: { taskId },
        select: { state: true },
      });
      const unfinished =
        work?.state === 'accepted' ||
        work?.state === 'queued' ||
        work?.state === 'running' ||
        work?.state === 'retrying';
      if (unfinished) return true;
      if (work?.state !== 'succeeded') return false;

      // A normally launched durable task settles Work as succeeded while its
      // generation-fenced SandboxRun remains live. The terminal Task CAS makes
      // that same row claimable again solely for cleanup recovery. Ownerless
      // rows deliberately stay on ordinary process-local settlement.
      const getCleanupAuthority = this.sandbox?.getSandboxCleanupAuthority;
      if (!getCleanupAuthority) return true;
      const authority = await getCleanupAuthority.call(this.sandbox, taskId);
      return (
        authority.ownershipKind === 'generation' &&
        (authority.status === 'provisioning' ||
          authority.status === 'running' ||
          authority.status === 'deleting')
      );
    } catch {
      this.logger.warn(
        `terminal admission state for task ${taskId} is indeterminate; retaining its local slot for durable recovery`,
      );
      return true;
    }
  }

  /**
   * Settle an admitted task through the single lifecycle boundary shared by
   * natural terminal exits and guardrail force-failures:
   *
   *  1. capture transcript while the sandbox is still present;
   *  2. optionally deliver workspace changes while the sandbox is still live;
   *  3. stop-only teardown the sandbox so retained history remains readable;
   *  4. tear down session credentials and unregister the terminal session;
   *  5. release the concurrency slot, admitting the next queued task.
   *
   * Each external step is best-effort; teardown/session cleanup/slot release must
   * still run if transcript capture, delivery, or sandbox stop has a problem.
   */
  private async settleTask(
    taskId: string,
    plan: SandboxSettlePlan,
  ): Promise<void> {
    let cleanupAuthority: SandboxRunCleanupAuthorityProjection | undefined;
    const getCleanupAuthority = this.sandbox?.getSandboxCleanupAuthority;
    if (getCleanupAuthority) {
      try {
        cleanupAuthority = await getCleanupAuthority.call(
          this.sandbox,
          taskId,
        );
      } catch {
        // An indeterminate cross-replica read stays fail-closed below: the
        // generation-ownership checks simply do not fire.
      }
    }
    if (
      cleanupAuthority?.ownershipKind === 'generation' &&
      (cleanupAuthority.status === 'provisioning' ||
        cleanupAuthority.status === 'running' ||
        cleanupAuthority.status === 'deleting')
    ) {
      // Close a race with a durable owner becoming visible after the initial
      // admission-state decision. Its worker performs transcript/delivery and
      // exact cleanup; this path must not invoke an unfenced physical action.
      return;
    }
    if (plan.captureTranscript) {
      await this.captureTranscript(taskId);
    }
    if (plan.deliverWorkspace) {
      await this.deliverResult(taskId);
    }
    const generationCleanupAlreadySettled =
      cleanupAuthority?.ownershipKind === 'generation' &&
      (cleanupAuthority.status === 'terminal' ||
        cleanupAuthority.status === 'removed' ||
        cleanupAuthority.status === 'failed');
    if (
      plan.teardownSandbox &&
      this.sandbox &&
      !generationCleanupAlreadySettled
    ) {
      try {
        await this.sandbox.teardownSandbox(taskId, {
          disposition: 'terminal-retain',
        });
      } catch {
        this.logger.warn(
          `sandbox teardown for task ${taskId} failed (provider details redacted)`,
        );
      }
      try {
        cleanupAuthority =
          await this.sandbox.getSandboxCleanupAuthority?.(taskId);
      } catch {
        // An indeterminate re-read keeps only the bounded physical observation
        // above and releases this task's local slot.
      }
    }
    if (
      cleanupAuthority?.ownershipKind === 'generation' &&
      (cleanupAuthority.status === 'provisioning' ||
        cleanupAuthority.status === 'running' ||
        cleanupAuthority.status === 'deleting')
    ) {
      // A concurrent durable owner became visible after the initial terminal
      // decision. Never release its mirrored capacity from the compatibility
      // path; the durable worker owns the exact cleanup retry.
      return;
    }
    if (plan.teardownSession) {
      this.teardownSession(taskId, plan.sessionReason);
    }
    if (plan.releaseSlot) {
      this.semaphore.release(taskId);
    }
  }

  /**
   * Opt-in result delivery (add-multi-forge-task-delivery): on a COMPLETED task
   * with `deliver != 'none'`, commit + push the working-tree diff IN the sandbox
   * and (for `pr`) open/reuse a change request platform-side. Gated on a re-read
   * `completed` status (onTerminal fires for ALL terminals). Best-effort + each
   * step time-boxed; NEVER throws, so it can never block teardown/slot release.
   */
  private async deliverResult(taskId: string): Promise<void> {
    const resolver = this.forgeResolver;
    const registry = this.forgeRegistry;
    const sandbox = this.sandbox;
    if (!resolver || !registry || !sandbox || !this.prisma) return;
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, deliver: true, branch: true },
      });
      // onTerminal fires for ALL terminal states — only a clean completion delivers.
      if (!task || task.status !== 'completed') return;
      const deliver = (task.deliver as 'none' | 'branch' | 'pr' | null) ?? 'none';
      if (deliver === 'none') return;

      const selected = selectDeliverySandboxProvider(sandbox);
      const target = await resolver.getForgeTarget(taskId);
      if (!target) {
        await this.persistDeliver(taskId, { deliverStatus: 'skipped' });
        return;
      }
      const forge = registry.forKind(target.kind);
      const branch = `cap/task-${taskId}`;
      const commitMessage =
        `cap: deliver task ${taskId}\n\n` +
        `Automated delivery of the agent's workspace changes.`;

      const pushResult = await selected.provider.deliverWorkspaceChanges(taskId, {
        credential: createExactHostGitCredential(
          target.cloneUrl,
          forge.cloneAuthHeader(target),
        ),
        branch,
        commitMessage,
      });
      if (!pushResult.hadChanges) {
        await this.persistDeliver(taskId, { deliverStatus: 'no_changes' });
        return;
      }
      if (pushResult.error) {
        await this.persistDeliver(taskId, { deliverStatus: 'failed', branchPushed: branch });
        return;
      }
      if (deliver === 'branch') {
        await this.persistDeliver(taskId, {
          deliverStatus: 'pushed',
          branchPushed: branch,
          commitSha: pushResult.commitSha,
        });
        return;
      }

      // deliver === 'pr' — open or reuse a change request (platform-side fetch).
      const branchResolution = await this.branchResolver?.resolve(taskId);
      if (!branchResolution) {
        await this.persistDeliver(taskId, { deliverStatus: 'failed' });
        return;
      }
      const baseBranch = branchResolution.resolvedBranch;
      const existing = await forge.findExistingChangeRequest(target, branch);
      const reused = existing !== null;
      const ref =
        existing ??
        (await forge.openChangeRequest(target, {
          headBranch: branch,
          baseBranch,
          title: `cap: task ${taskId}`,
          body: commitMessage,
        }));
      await this.persistDeliver(taskId, {
        deliverStatus: 'pr_opened',
        branchPushed: branch,
        commitSha: pushResult.commitSha,
        changeRequestUrl: ref.url,
        changeRequestNumber: ref.number,
      });
      await this.recordAudit(() =>
        this.audit?.recordChangeRequest(taskId, {
          url: ref.url,
          number: ref.number,
          reused,
        }),
      );
    } catch {
      this.logger.warn(
        `result delivery for task ${taskId} failed (provider details redacted)`,
      );
      await this.persistDeliver(taskId, { deliverStatus: 'failed' }).catch(() => undefined);
    }
  }

  /** Persist the delivery result columns (best-effort; never throws). */
  private async persistDeliver(
    taskId: string,
    data: {
      deliverStatus: string;
      branchPushed?: string | null;
      commitSha?: string | null;
      changeRequestUrl?: string | null;
      changeRequestNumber?: number | null;
    },
  ): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.task.update({ where: { id: taskId }, data }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Internal wiring
  // -------------------------------------------------------------------------


  /**
   * Open evidence for one provisioning attempt, carrying the ADMISSION-side
   * continuations into the owner that performs the bounded write.
   *
   * Whether evidence can be written at all is no longer decided here: the owner
   * answers with an observer or with the "no observer" result, and this method
   * cannot tell a closed deployment switch from an unwired recorder from a write
   * that outran its bound. What IS admission knowledge stays here — retiring an
   * attempt that arrived after the bound already detached the write — so that
   * piece did not have to travel into the diagnostics context to make the move.
   */
  private beginProvisioningDiagnostics(
    input: BeginTaskProvisioningDiagnosticObserverInput,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined> {
    return this.provisioningDiagnostics.tryBegin(input, {
      onDetachedWrite: async (lateAttempt) => {
        // A database transaction may commit after the owner's write bound
        // expired. Admission has already moved on, so retire the now-detached
        // attempt as explicitly indeterminate rather than leaving an orphaned
        // active row. The emitter is intentionally not attached to provider work
        // that continued past that best-effort boundary.
        await this.settleProvisioningDiagnostics(lateAttempt, {
          state: 'interrupted',
          stage: 'provider_selection',
          operation: 'provider_select',
          outcome: 'indeterminate',
          cause: 'settlement_unknown',
          retryable: true,
          exitCode: null,
          completion: 'mark_if_complete',
        });
      },
    });
  }


  /**
   * Best-effort attempt projection. Even a malformed custom binding must not
   * turn diagnostic persistence into lifecycle, retry, cleanup, or slot authority.
   */
  private async settleProvisioningDiagnostics(
    attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
    input: TaskProvisioningDiagnosticPrimarySettlementInput,
  ): Promise<void> {
    if (!attempt) return;
    // `settlePrimary` selects its immutable first winner synchronously. Invoke
    // it directly so a Task-CAS terminal continuation cannot overtake an
    // already-authorized settlement between this call and a queued microtask.
    let settlement: Promise<void>;
    try {
      settlement = attempt.settlement.settlePrimary(input);
    } catch {
      return;
    }
    try {
      await this.withTimeout(
        settlement,
        this.diagnosticWriteTimeoutMs,
        'task provisioning diagnostic settlement',
      );
    } catch {
      // The adapter reduces normal write failures. This bounded outer boundary
      // also keeps a hanging or non-conforming binding non-authoritative while
      // preserving the normal primary-before-cleanup ordering when it is healthy.
    }
  }

  /** Cleanup evidence is bounded and retryable, never slot/lease authority. */
  private async settleCleanupDiagnostics(
    settlement: TaskProvisioningDiagnosticSettlementController | undefined,
    evidence:
      | SandboxRunCleanupAuthorityProjection
      | TaskProvisioningDiagnosticCleanupSummary,
  ): Promise<void> {
    if (!settlement) return;
    const cleanup =
      'ownershipKind' in evidence
        ? cleanupSummaryFromAuthority(evidence)
        : evidence;
    const write = Promise.resolve().then(() =>
      settlement.settleCleanup(cleanup),
    );
    try {
      await this.withTimeout(
        write,
        this.diagnosticWriteTimeoutMs,
        'task provisioning diagnostic cleanup settlement',
      );
    } catch {
      // The authoritative SandboxRun transition and slot decision already have
      // their own fences. A stalled evidence sink can be retried by the exact
      // observer but cannot retain or release capacity.
    }
  }

  private async safeAdmissionTransition(
    taskId: string,
    next: 'queued' | 'running',
    userId?: string,
    transitionToken = randomUUID(),
  ): Promise<AdmissionTransitionResult | 'failed'> {
    try {
      return await this.tasks.transitionForAdmission(
        taskId,
        next,
        userId,
        transitionToken,
      );
    } catch (err) {
      if (err instanceof AdmissionTransitionIndeterminateError) {
        return this.reconcileAdmissionTransition(
          taskId,
          next,
          userId,
          transitionToken,
        );
      }
      this.logger.debug(
        `guardrail admission transition ${taskId} -> ${next} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'failed';
    }
  }

  private async reconcileAdmissionTransition(
    taskId: string,
    next: 'queued' | 'running',
    userId: string | undefined,
    transitionToken: string,
  ): Promise<AdmissionTransitionResult | 'failed'> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await delay(Math.min(5_000, 50 * 2 ** Math.min(attempt - 1, 7)));
      try {
        return await this.tasks.reconcileAdmissionTransition(
          taskId,
          next,
          transitionToken,
          userId,
        );
      } catch (err) {
        if (err instanceof AdmissionTransitionIndeterminateError) {
          if (attempt === 1 || attempt % 10 === 0) {
            this.logger.warn(
              `admission transition ${taskId} -> ${next} remains indeterminate; retaining its local reservation`,
            );
          }
          continue;
        }
        this.logger.debug(
          `admission reconciliation ${taskId} -> ${next} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'failed';
      }
    }
  }








  private async terminalTaskStatus(
    taskId: string,
  ): Promise<TaskStatus | undefined> {
    const retained = this.terminalTaskStatuses.get(taskId);
    if (retained !== undefined) return retained;
    if (!this.prisma) return undefined;
    try {
      const status = (
        await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { status: true },
        })
      )?.status as TaskStatus | undefined;
      return status !== undefined && isTerminalTaskStatus(status)
        ? status
        : undefined;
    } catch {
      return undefined;
    }
  }





  /**
   * Tear down the process-local runtime of a discarded admission attempt.
   *
   * ⚠ THE SECOND `recordEnd` IS NOT A SETTLEMENT (add-domain-event-bus 4.4, D11).
   * This runs when a superseded or abandoned attempt gives its runtime back; the
   * task itself usually has NO terminal status yet and will be settled later, for
   * real, by {@link fenceTerminal}. Publishing `TaskSettled` here — the obvious
   * "one event per recordEnd" symmetry — would fabricate a settlement for a task
   * that is still alive, and a subsequent real settlement would then be the
   * second event for that task. The mapping is 2 `recordEnd` call sites to 1
   * `TaskSettled`, deliberately, and the spec carries it as a negative
   * requirement so a later change cannot "fix" the asymmetry.
   */
  private clearAdmissionRuntime(taskId: string): void {
    this.clearTimers(taskId);
    this.runnerMinutes.recordEnd(taskId);
    this.connections.delete(taskId);
    this.gateway?.unregisterSession(taskId);
  }

  private async armDurableRuntime(
    taskId: string,
    lease: import('@/admission-coordination/task-admission.types').TaskAdmissionLeaseControls,
  ): Promise<void> {
    if (this.durableRuntimeArmed.has(taskId)) return;
    await lease.authorize();
    const params = this.prisma
      ? await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { deadlineMs: true, idleTimeoutMs: true },
        })
      : null;
    await lease.authorize();
    if (this.durableRuntimeArmed.has(taskId)) return;
    this.durableRuntimeArmed.add(taskId);
    const idleMs = params?.idleTimeoutMs ?? this.defaultIdleTimeoutMs ?? undefined;
    if (idleMs !== undefined) this.idle.start(taskId, idleMs);
    this.runnerMinutes.recordStart(taskId);
    // Run-start publish point 3 of 3 (add-domain-event-bus 4.3): the durable
    // path. Adjacent to the recordStart above, which is neither replaced nor
    // moved. It sits AFTER the two `durableRuntimeArmed` early-returns above, so
    // re-arming an already-armed task returns before reaching this line and no
    // second event is published for that run.
    this.publishDomainEvent({
      ...this.domainEventEnvelope('task.run_started', taskId),
      startPoint: 'durable_arm',
      admissionMode: 'durable',
    });
    if (params?.deadlineMs !== null && params?.deadlineMs !== undefined) {
      this.deadlines.armAfter(taskId, params.deadlineMs);
    }
  }

  private releaseTerminalFenceIfIdle(taskId: string): void {
    if (
      !this.readoptionsInFlight.has(taskId) &&
      !this.terminalSettlementsInFlight.has(taskId)
    ) {
      this.terminalTasks.delete(taskId);
      this.terminalTaskStatuses.delete(taskId);
    }
  }

  private beginTerminalSettlement(taskId: string): void {
    this.terminalSettlementsInFlight.set(
      taskId,
      (this.terminalSettlementsInFlight.get(taskId) ?? 0) + 1,
    );
  }

  private endTerminalSettlement(taskId: string): void {
    const remaining = (this.terminalSettlementsInFlight.get(taskId) ?? 1) - 1;
    if (remaining > 0) this.terminalSettlementsInFlight.set(taskId, remaining);
    else this.terminalSettlementsInFlight.delete(taskId);
  }

  /**
   * add-repo-content-store D4/D5 — the injection seam. Once a provider is
   * selected, its DECLARED capabilities decide which workspace-source variant
   * this task materializes from (repo-store volume mount / archive transfer /
   * the gated legacy clone). Resolution is fail-closed inside the lookup; a
   * failure surfaces as a provisioning failure rather than a silent fallback.
   *
   * Returns `undefined` only for lookup adapters that predate the content store
   * (legacy/test doubles that do not implement the method), which keeps the
   * pre-injection behavior exactly as it was.
   */
  private async resolveWorkspaceSource(
    taskId: string,
    plan: { readonly workspace?: unknown; readonly cloneSpec?: unknown },
    capabilities: readonly SandboxProviderCapability[],
  ): Promise<WorkspaceSource | undefined> {
    const resolver = this.provisionLookup?.getTaskWorkspaceSource;
    if (typeof resolver !== 'function' || !this.provisionLookup) {
      return undefined;
    }
    // No workspace to materialize (terminal-only sandbox) -> no source.
    const materializes =
      plan.workspace !== undefined
        ? plan.workspace !== null
        : plan.cloneSpec !== null && plan.cloneSpec !== undefined;
    if (!materializes) return undefined;
    return resolver.call(this.provisionLookup, taskId, capabilities);
  }

  private async resolveProvisionPlan(taskId: string) {
    if (!this.provisionLookup) {
      throw new Error('Provision lookup is not configured');
    }
    const workspaceResolver = this.provisionLookup.getTaskWorkspacePlan;
    if (typeof workspaceResolver !== 'function') {
      // Compatibility is structural and explicit: only an adapter that omits the
      // canonical method may supply the old clone input. Production Prisma always
      // implements the method, so it can never reach this implicit-HEAD path.
      const [launch, cloneSpec] = await Promise.all([
        this.provisionLookup.getTaskLaunchContext(taskId),
        this.provisionLookup.getCloneSpec(taskId),
      ]);
      return buildSandboxProvisionPlan({
        cloneSpec,
        modelIntent: launch.modelIntent,
        runtimeId: launch.runtimeId,
        executionMode: launch.executionMode,
        resources: launch.resources,
        environment: launch.environment,
      });
    }

    const [launch, workspace] = await Promise.all([
      this.provisionLookup.getTaskLaunchContext(taskId),
      workspaceResolver.call(this.provisionLookup, taskId),
    ]);
    // Runtime guards matter even though the port is non-nullable: an incorrectly
    // wired production adapter must fail closed instead of falling back to a bare
    // clone and letting the remote choose HEAD.
    if (workspace === null || workspace === undefined) {
      throw new TaskBranchResolutionError('repository_unavailable');
    }
    return buildSandboxProvisionPlan({
      cloneSpec: null,
      modelIntent: launch.modelIntent,
      runtimeId: launch.runtimeId,
      executionMode: launch.executionMode,
      resources: launch.resources,
      environment: launch.environment,
      workspace: {
        ...workspace,
        deadlineMs: launch.workspaceMaterializationDeadlineMs,
      },
    });
  }

  private assertDurableClaimMatchesProvisionPlan(
    claim: TaskAdmissionProcessorContext['claim'],
    plan: {
      readonly resources?: { readonly diskSizeGb?: number };
      readonly workspace?: {
        readonly resolvedBranch: string;
        readonly deadlineMs: number;
      } | null;
    },
  ): void {
    const resolvedBranch = plan.workspace?.resolvedBranch ?? null;
    const resources = plan.resources ?? {};
    const deadlineMs = plan.workspace?.deadlineMs ?? null;
    const deadlineMatches =
      claim.workspaceMaterializationDeadlineMs === null ||
      claim.workspaceMaterializationDeadlineMs === deadlineMs;
    if (
      claim.resolvedBranch !== resolvedBranch ||
      claim.resourceSnapshot.diskSizeGb !== resources.diskSizeGb ||
      !deadlineMatches
    ) {
      throw new TaskAdmissionProcessingError(
        'provisioning_unknown',
        claim.stage,
        false,
      );
    }
  }


  /**
   * Reclaim a task from a guardrail trip: stop/kill its running sandbox (VR.2), tear
   * down its session credentials, and release its slot (admitting the next queued
   * task). The terminal status depends on the cause: a deadline overrun / circuit
   * trip / provision or abnormal exit is a force-`failed`, but an `idle` ceiling on a
   * RESIDENT continuous-conversation session is a graceful end of life and resolves
   * `completed` (align-claude-runtime-resident-session). The cause is logged for audit.
   */
  private async forceFail(
    taskId: string,
    cause: 'deadline' | 'idle' | 'circuit_breaker' | 'provision_failed' | 'abnormal_exit',
  ): Promise<TaskStatus | undefined> {
    this.beginTerminalSettlement(taskId);
    // Abort provider work synchronously, but do not speculate about the
    // lifecycle result. TasksService feeds the confirmed CAS winner back via
    // fenceTerminal(taskId, status).
    this.fenceTerminal(taskId);
    const desiredTerminal: 'completed' | 'failed' =
      cause === 'idle' ? 'completed' : 'failed';
    this.forcedTerminalPlans.set(taskId, {
      status: desiredTerminal,
      plan: forceFailSettlePlan({ terminal: desiredTerminal }),
    });
    // structured-logging: bind taskId for all force-fail logs (incl. timer-driven
    // deadline/idle/circuit_breaker entrypoints that run outside any request).
    return runWithTaskLog(taskId, async () => {
      let transitionOutcome:
        | 'transitioned'
        | 'skipped'
        | 'superseded-readoption'
        | undefined;
      try {
        // An idle ceiling on a RESIDENT session is a graceful end of life —
        // reclaim it as `completed`, not a force-`failed`. Every other cause stays
        // a failure. The capture / stop-only teardown / slot-release below is
        // identical for both.
        const terminal = desiredTerminal;
        const transition = await this.safeTransition(taskId, terminal);
        transitionOutcome = transition;
        const winner = await this.terminalTaskStatus(taskId);
        if (winner !== terminal) return winner;

        // Only the callback from a locally confirmed TasksService CAS may own
        // the cause-specific log/audit. A cross-replica same-status observation
        // has already emitted those effects at its own linearization point.
        if (this.terminalTaskStatuses.get(taskId) === terminal) {
          this.logger.warn(
            `${terminal === 'completed' ? 'reclaiming idle task' : 'force-failing task'} ${taskId} (${cause})`,
          );
          if (terminal === 'failed') {
            await this.recordAudit(() =>
              this.audit?.recordForceFailed(taskId, cause),
            );
          }
        }
        if (transition === 'superseded-readoption') return winner;
        return winner;
      } finally {
        this.forcedTerminalPlans.delete(taskId);
        this.endTerminalSettlement(taskId);
        const remoteSameTargetCleared =
          transitionOutcome === 'transitioned' &&
          this.terminalTaskStatuses.get(taskId) === undefined &&
          this.clearReadoptionAfterTerminalObservation(taskId);
        if (
          !remoteSameTargetCleared &&
          !(await this.clearSupersededReadoption(taskId))
        ) {
          this.readoptionAuthorityChecks.delete(taskId);
        }
        this.releaseTerminalFenceIfIdle(taskId);
      }
    });
  }

  /** Clear deadline + idle timers for a task (it has settled). */
  private clearTimers(taskId: string): void {
    this.deadlines.clear(taskId);
    this.idle.stop(taskId);
    this.durableRuntimeArmed.delete(taskId);
  }

  /**
   * Tear down a task's session at session end: destroy its ephemeral
   * session-scoped credentials (the primary safety boundary) so they cannot
   * authenticate after the session closes, and drop the captured
   * {@link SandboxConnection} handle. Under the connect-in model there is no
   * per-task `TASK_TOKEN` to revoke (issuance/revocation removed in 4.4) — the
   * session-scoped credentials are the sole authentication boundary.
   */
  private teardownSession(taskId: string, reason: 'completed' | 'failed'): void {
    this.creds.destroyForSession(taskId, reason);
    this.connections.delete(taskId);
    // 4.2 — drop the gateway's terminal session for this task so its
    // `AioPtyClient`/snapshot bookkeeping does not outlive the settled task.
    this.gateway?.unregisterSession(taskId);
  }

  /**
   * Apply a lifecycle transition, tolerating an illegal edge (e.g. a task that
   * already settled). Guardrail-driven transitions race with the agent's own
   * transitions, so a rejected edge is logged and swallowed rather than thrown.
   *
   * 6.2 — the per-transition audit event is emitted CENTRALLY by
   * {@link TasksService.transition} (the single status-write chokepoint every
   * caller funnels through), so it is NOT re-emitted here; this avoids a
   * double-recorded `task.queued`/`task.running` for guardrail-driven edges. The
   * force-fail path additionally records its CAUSE-specific event before calling
   * this (see {@link forceFail}).
   */
  private async safeTransition(
    taskId: string,
    next: TaskStatus,
    userId?: string,
  ): Promise<'transitioned' | 'skipped' | 'superseded-readoption'> {
    try {
      await this.tasks.transition(taskId, next, userId);
      // `TasksService.transition` also resolves when another replica won the
      // same target status; in that branch the winner, not this process, owns
      // terminal settlement. A successful terminal observation is sufficient
      // to clear local readoption accounting without another fallible DB read.
      // A local winner establishes terminalTasks synchronously before awaiting
      // transcript/provider settlement, so this helper deliberately stays out
      // of that in-process winner's way.
      if (this.clearReadoptionAfterTerminalObservation(taskId)) {
        return 'superseded-readoption';
      }
      return 'transitioned';
    } catch (err) {
      if (await this.clearSupersededReadoption(taskId)) {
        this.logger.debug(
          `guardrail transition ${taskId} -> ${next} lost to a durable remote winner; local readoption accounting cleared`,
        );
        return 'superseded-readoption';
      }
      this.logger.debug(
        `guardrail transition ${taskId} -> ${next} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'skipped';
    }
  }

  /**
   * Re-check the exact Task/version/admission fence retained at readoption. A
   * false result is monotonic evidence that this process no longer owns runtime
   * settlement. Clear only local timers/session/accounting and release its
   * restored slot; the remote terminal winner owns credentials, delivery, and
   * provider teardown. An indeterminate re-read deliberately keeps state.
   */
  private async clearSupersededReadoption(taskId: string): Promise<boolean> {
    if (this.terminalSettlementsInFlight.has(taskId)) return false;
    const authority = this.readoptionAuthorityChecks.get(taskId);
    if (!authority) return false;
    let current: boolean;
    try {
      current = await authority();
    } catch (err) {
      this.logger.warn(
        `readoption authority re-check for task ${taskId} is indeterminate; local accounting remains fenced: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
    if (
      current ||
      this.terminalSettlementsInFlight.has(taskId) ||
      this.readoptionAuthorityChecks.get(taskId) !== authority
    ) {
      return false;
    }
    return this.clearReadoptionAfterTerminalObservation(taskId);
  }

  /** Clear only process-local state after a definitive remote terminal result. */
  private clearReadoptionAfterTerminalObservation(taskId: string): boolean {
    if (
      this.terminalSettlementsInFlight.has(taskId) ||
      !this.readoptionAuthorityChecks.delete(taskId)
    ) {
      return false;
    }
    this.clearAdmissionRuntime(taskId);
    this.semaphore.release(taskId);
    return true;
  }

  /**
   * Run a best-effort audit recording call, guaranteeing it NEVER throws into the
   * transition path (6.2). The recorder itself swallows persistence failures, but
   * this is a defensive second layer: even a synchronous throw or a rejected
   * promise from the (optional) recorder is caught and logged here, so the
   * guardrail transition/force-fail path can never be affected by audit failure.
   */
  private async recordAudit(call: () => Promise<void> | undefined): Promise<void> {
    try {
      await call();
    } catch {
      // A non-conforming recorder may reject with raw provider/Git output.
      // Keep that value outside structured logs; durable state is authoritative.
      this.logger.debug('guardrail audit record failed (swallowed)');
    }
  }

  private async requireTerminalTaskSnapshot(
    context: TaskAdmissionProcessorContext,
  ): Promise<{
    readonly status:
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'agent_failed_to_start';
    readonly failureCode: string | null;
  }> {
    const taskId = context.claim.taskId;
    if (!this.prisma) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        taskId,
        new Error('terminal task authority is unavailable'),
      );
    }
    let task: {
      readonly status: TaskStatus;
      readonly lifecycleVersion: number;
      readonly failureCode: string | null;
    } | null;
    try {
      task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          status: true,
          lifecycleVersion: true,
          failureCode: true,
        },
      });
    } catch {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        taskId,
        new Error('terminal task authority remains indeterminate'),
      );
    }
    if (
      !task ||
      task.status !== context.claim.taskStatus ||
      task.lifecycleVersion !== context.claim.taskLifecycleVersion ||
      (task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled' &&
        task.status !== 'agent_failed_to_start')
    ) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        taskId,
        new Error('terminal task authority no longer matches its claim'),
      );
    }
    return { status: task.status, failureCode: task.failureCode };
  }

  private classifyRecoveredFailedAdmission(
    workCauseCode: ProvisioningTaskFailureCode | null | undefined,
    taskFailureCode: string | null,
    taskId: string,
  ): RecoveredFailedAdmission {
    if (workCauseCode) {
      if (taskFailureCode !== workCauseCode) {
        throw new TaskAdmissionCoordinationError(
          'checkpoint',
          taskId,
          new Error('terminal Task and admission failure causes disagree'),
        );
      }
      return { kind: 'provisioning', causeCode: workCauseCode };
    }
    if (isProvisioningTaskFailureCode(taskFailureCode)) {
      return { kind: 'provisioning', causeCode: taskFailureCode };
    }
    if (isRuntimeTaskFailureCode(taskFailureCode)) {
      return { kind: 'runtime' };
    }
    if (taskFailureCode === null) return { kind: 'generic' };
    throw new TaskAdmissionCoordinationError(
      'checkpoint',
      taskId,
      new Error('terminal Task carries an unsupported failure cause'),
    );
  }

  private async requireProvisioningFailureAudit(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
    failure: ProvisioningAuditFailure,
  ): Promise<void> {
    if (!this.audit) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        taskId,
        new Error('terminal provisioning audit recorder is unavailable'),
      );
    }
    let recorded = false;
    try {
      recorded = await this.audit.recordProvisioningFailure(
        taskId,
        stage,
        attempt,
        failure,
      );
    } catch {
      // The raw rejection is intentionally discarded; the durable running work
      // row is the retry marker and must retain no provider/Git diagnostics.
    }
    if (recorded) return;
    throw new TaskAdmissionCoordinationError(
      'checkpoint',
      taskId,
      new Error('terminal provisioning audit remains pending'),
    );
  }

  private async requireTaskCancellationAudit(taskId: string): Promise<void> {
    if (!this.audit) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        taskId,
        new Error('terminal cancellation audit recorder is unavailable'),
      );
    }
    let recorded = false;
    try {
      recorded = await this.audit.recordTaskCancellation(taskId);
    } catch {
      // Keep arbitrary rejection details out of durable state and logs. The
      // running work row remains the retry marker for terminal recovery.
    }
    if (recorded) return;
    throw new TaskAdmissionCoordinationError(
      'checkpoint',
      taskId,
      new Error('terminal cancellation audit remains pending'),
    );
  }

  // -------------------------------------------------------------------------
  // Inspectors (for diagnostics / tests)
  // -------------------------------------------------------------------------

  get runningCount(): number {
    return this.semaphore.runningCount;
  }

  get queuedCount(): number {
    return this.semaphore.queuedCount;
  }

  /** The sandbox mode the bound provider reports, when wired (9.1b). */
  sandboxMode(): string | null {
    return this.sandbox?.getSandboxMode() ?? null;
  }

  /** Scheduler-facing sandbox capabilities the bound provider declares. */
  sandboxCapabilities(): readonly string[] {
    return this.sandbox?.getProviderCapabilities?.() ?? [];
  }

}

/**
 * Adapt the sandbox-layer detached-job seam to the admission worker's parked
 * job port. Probe and kill both go through the sandbox exec channel captured
 * by the materialization; a thrown probe is transient (the parked observer
 * keeps watching under the durable lease horizon), while `unknown` hands the
 * row back to the claim path for the authoritative three-way triage.
 */
function wrapDetachedWorkspaceTransferJob(
  job: SandboxDetachedWorkspaceTransferJob,
): TaskAdmissionParkedJobPort {
  return Object.freeze({
    async probe() {
      const observation = await job.probe();
      if (observation.kind === 'alive') {
        return {
          kind: 'alive' as const,
          progress: observation.progress ?? null,
        };
      }
      return { kind: observation.kind };
    },
    kill() {
      return job.kill();
    },
  });
}

function classifyDurableAdmissionError(
  error: unknown,
  fallbackStage: TaskProvisioningStage,
): TaskAdmissionProcessingError {
  if (error instanceof TaskAdmissionProcessingError) return error;
  if (isTaskBranchResolutionError(error)) {
    return new TaskAdmissionProcessingError(
      error.failureCode,
      'remote_ref_resolution',
      error.failureCode === 'provisioning_tls_network_failed',
    );
  }
  if (isSandboxProvisioningCapacityError(error)) {
    return new TaskAdmissionProcessingError(
      'provisioning_capacity_exhausted',
      'sandbox_creation',
      false,
    );
  }
  if (isSandboxWorkspaceMaterializationError(error)) {
    const failure = error.failure;
    if (failure.status === 'cancelled') {
      return new TaskAdmissionProcessingError(
        'provisioning_workspace_timeout',
        failure.stage,
        false,
      );
    }
    const cause = {
      capacity_exhausted: 'provisioning_capacity_exhausted',
      timeout: 'provisioning_workspace_timeout',
      authentication: 'provisioning_forge_auth_failed',
      tls_network: 'provisioning_tls_network_failed',
      ref_not_found: 'provisioning_ref_not_found',
      unknown: 'provisioning_unknown',
    } as const;
    return new TaskAdmissionProcessingError(
      cause[failure.cause],
      failure.stage,
      failure.retryable && failure.cause === 'tls_network',
    );
  }
  // add-repo-content-store: workspace-source selection fails BEFORE the
  // provider boundary. `copy_not_ready` is the operator-actionable one (refresh
  // the Repo's copy); the deployment-wiring failures stay `unknown` but keep
  // their finer identity in the durable diagnostic classifier.
  if (isWorkspaceSourceResolutionError(error)) {
    return new TaskAdmissionProcessingError(
      error.reason === 'copy_not_ready'
        ? 'provisioning_ref_not_found'
        : 'provisioning_unknown',
      'workspace_transfer',
      false,
    );
  }
  if (isSandboxProvisioningStageError(error)) {
    return new TaskAdmissionProcessingError(
      'provisioning_unknown',
      error.stage,
      false,
    );
  }
  if (isSandboxRuntimeModelSetupError(error)) {
    return new TaskAdmissionProcessingError(
      'provisioning_unknown',
      'runtime_setup',
      false,
    );
  }
  return new TaskAdmissionProcessingError(
    'provisioning_unknown',
    fallbackStage,
    false,
  );
}

function sandboxCleanupCoordinationPrimary(error: unknown): unknown | undefined {
  try {
    return (error as { readonly primary?: unknown }).primary;
  } catch {
    return undefined;
  }
}

function noCleanupRequiredSummary(): TaskProvisioningDiagnosticCleanupSummary {
  return {
    state: 'not_required',
    cause: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    observedAt: null,
  };
}

/** Project diagnostics from SandboxRun.status without creating new authority. */
function cleanupSummaryFromAuthority(
  authority: SandboxRunCleanupAuthorityProjection,
): TaskProvisioningDiagnosticCleanupSummary {
  if (
    authority.ownershipKind === 'legacy' &&
    authority.attemptCount > 0 &&
    authority.lastAttemptOutcome !== null
  ) {
    // Legacy terminal-retain is projected as `not_required` by SandboxRun
    // because no retry authority remains, but its retained attempt evidence is
    // still the authoritative diagnostic cleanup result. This also lets an
    // originating continuation recover the exact physical fact if the
    // terminal replica stopped after settling SandboxRun but before recording
    // diagnostics.
    const state =
      authority.lastAttemptOutcome === 'succeeded'
        ? 'succeeded'
        : authority.lastAttemptOutcome === 'failed'
          ? 'failed'
          : 'pending';
    return {
      state,
      cause: state === 'succeeded' ? null : authority.lastAttemptCause,
      attemptCount: authority.attemptCount,
      lastAttemptOutcome: authority.lastAttemptOutcome,
      observedAt: authority.lastAttemptObservedAt,
    };
  }
  if (authority.state === 'not_required') {
    return noCleanupRequiredSummary();
  }
  return {
    state: authority.state,
    cause:
      authority.state === 'succeeded' ? null : authority.lastAttemptCause,
    attemptCount: authority.attemptCount,
    lastAttemptOutcome: authority.lastAttemptOutcome,
    observedAt: authority.lastAttemptObservedAt,
  };
}


function isCleanupCoordinationPending(error: unknown): boolean {
  try {
    return isSandboxCleanupCoordinationPendingError(error);
  } catch {
    return false;
  }
}

function isPhysicalCleanupPending(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { readonly code?: unknown }).code === 'sandbox_cleanup_pending'
    );
  } catch {
    return false;
  }
}

function isTaskAdmissionControlSignal(error: unknown): boolean {
  return (
    error instanceof TaskAdmissionCoordinationError ||
    error instanceof TaskAdmissionLeaseLostError
  );
}



function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'agent_failed_to_start'
  );
}

