import {
  BadRequestException,
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionMode,
  RuntimeOutputFailure,
} from '../agent-runtime/agent-runtime.port';
import {
  DEFAULT_TASK_RUNTIME,
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  GitBranchNameSchema,
  RuntimeModelErrorSchema,
  TaskProvisioningStageSchema,
  createTaskBodySchema,
  taskResponseSchema,
  type CreateTaskBody,
  type Deliver,
  type Runtime,
  type TaskResponse,
  type TaskStatus,
} from '@cap/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  IllegalTaskTransitionError,
  assertTransition,
  isTerminal,
} from './task-lifecycle';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
  type ProvisioningAuditFailure,
} from '../audit/audit-recorder.port';
import {
  SANDBOX_PROVIDER,
  type SandboxConnection,
  type SandboxProviderCapability,
  type SelectedSandboxRun,
} from '../sandbox/sandbox-provider.port';
import {
  selectReadoptionSandboxProvider,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN,
  snapshotSandboxResources,
  type SandboxEnvironmentProviderFamily,
  type SandboxEnvironmentSelection,
  type SandboxResourceSnapshot,
} from '@cap/sandbox';
import { SandboxRunOwnerService } from '../sandbox/sandbox-run-owner.service';
import { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type {
  TaskFailureWrite,
  ProvisioningTaskFailureCode,
  RuntimeTaskFailureCode,
} from './task-failure';
import { taskFailureFromRecord } from './task-failure';
import {
  TASK_RESPONSE_INCLUDE,
  taskResponseFromRecord,
} from './task-response';
import { RuntimeModelPreflightService } from '../runtime-models/runtime-model-preflight.service';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import type { PreparedTaskCreate } from './prepared-task-create';
import { TaskModelCapabilityService } from '../runtime-models/task-model-capability.service';
import {
  TASK_ADMISSION_CANCELLATION_TOKEN,
  type TaskAdmissionCancellationPort,
} from '../task-admission/task-admission.types';
import {
  TASK_ADMISSION_GATE_TOKEN,
  TASK_ADMISSION_WAKE_TOKEN,
  type TaskAdmissionGatePort,
  type TaskAdmissionWakePort,
} from './task-admission-gate';
import {
  TaskBranchResolutionError,
  TaskBranchResolver,
} from '../forge/task-branch-resolver';
import {
  taskCreatedAuditData,
  taskCreatedAuditDedupeKey,
} from '../audit/task-created-audit';
import { isValidMaxConcurrentTasks } from '../settings/settings-logic';

/**
 * Narrow slice of `GuardrailsService` that `TasksService` depends on.
 * Declared here as an interface (rather than importing the concrete class)
 * to break the circular module reference:
 *   GuardrailsModule -> TasksModule -> GuardrailsModule
 * The runtime instance satisfies this shape; NestJS injects it by token.
 */
export interface IGuardrailsService {
  admit(
    taskId: string,
    params?: { deadlineMs?: number; idleTimeoutMs?: number; userId?: string },
  ): Promise<'running' | 'queued'>;
  /** Synchronous cancellation fence invoked immediately after a terminal write. */
  fenceTerminal?(taskId: string): void;
  onTerminal(taskId: string): Promise<void>;
  /** Strict, retryable cleanup used before durable admission work releases. */
  onDurableAdmissionTerminal?(
    taskId: string,
    ownerGeneration: string,
  ): Promise<void>;
  recordFailure(taskId: string, kind?: string): void;
  recordSuccess(taskId: string): void;
  /**
   * survive-api-redeploy (guardrails-recovery 4.1): re-account a re-adopted
   * still-running task into the semaphore running set and re-arm its
   * deadline/idle watchers from the persisted params — WITHOUT a lifecycle
   * transition or a fresh provision (the sandbox survived). Invoked by the
   * bootstrap recovery PHASE 0 for every provider-re-adopted task. Optional on
   * the interface so the narrow slice stays satisfied by builds where this
   * change has not wired it yet; the bootstrap caller optional-chains it.
   */
  readopt?(
    taskId: string,
    connection: SandboxConnection,
    params?: { deadlineMs?: number; idleTimeoutMs?: number },
    selectedRun?: SelectedSandboxRun | null,
    options?: { beforeCommit?: () => Promise<boolean> },
  ): Promise<'attached' | 'absent' | 'superseded'>;
  /**
   * configurable-task-slots (6.2): load the persisted system-level slot ceiling
   * (when a row exists) into the live semaphore, so the effective ceiling
   * resolves as `dbSetting ?? envDefault ?? 5`. Invoked by the startup recovery
   * BEFORE Phase 2 re-offers queued tasks, so re-offer admits against the
   * persisted ceiling rather than the env seed. Optional on the interface so the
   * narrow slice stays satisfied by builds where guardrails-bootstrap has not
   * wired it yet; the bootstrap caller optional-chains the invocation.
   */
  loadPersistedCeiling?(): Promise<void>;
  /** Account a DB-authorized durable running task in the legacy local ceiling. */
  restoreDurableAdmissionSlot?(taskId: string): void;
}

/** DI token used when injecting the guardrails service into the tasks service. */
export const GUARDRAILS_SERVICE_TOKEN = 'GUARDRAILS_SERVICE';

export type AdmissionTransitionResult =
  | 'transitioned'
  | 'already-transitioned'
  | 'superseded';

export interface DurableAdmissionCapacityRequest {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly expectedStatus: Extract<TaskStatus, 'pending' | 'queued' | 'running'>;
  readonly expectedLifecycleVersion: number;
  /** Process config used only when the shared singleton row does not exist. */
  readonly fallbackMaxConcurrentTasks: number;
  readonly transitionToken: string;
  readonly userId?: string;
}

export type DurableAdmissionCapacityResult =
  | {
      readonly outcome: 'queued' | 'running';
      readonly status: 'queued' | 'running';
      readonly lifecycleVersion: number;
      readonly transitioned: boolean;
    }
  | { readonly outcome: 'superseded' };

export interface DurableAdmissionFailureRequest {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly expectedStatus: Extract<
    TaskStatus,
    'pending' | 'queued' | 'running' | 'awaiting_input'
  >;
  readonly expectedLifecycleVersion: number;
  readonly stage: import('@cap/contracts').TaskProvisioningStage;
  readonly causeCode: ProvisioningTaskFailureCode;
}

export type PostCommitAdmissionResult =
  | 'durable-woken'
  | 'legacy-admitted'
  | 'fail-closed';

/** Short transaction-bound surface for one canonical acceptance write. */
export type TaskAcceptanceClient = Pick<
  Prisma.TransactionClient,
  'task' | 'taskAdmissionWork' | 'auditEvent'
>;

/**
 * The admission status write may have committed even though the database client
 * did not receive its acknowledgement. Callers must retry resolution with the
 * same transition token and must not release their local reservation meanwhile.
 */
export class AdmissionTransitionIndeterminateError extends Error {
  constructor(
    readonly taskId: string,
    readonly next: Extract<TaskStatus, 'queued' | 'running'>,
    readonly transitionToken: string,
    readonly cause?: unknown,
  ) {
    super(`Admission transition outcome is indeterminate: ${taskId} -> ${next}`);
    this.name = 'AdmissionTransitionIndeterminateError';
  }
}

class DurableAdmissionAtomicSettlementError extends Error {
  constructor() {
    super('Durable admission terminal transaction lost its authority');
    this.name = 'DurableAdmissionAtomicSettlementError';
  }
}

class DurableAdmissionTerminalAuditError extends Error {
  constructor() {
    super('Durable admission terminal audit remains pending');
    this.name = 'DurableAdmissionTerminalAuditError';
  }
}

const DURABLE_ADMISSION_STAGE_ORDER_SQL = Prisma.sql`ARRAY[
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete'
]::text[]`;

/**
 * Narrow slice of the {@link SandboxProvider} re-adoption surface (Track 3.3)
 * the bootstrap recovery PHASE 0 consumes (survive-api-redeploy). Declared
 * structurally (rather than widening the {@link SandboxProvider} port import
 * here) and OPTIONAL on the injected provider so this file stays decoupled from
 * the provider impl and compiles both before and after Track 3 wires the
 * surface — the Phase 0 caller optional-chains both calls.
 *
 *  - `listReadoptable()` lists the taskIds whose RUNNING `cap-aio-*` container
 *    AND detached `task<taskId>` tmux session survived (validated against the DB
 *    `running`/`awaiting_input` state + session liveness), with the provider's
 *    own connection tracking already re-registered.
 *  - `reattach(taskId)` re-registers/returns the still-valid
 *    {@link SandboxConnection} handle for a survivor, or `undefined` when it can
 *    no longer be re-adopted (raced to gone between the list and the reattach).
 */
export interface ISandboxReadoption {
  getSandboxMode(): string;
  getProviderCapabilities?(): readonly SandboxProviderCapability[];
  listReadoptable?(): Promise<string[]>;
  reattach?(taskId: string): Promise<SandboxConnection | null | undefined>;
  getSelectedSandboxRun?(taskId: string): Promise<SelectedSandboxRun | null>;
  reconcileSandboxInventory?(request: {
    readonly protectedTaskIds: readonly string[];
    /**
     * Destructive reconciliation is allowed only for a provider resource whose
     * durable Task row is authoritatively absent. Task ids are never reused, so
     * this eligibility remains true after the check; every extant Task stays on
     * its ordinary lifecycle/retention cleanup path.
     */
    readonly canReap: (candidate: {
      readonly taskId: string;
      readonly providerSandboxId: string;
    }) => Promise<boolean>;
  }): Promise<{ readonly inspected: number; readonly reaped: number }>;
}

const UNFINISHED_TASK_ADMISSION_STATES = [
  'accepted',
  'queued',
  'running',
  'retrying',
] as const;

type StartupAdmissionWorkState =
  | (typeof UNFINISHED_TASK_ADMISSION_STATES)[number]
  | 'succeeded'
  | 'failed'
  | 'cancelled';

function isUnfinishedTaskAdmissionState(
  state: string | null | undefined,
): state is (typeof UNFINISHED_TASK_ADMISSION_STATES)[number] {
  return UNFINISHED_TASK_ADMISSION_STATES.some((candidate) => candidate === state);
}

function isLegacyReadoptionWorkState(
  state: StartupAdmissionWorkState | null | undefined,
): boolean {
  return state === null || state === undefined || state === 'succeeded';
}

/**
 * add-claude-code-runtime (tasks-api 4.1): narrow slice of the
 * {@link AgentRuntimeRegistry} the create path consumes to DISPATCH admission to
 * the runtime selected by the task's `runtime` value. Declared structurally (not
 * imported from the agent-runtime leaf module) and injected OPTIONAL so the tasks
 * service still constructs in unit contexts and in builds where the integration
 * track has not yet bound the registry; when absent the resolve step is skipped
 * and the persisted `runtime` column (read by the provider) remains the dispatch
 * source of truth, so codex behavior is unchanged.
 *
 *  - `resolve(runtime)` returns the {@link AgentRuntime} for a (possibly
 *    null/absent) task runtime — codex by default, claude-code when asked — and
 *    THROWS for an unknown id. The create path treats that throw as a fail-closed
 *    create-time rejection rather than admitting a task that resolves no runtime.
 */
export interface IAgentRuntimeRegistry {
  resolve(runtime: Runtime | null | undefined): {
    id: Runtime;
    /** Execution modes the resolved runtime supports (add-headless-execution-track). */
    executionModes: ReadonlySet<ExecutionMode>;
    classifyOutputFailure?(output: string): RuntimeOutputFailure | null;
  };
}

/** DI token the integration track binds the concrete runtime registry to. */
export const AGENT_RUNTIME_REGISTRY_TOKEN = 'AGENT_RUNTIME_REGISTRY';

/**
 * add-claude-code-runtime (tasks-api 4.2): narrow slice of a per-runtime auth
 * source the create path consults to FAIL CLOSED when a `claude-code` create
 * selects an unconfigured runtime. Exposes ONLY the boolean `configured()` fact
 * (never the token), mirroring {@link ClaudeAuthSource}; injected OPTIONAL so the
 * service constructs without it (no source ⇒ readiness is unknown and the gate is
 * skipped, deferring the fail-closed to the provision-time `injectAuth`).
 */
export interface IRuntimeReadiness {
  configured(ownerUserId: string): Promise<boolean>;
}

/**
 * DI token the create path injects the Claude readiness source under. The
 * integration track binds the `CLAUDE_AUTH_SOURCE` provider (exported by the
 * sandbox module) to this token; the source exposes `configured()` only.
 */
export const CLAUDE_RUNTIME_READINESS_TOKEN = 'CLAUDE_RUNTIME_READINESS';

/**
 * The stable, machine-readable reason a `claude-code` (or any future runtime)
 * create is rejected with when its runtime is not configured/ready. Surfaced so
 * the console can tell this fail-closed apart from a generic failure, and so a
 * task NEVER launches an unauthenticated agent (add-claude-code-runtime 4.2).
 */
export const RUNTIME_NOT_CONFIGURED_REASON = 'runtime not configured';

/**
 * Thrown by `create` when the selected runtime is not configured/ready. A
 * `ServiceUnavailableException` (503) — the request is well-formed (a VALID
 * runtime, so it is NOT a 400 the contract pipe would reject), but the server
 * cannot service it because the runtime's credential is absent. Carries a
 * distinct `reason` so the fail-closed is unambiguous on the wire.
 */
export class RuntimeNotConfiguredException extends ServiceUnavailableException {
  constructor(readonly runtime: Runtime) {
    super({
      reason: RUNTIME_NOT_CONFIGURED_REASON,
      runtime,
      message: `runtime "${runtime}" is not configured`,
    });
  }
}

/**
 * Task persistence + lifecycle service.
 *
 * Creation is scoped to an existing repo (404 otherwise). Status changes flow
 * through the lifecycle state machine: {@link transition} only persists a new
 * status when the requested edge is permitted, and leaves the stored status
 * untouched when it is rejected.
 *
 * VR.1 / VR.5: When `GuardrailsService` is wired (optional, injected by the
 * `GUARDRAILS_SERVICE_TOKEN` to avoid a circular module reference), `create`
 * calls `admit()` so the FIFO semaphore actually bounds running tasks, and every
 * terminal-state transition calls `onTerminal()` so the session-scoped
 * credentials are torn down on the happy path.
 */
@Injectable()
export class TasksService
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(TasksService.name);
  private admissionWorkerStop: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(GUARDRAILS_SERVICE_TOKEN)
    private readonly guardrails?: IGuardrailsService,
    /**
     * Best-effort audit recorder (6.2), injected by the {@link AUDIT_RECORDER_TOKEN}
     * (verify-phase wiring in `app.module.ts`). `TasksService.transition` is the
     * single status-write chokepoint, so it is the central seam that emits one
     * audit event per ACCEPTED lifecycle transition. Optional + never-throwing, so
     * an audit failure can never roll back or block the transition.
     */
    @Optional()
    @Inject(AUDIT_RECORDER_TOKEN)
    private readonly audit?: AuditRecorderPort,
    /**
     * survive-api-redeploy: the global {@link SandboxProvider} port, consumed
     * ONLY through its narrow re-adoption surface ({@link ISandboxReadoption})
     * in the bootstrap recovery PHASE 0. Optional so the tasks service still
     * constructs in unit contexts without a provider; when absent, Phase 0 is a
     * no-op and recovery degrades to the prior reclaim + re-offer behavior.
     */
    @Optional()
    @Inject(SANDBOX_PROVIDER)
    private readonly sandbox?: ISandboxReadoption,
    /**
     * add-claude-code-runtime (4.1): the runtime registry, consumed ONLY to
     * RESOLVE the runtime a create selects so admission dispatches to the right
     * agent (codex by default, claude-code when asked). Optional so the service
     * constructs without it; when absent the persisted `runtime` column the
     * provider reads is the dispatch source of truth (codex behavior unchanged).
     */
    @Optional()
    @Inject(AGENT_RUNTIME_REGISTRY_TOKEN)
    private readonly runtimes?: IAgentRuntimeRegistry,
    /**
     * add-claude-code-runtime (4.2): the Claude readiness source, consulted to
     * FAIL CLOSED when a `claude-code` create selects an unconfigured runtime.
     * Exposes a boolean only (never the token). Optional so the service
     * constructs without it; when absent the create-time gate is skipped and the
     * provision-time `injectAuth` remains the fail-closed backstop.
     */
    @Optional()
    @Inject(CLAUDE_RUNTIME_READINESS_TOKEN)
    private readonly claudeReadiness?: IRuntimeReadiness,
    @Optional()
    private readonly sandboxOwners?: SandboxRunOwnerService,
    @Optional()
    private readonly sandboxEnvironments?: SandboxEnvironmentsService,
    @Optional()
    private readonly runtimeModelPreflight?: RuntimeModelPreflightService,
    @Optional()
    private readonly taskModelCapability?: TaskModelCapabilityService,
    @Optional()
    @Inject(TASK_ADMISSION_GATE_TOKEN)
    private readonly taskAdmissionGate?: TaskAdmissionGatePort,
    @Optional()
    private readonly taskBranchResolver?: TaskBranchResolver,
    @Optional()
    @Inject(TASK_ADMISSION_WAKE_TOKEN)
    private readonly taskAdmissionWake?: TaskAdmissionWakePort,
    @Optional()
    @Inject(TASK_ADMISSION_CANCELLATION_TOKEN)
    private readonly taskAdmissionCancellation?: TaskAdmissionCancellationPort,
  ) {}

  /**
   * Ordered startup coordinator for legacy recovery and durable admission.
   *
   * 1. Snapshot unfinished durable work so legacy re-adoption/reclaim cannot
   *    steal an accepted, retrying, or expired-lease task from the DB worker.
   * 2. Strictly re-adopt provider-attested legacy survivors, then fail only the
   *    definitely absent legacy running tasks.
   * 3. Restore the persisted ceiling, reconcile only authoritatively deleted
   *    physical orphans, and re-offer legacy pending/queued work in stable FIFO.
   * 4. Start the polling worker last. Its claim query recovers both accepted
   *    work and expired leases without depending on an in-process wake signal.
   *
   * Any provider/terminal/DB uncertainty in the destructive portions aborts
   * bootstrap closed. Loading the persisted ceiling remains the one deliberate
   * best-effort step: the environment seed is still a valid conservative
   * fallback and avoids stranding legacy queued work.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Durable work owns its task/sandbox until the leased worker settles it.
    // Compute this protection set before asking providers to inventory local
    // resources: a pre-agent sandbox has no tmux session yet and must not be
    // mistaken for a legacy orphan during restart recovery.
    const durableProtected = await this.listUnfinishedDurableAdmissionTaskIds();
    const readopted = await this.readoptSurvivorsOnStartup(durableProtected);
    await this.reclaimOrphanedOnStartup(readopted, durableProtected);
    if (this.guardrails?.loadPersistedCeiling) {
      try {
        await this.guardrails.loadPersistedCeiling();
      } catch (err) {
        this.logger.warn(
          `startup recovery: could not load the persisted slot ceiling (env seed stays effective): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Refresh the fast-path protection snapshot before reconciliation. The
    // provider must additionally ask `canReap` for every candidate before any
    // removal: another replica may have changed durable ownership after either
    // snapshot, and an indeterminate DB read must fail bootstrap closed.
    for (const taskId of await this.listUnfinishedDurableAdmissionTaskIds()) {
      durableProtected.add(taskId);
    }
    await this.sandbox?.reconcileSandboxInventory?.({
      protectedTaskIds: [...durableProtected, ...readopted],
      canReap: async ({ taskId }) => {
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { id: true },
        });
        // Only physical resources whose logical Task was deleted are startup
        // orphans. Terminal Tasks deliberately stay on stop-retain/repair;
        // reconciliation must not erase their retained history.
        return task === null;
      },
    });

    // Refresh local slot accounting immediately before legacy FIFO re-offer.
    // Match the durable capacity union: unfinished work occupies compatibility
    // capacity when either its Task is running or an exact sandbox cleanup is
    // still live. The latter includes terminal Tasks whose durable cleanup has
    // not yet advanced the owner out of provisioning/running/deleting.
    await this.restoreRunningDurableAdmissionSlotsOnStartup();

    // Re-offer only after old provider artifacts have been reconciled. Otherwise
    // a newly admitted legacy task could create a sandbox between inventory and
    // reap and have that fresh resource mistaken for a startup orphan.
    await this.reofferQueuedOnStartup();

    // Polling is the durable recovery floor. Start it only after every legacy
    // recovery phase and provider reconciliation has reached a safe boundary.
    this.taskAdmissionWake?.start?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stopAdmissionWorker();
  }

  async onApplicationShutdown(): Promise<void> {
    // Idempotent safety net for direct callers. In a Nest shutdown the worker
    // already stopped in beforeApplicationShutdown, after scheduler destroy
    // hooks and before Nest disposes its transports.
    await this.stopAdmissionWorker();
  }

  private stopAdmissionWorker(): Promise<void> {
    return (this.admissionWorkerStop ??= Promise.resolve(
      this.taskAdmissionWake?.stop?.(),
    ));
  }

  /**
   * Work in these states is exclusively owned by the durable worker. This
   * includes an expired `running` lease: the database claim query, not legacy
   * startup recovery, decides when it may be taken over.
   */
  async listUnfinishedDurableAdmissionTaskIds(): Promise<Set<string>> {
    const rows = await this.prisma.taskAdmissionWork.findMany({
      where: {
        OR: [
          { state: { in: [...UNFINISHED_TASK_ADMISSION_STATES] } },
          {
            state: 'succeeded',
            task: {
              status: {
                in: [
                  'completed',
                  'failed',
                  'cancelled',
                  'agent_failed_to_start',
                ],
              },
              sandboxRuns: {
                some: {
                  status: { in: ['provisioning', 'running', 'deleting'] },
                  ownerGeneration: { not: null },
                  resourceGeneration: { not: null },
                },
              },
            },
          },
        ],
      },
      select: { taskId: true },
    });
    return new Set(rows.map(({ taskId }) => taskId));
  }

  private async restoreRunningDurableAdmissionSlotsOnStartup(): Promise<void> {
    const restore = this.guardrails?.restoreDurableAdmissionSlot;
    if (!restore) return;
    const rows = await this.prisma.taskAdmissionWork.findMany({
      where: {
        OR: [
          {
            state: { in: [...UNFINISHED_TASK_ADMISSION_STATES] },
            task: {
              OR: [
                { status: { in: ['running', 'awaiting_input'] } },
                {
                  sandboxRuns: {
                    some: {
                      status: { in: ['provisioning', 'running', 'deleting'] },
                    },
                  },
                },
              ],
            },
          },
          {
            state: 'succeeded',
            task: {
              status: {
                in: [
                  'completed',
                  'failed',
                  'cancelled',
                  'agent_failed_to_start',
                ],
              },
              sandboxRuns: {
                some: {
                  status: { in: ['provisioning', 'running', 'deleting'] },
                  ownerGeneration: { not: null },
                  resourceGeneration: { not: null },
                },
              },
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { taskId: 'asc' }],
      select: { taskId: true },
    });
    for (const { taskId } of rows) {
      restore.call(this.guardrails, taskId);
    }
  }

  /**
   * PHASE 0 of startup recovery (survive-api-redeploy 4.2): RE-ADOPT every
   * still-running task whose sandbox + detached codex session survived the
   * restart. Lists the provider-validated survivors (Track 3.3 — DB
   * `running`/`awaiting_input` AND session liveness already checked, provider
   * tracking re-registered), and for each calls `guardrails.readopt(...)` with
   * the task's PERSISTED `deadlineMs`/`idleTimeoutMs` so it re-accounts the slot
   * and re-arms its watchers, leaving the task in its CURRENT state (NOT
   * transitioned). Returns the set of re-adopted taskIds so Phase 1 can skip
   * them. Deployments without the optional readoption seam retain legacy
   * reclaim behavior; once the seam is present, incomplete metadata, inventory
   * errors, and attach uncertainty abort bootstrap rather than becoming a false
   * sandbox-death observation.
   */
  async readoptSurvivorsOnStartup(
    durableProtected: Set<string> = new Set(),
  ): Promise<Set<string>> {
    const readopted = new Set<string>();
    const sandbox = this.sandbox;
    if (!sandbox?.reattach || !this.guardrails?.readopt) {
      return readopted;
    }
    let selected: ISandboxReadoption;
    try {
      selected = selectReadoptionSandboxProvider(sandbox).provider;
    } catch {
      throw new Error('startup re-adopt provider selection is indeterminate');
    }
    if (
      typeof selected.reattach !== 'function' ||
      typeof selected.getSelectedSandboxRun !== 'function'
    ) {
      throw new Error('startup re-adopt provider surface is incomplete');
    }
    const candidates = new Set<string>();
    try {
      const ownerRows = await this.sandboxOwners?.listActiveSandboxRunOwners?.() ?? [];
      for (const owner of ownerRows) {
        candidates.add(owner.taskId);
      }
    } catch {
      throw new Error(
        'startup persisted sandbox owner inventory is indeterminate',
      );
    }
    try {
      const providerCandidates = await selected.listReadoptable?.() ?? [];
      for (const taskId of providerCandidates) {
        candidates.add(taskId);
      }
    } catch {
      throw new Error('startup provider sandbox inventory is indeterminate');
    }
    for (const taskId of candidates) {
      if (durableProtected.has(taskId)) continue;
      const row = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          status: true,
          lifecycleVersion: true,
          deadlineMs: true,
          idleTimeoutMs: true,
          admissionWork: { select: { state: true } },
        },
      });
      if (!row || (row.status !== 'running' && row.status !== 'awaiting_input')) {
        continue;
      }
      const admissionState = row.admissionWork?.state as
        | StartupAdmissionWorkState
        | undefined;
      if (isUnfinishedTaskAdmissionState(admissionState)) {
        durableProtected.add(taskId);
        continue;
      }
      if (!isLegacyReadoptionWorkState(admissionState)) continue;

      // `null` is the provider's definitive absent result. A rejection is
      // indeterminate and deliberately aborts bootstrap rather than flowing into
      // Phase 1 as a false death observation.
      let connection: SandboxConnection | null | undefined;
      try {
        connection = await selected.reattach?.(taskId);
      } catch {
        throw new Error(
          `startup sandbox reattach for task ${taskId} is indeterminate`,
        );
      }
      if (!connection) continue;
      let selectedRun: SelectedSandboxRun | null;
      try {
        selectedRun =
          (await selected.getSelectedSandboxRun?.(taskId)) ?? null;
      } catch {
        throw new Error(
          `startup selected-run lookup for task ${taskId} is indeterminate`,
        );
      }
      if (
        !selectedRun ||
        selectedRun.taskId !== taskId ||
        connection.taskId !== taskId ||
        (!selectedRun.terminal &&
          !(connection as SandboxConnection & { terminal?: unknown }).terminal)
      ) {
        throw new Error(
          `startup selected-run metadata for task ${taskId} is incomplete`,
        );
      }

      let result: 'attached' | 'absent' | 'superseded';
      try {
        result = await this.guardrails.readopt(
          taskId,
          connection,
          {
            deadlineMs: row.deadlineMs ?? undefined,
            idleTimeoutMs: row.idleTimeoutMs ?? undefined,
          },
          selectedRun,
          {
            beforeCommit: async () => {
              const current = await this.prisma.task.findUnique({
                where: { id: taskId },
                select: {
                  status: true,
                  lifecycleVersion: true,
                  admissionWork: { select: { state: true } },
                },
              });
              return (
                current?.status === row.status &&
                current.lifecycleVersion === row.lifecycleVersion &&
                isLegacyReadoptionWorkState(
                  current.admissionWork?.state as
                    | StartupAdmissionWorkState
                    | undefined,
                )
              );
            },
          },
        );
      } catch {
        throw new Error(
          `startup terminal attach for task ${taskId} is indeterminate`,
        );
      }
      if (result === 'attached') {
        readopted.add(taskId);
        continue;
      }
      if (result === 'superseded') {
        const current = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: {
            status: true,
            lifecycleVersion: true,
            admissionWork: { select: { state: true } },
          },
        });
        if (!current) continue;
        if (isTerminal(current.status)) {
          // The terminal transition owns stop-and-retain cleanup. Do not race it
          // with destructive startup reconciliation in this bootstrap pass.
          durableProtected.add(taskId);
          continue;
        }
        if (isUnfinishedTaskAdmissionState(current.admissionWork?.state)) {
          durableProtected.add(taskId);
          continue;
        }
        throw new Error(
          `startup readoption fence for task ${taskId} changed indeterminately`,
        );
      }
    }
    if (readopted.size > 0) {
      this.logger.log(
        `startup re-adopt: re-adopted ${readopted.size} still-running task(s) across the restart`,
      );
    }
    return readopted;
  }

  /**
   * Transition every `running` / `awaiting_input` task to `failed` — the
   * startup reclaim of orphaned in-flight tasks. Tasks RE-ADOPTED in Phase 0
   * (their sandbox + detached codex session survived the restart) are SKIPPED
   * so they stay in their current state (survive-api-redeploy 4.2); only the
   * truly-dead in-flight tasks are force-failed. Returns the count reclaimed.
   * Reuses {@link transition} so each reclaim is edge-validated, audited, and
   * runs the terminal guardrail teardown through the single status-write
   * chokepoint. Best-effort per task: a failure is logged and skipped, never
   * blocking boot.
   */
  async reclaimOrphanedOnStartup(
    readopted: ReadonlySet<string> = new Set(),
    durableProtected: Set<string> = new Set(),
  ): Promise<number> {
    const orphaned = await this.prisma.task.findMany({
      where: {
        status: { in: ['running', 'awaiting_input'] },
        OR: [
          { admissionWork: { is: null } },
          {
            admissionWork: {
              is: {
                state: { notIn: [...UNFINISHED_TASK_ADMISSION_STATES] },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    let reclaimed = 0;
    for (const { id } of orphaned) {
      // Re-adopted survivors are kept in their current state, not failed.
      if (readopted.has(id) || durableProtected.has(id)) {
        continue;
      }
      try {
        await this.transition(id, 'failed');
        reclaimed += 1;
      } catch (err) {
        // Reconciliation must not delete a sandbox whose lifecycle transition
        // was not durably acknowledged.
        durableProtected.add(id);
        this.logger.warn(
          `startup reclaim: could not fail orphaned task ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (reclaimed > 0) {
      this.logger.log(
        `startup reclaim: failed ${reclaimed} orphaned in-flight task(s)`,
      );
    }
    return reclaimed;
  }

  /**
   * Phase 2 of startup recovery (configurable-task-slots 6.1): re-offer every
   * DB `pending` or `queued` task to the in-memory concurrency semaphore in `createdAt asc`
   * (FIFO) order, restoring each task's persisted per-task guardrail parameters
   * (`deadlineMs`, `idleTimeoutMs`) and durable owner from its task row. `admit()` arms the deadline
   * / idle watchers for tasks within capacity exactly as at creation time, and
   * holds the remainder `queued` in offer order, so a queued task is never
   * stranded (never re-offered) after a restart. Returns the count re-offered.
   * Best-effort per task: a failure is logged and skipped, never blocking boot.
   * Prisma stores omitted params as `null`; they are coalesced back to
   * `undefined` so a re-offered task arms (or skips) its watchers identically
   * to a task admitted before the restart.
   */
  async reofferQueuedOnStartup(): Promise<number> {
    if (!this.guardrails) {
      return 0;
    }
    const queued = await this.prisma.task.findMany({
      where: {
        // Any task with durable admission work is owned exclusively by the
        // leased worker, including accepted/queued rows during rollout.
        admissionWork: { is: null },
        OR: [
          { status: 'queued' },
          { status: 'pending', scheduleRun: { is: null } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        status: true,
        ownerUserId: true,
        deadlineMs: true,
        idleTimeoutMs: true,
        auditEvents: {
          where: { type: 'task.created', userId: { not: null } },
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { userId: true },
        },
      },
    });
    let reoffered = 0;
    for (const task of queued) {
      try {
        const ownerUserId =
          task.ownerUserId ?? task.auditEvents[0]?.userId ?? undefined;
        if (task.status === 'pending') {
          await this.recordAudit(() =>
            this.audit?.recordTaskCreated(task.id, ownerUserId),
          );
        }
        await this.guardrails.admit(task.id, {
          deadlineMs: task.deadlineMs ?? undefined,
          idleTimeoutMs: task.idleTimeoutMs ?? undefined,
          userId: ownerUserId,
        });
        reoffered += 1;
      } catch (err) {
        this.logger.warn(
          `startup re-offer: could not re-offer queued task ${task.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (reoffered > 0) {
      this.logger.log(
        `startup re-offer: re-offered ${reoffered} queued task(s) to the semaphore`,
      );
    }
    return reoffered;
  }

  async create(
    repoId: string,
    body: CreateTaskBody,
    userId?: string,
    executionMode: ExecutionMode = 'interactive-pty',
  ): Promise<TaskResponse> {
    // Console + non-idempotent path: commit canonical acceptance, then perform
    // post-commit dispatch. With the durable gate open, acceptance is Task +
    // unique work item + creation audit and dispatch is only a local worker wake.
    // The split lets `/v1` compose that acceptance with its dedup row in one
    // transaction, while keeping every external provisioning action post-commit.
    // `userId` is the acting account PRIMARY KEY (present for local + GitHub
    // accounts, fix-local-account-task-attribution) so the `task.created` audit
    // event is owner-attributed and the owner-scoped Codex credential resolves.
    const prepared = await this.prepareTaskCreate(
      repoId,
      body,
      executionMode,
      userId,
    );
    const response = await this.acceptPreparedTask(prepared);
    await this.admitCreatedTask(
      response.id,
      prepared.body,
      prepared.ownerUserId ?? undefined,
    );
    return response;
  }

  /**
   * Resolve every non-transactional dependency needed to create a Task.
   * Explicit models are catalog-validated here and carry the exact immutable
   * environment snapshot used by that catalog lookup. Omitted models never
   * invoke the catalog and retain the existing environment/default behavior.
   */
  async prepareTaskCreate(
    repoId: string,
    body: CreateTaskBody,
    executionMode: ExecutionMode = 'interactive-pty',
    userId?: string,
  ): Promise<PreparedTaskCreate> {
    return this.prepareTaskCreateInternal(
      repoId,
      body,
      executionMode,
      userId,
      false,
    );
  }

  /**
   * Continue a durable schedule occurrence that was accepted while the gate was
   * open. This skips only the new-work gate; catalog/environment validation is
   * still repeated against the occurrence's immutable template snapshot.
   */
  async prepareAcceptedScheduledRetryTaskCreate(
    repoId: string,
    body: CreateTaskBody,
    userId: string,
  ): Promise<PreparedTaskCreate> {
    return this.prepareTaskCreateInternal(
      repoId,
      body,
      'headless-exec',
      userId,
      true,
    );
  }

  private async prepareTaskCreateInternal(
    repoId: string,
    body: CreateTaskBody,
    executionMode: ExecutionMode,
    userId: string | undefined,
    acceptedExplicitModel: boolean,
  ): Promise<PreparedTaskCreate> {
    const normalizedBody = createTaskBodySchema.parse(body);
    // Read the rollout gate exactly once for this acceptance. Every later
    // decision, including the transaction write, consumes the frozen mode.
    const admissionMode = (this.taskAdmissionGate?.isEnabled() ?? false)
      ? 'durable-v2'
      : 'legacy';
    if (normalizedBody.model !== undefined && !acceptedExplicitModel) {
      // The deployment cutover fence must run before repo/runtime/readiness,
      // environment resolution, credential work, or a taskless catalog probe.
      this.assertTaskModelSelectionOpen();
    }
    const runtime = await this.resolveTaskCreateFoundation(
      repoId,
      normalizedBody,
      this.prisma,
      executionMode,
      userId,
    );

    let sandboxEnvironmentId: string | null;
    let model: string | null = null;
    let executionEnvironmentSnapshot: PreparedTaskCreate['executionEnvironmentSnapshot'] =
      null;
    let resolvedResources: SandboxResourceSnapshot | null | undefined;
    let workspaceMaterializationDeadlineMs: number | undefined;

    if (normalizedBody.model !== undefined) {
      if (!userId || !this.runtimeModelPreflight) {
        throw new RuntimeModelPreflightError(
          RuntimeModelErrorSchema.parse({
            code: 'runtime_model_catalog_unavailable',
            message: 'Runtime model selection is temporarily unavailable.',
            retryable: true,
            context: modelErrorContext(runtime, normalizedBody),
          }),
        );
      }
      const preflight = await this.runtimeModelPreflight.preflight({
        ownerUserId: userId,
        query: {
          runtime,
          ...(Object.prototype.hasOwnProperty.call(
            normalizedBody,
            'sandboxEnvironmentId',
          )
            ? { sandboxEnvironmentId: normalizedBody.sandboxEnvironmentId }
            : {}),
        },
        model: normalizedBody.model,
      });
      if (!preflight.ok) {
        throw new RuntimeModelPreflightError(preflight.error);
      }
      if (
        preflight.value.intent !== 'explicit' ||
        preflight.value.executionEnvironmentSnapshot === null
      ) {
        throw new RuntimeModelPreflightError(
          RuntimeModelErrorSchema.parse({
            code: 'runtime_model_catalog_unavailable',
            message: 'Runtime model selection is temporarily unavailable.',
            retryable: true,
            context: modelErrorContext(runtime, normalizedBody),
          }),
        );
      }
      model = preflight.value.model;
      executionEnvironmentSnapshot =
        preflight.value.executionEnvironmentSnapshot;
      resolvedResources = executionSnapshotResources(
        executionEnvironmentSnapshot,
      );
      sandboxEnvironmentId =
        executionEnvironmentSnapshot.managedEnvironmentId;
      if (admissionMode === 'durable-v2') {
        const admission = await this.resolveDurableTaskAdmission(
          { kind: 'deployment-default' },
          runtime,
          executionEnvironmentSnapshot.providerFamily,
          resolvedResources ?? {},
        );
        if (
          admission.providerId !== executionEnvironmentSnapshot.provider ||
          admission.providerFamily !==
            executionEnvironmentSnapshot.providerFamily ||
          !sameSandboxResources(
            admission.provisioningPolicy.resources,
            resolvedResources ?? {},
          )
        ) {
          throw new Error(
            'Durable task admission provider policy changed after model preflight',
          );
        }
        workspaceMaterializationDeadlineMs =
          admission.provisioningPolicy.workspaceMaterializationDeadlineMs;
      }
    } else {
      const selection = await this.selectTaskEnvironment(
        normalizedBody,
        userId,
        this.prisma,
      );
      if (admissionMode === 'durable-v2') {
        const admission = await this.resolveDurableTaskAdmission(
          selection,
          runtime,
        );
        sandboxEnvironmentId =
          admission.environment?.environmentId ??
          admission.environment?.id ??
          null;
        resolvedResources = admission.provisioningPolicy.resources;
        workspaceMaterializationDeadlineMs =
          admission.provisioningPolicy.workspaceMaterializationDeadlineMs;
      } else {
        const environment = await this.resolveTaskEnvironment({
          selection,
          runtime,
        });
        sandboxEnvironmentId =
          environment?.environmentId ?? environment?.id ?? null;
      }
    }

    let resolvedBranch: string | undefined;
    let resourceSnapshot: SandboxResourceSnapshot | undefined;
    if (admissionMode === 'durable-v2') {
      if (!this.taskBranchResolver) {
        throw new TaskBranchResolutionError('repository_unavailable');
      }
      const branch = await this.taskBranchResolver.prepareForCreate({
        repoId,
        ownerUserId: userId ?? null,
        callerBranch: normalizedBody.branch ?? null,
      });
      resolvedBranch = branch.resolvedBranch;
      // `{}` is an intentional provider-neutral snapshot: it means the resolved
      // environment/deployment policy requested no portable resource override.
      // Provider-native configuration is never copied into durable work.
      resourceSnapshot =
        snapshotSandboxResources(resolvedResources ?? {}) ?? Object.freeze({});
    }

    const frozenBody = Object.freeze({
      ...normalizedBody,
      ...(normalizedBody.skills
        ? { skills: Object.freeze([...normalizedBody.skills]) as string[] }
        : {}),
    });
    const preparedBase = {
      repoId,
      ownerUserId: userId ?? null,
      body: frozenBody,
      runtime,
      executionMode,
      sandboxEnvironmentId,
      model,
      executionEnvironmentSnapshot,
    } as const;
    if (admissionMode === 'durable-v2') {
      if (
        resolvedBranch === undefined ||
        resourceSnapshot === undefined ||
        !isValidWorkspaceMaterializationDeadline(
          workspaceMaterializationDeadlineMs,
        )
      ) {
        throw new Error('Durable task acceptance preparation is incomplete');
      }
      return Object.freeze({
        ...preparedBase,
        admissionMode: 'durable-v2' as const,
        resolvedBranch,
        resourceSnapshot,
        workspaceMaterializationDeadlineMs,
      });
    }
    return Object.freeze({
      ...preparedBase,
      admissionMode: 'legacy' as const,
    });
  }

  /**
   * Canonical acceptance writer used by Console, V1, MCP, and schedules.
   *
   * Every credential/catalog/branch/resource operation has already completed in
   * `prepareTaskCreate`. With the durable gate open this method commits the Task,
   * its unique admission work item, and the idempotent `task.created` audit in
   * one transaction. A caller such as V1/schedules may supply its existing
   * transaction so their ledger/idempotency write shares the same rollback.
   */
  async acceptPreparedTask(
    prepared: PreparedTaskCreate,
    client?: TaskAcceptanceClient,
    options: { readonly acceptedExplicitModel?: boolean } = {},
  ): Promise<TaskResponse> {
    if (client) {
      return this.writePreparedTaskAcceptance(prepared, client, options);
    }
    if (prepared.admissionMode === 'durable-v2') {
      return this.prisma.$transaction((tx) =>
        this.writePreparedTaskAcceptance(prepared, tx, options),
      );
    }
    // Gate closed: preserve the legacy contract exactly — only the Task row is
    // written, then the caller performs post-commit legacy admission.
    return this.createTaskRow(prepared, this.prisma, options);
  }

  private async writePreparedTaskAcceptance(
    prepared: PreparedTaskCreate,
    client: TaskAcceptanceClient,
    options: { readonly acceptedExplicitModel?: boolean },
  ): Promise<TaskResponse> {
    const task = await this.createTaskRow(prepared, client, options);
    if (prepared.admissionMode !== 'durable-v2') return task;

    // Defensive runtime checks complement the discriminated preparation type so
    // JavaScript/test adapters cannot write a half-prepared durable work item.
    const branch = GitBranchNameSchema.safeParse(prepared.resolvedBranch);
    const callerBranch =
      prepared.body.branch === undefined
        ? null
        : GitBranchNameSchema.safeParse(prepared.body.branch);
    const resourceSnapshot = snapshotSandboxResources(
      prepared.resourceSnapshot,
    );
    if (
      !branch.success ||
      resourceSnapshot === undefined ||
      !isValidWorkspaceMaterializationDeadline(
        prepared.workspaceMaterializationDeadlineMs,
      ) ||
      (callerBranch !== null &&
        (!callerBranch.success || callerBranch.data !== branch.data))
    ) {
      throw new Error('Durable task acceptance snapshots are incomplete');
    }

    const work = await client.taskAdmissionWork.create({
      data: {
        taskId: task.id,
        resolvedBranch: branch.data,
        resourceSnapshot: resourceSnapshot as Prisma.InputJsonObject,
        workspaceMaterializationDeadlineMs:
          prepared.workspaceMaterializationDeadlineMs,
      },
    });
    const auditData = taskCreatedAuditData(task.id, prepared.ownerUserId);
    await client.auditEvent.upsert({
      where: { dedupeKey: taskCreatedAuditDedupeKey(task.id) },
      update: {},
      create: auditData,
    });
    return taskResponseSchema.parse({
      ...task,
      provisioning: {
        state: work.state,
        stage: work.stage,
        attempt: work.attempt,
        resolvedBranch: work.resolvedBranch,
        updatedAt: work.updatedAt,
      },
    });
  }

  /**
   * Persist the task ROW ONLY — validation + the `task.create` INSERT — optionally
   * on a caller-supplied transaction-bound Prisma client (`client`) so the row can
   * commit ATOMICALLY with another write in the same transaction (the `/v1`
   * idempotency dedup row, public-v1-api V.1 / D5). Records NO audit and does NOT
   * offer the task to the guardrails semaphore: that is {@link admitCreatedTask},
   * run AFTER the row (and any transaction it shares) has COMMITTED, so a rollback
   * can never provision an orphan sandbox. Defaults to the injected `this.prisma`
   * for the ordinary (non-transactional) console path.
   */
  async createTaskRow(
    prepared: PreparedTaskCreate,
    client: Pick<PrismaService, 'task'> = this.prisma,
    options: { readonly acceptedExplicitModel?: boolean } = {},
  ): Promise<TaskResponse> {
    if (prepared.model !== null && !options.acceptedExplicitModel) {
      // Cheap synchronous race recheck immediately before the pure write. An
      // already accepted durable retry passes the internal-only bypass; callers
      // cannot set it through REST/MCP schemas.
      this.assertTaskModelSelectionOpen();
    }
    const task = await client.task.create({
      data: {
        repoId: prepared.repoId,
        ownerUserId: prepared.ownerUserId,
        prompt: prepared.body.prompt,
        // Internal-only expectation marker.  A newly accepted task starts with
        // no fabricated provider attempt; the recorder atomically consumes the
        // one-based counter only after running capacity is actually won.
        provisioningDiagnosticSchemaVersion:
          TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
        provisioningDiagnosticNextAttempt: 1,
        // add-claude-code-runtime (4.1): persist the selected runtime so it is
        // durable and readable on every later read path AND so the provider
        // dispatches to the right agent at provision time. Coalesce `undefined`
        // (omitted) to `null`; a null column reads back as the default `codex`
        // (repo-and-task-management: a prior task with no runtime reads as codex).
        runtime: prepared.body.runtime ?? null,
        model: prepared.model,
        ...(prepared.executionEnvironmentSnapshot
          ? {
              executionEnvironmentSnapshot:
                prepared.executionEnvironmentSnapshot as Prisma.InputJsonValue,
            }
          : {}),
        sandboxEnvironmentId: prepared.sandboxEnvironmentId,
        // add-headless-execution-track (5.1/5.2): persist the consumer-derived execution
        // mode. Store null for the interactive default (console — reads back as
        // interactive-pty), and `headless-exec` for programmatic (MCP / `/v1`) tasks.
        executionMode:
          prepared.executionMode === 'headless-exec' ? 'headless-exec' : null,
        // 3.2: persist the optional run parameters from the create body so they
        // are durable and readable on every later read path. They are inert with
        // respect to clone/provision/lifecycle behavior. Coalesce `undefined`
        // (field omitted) to `null` so the stored value is the supplied value or
        // an explicit null — never stale/fabricated on read-back (3.3).
        branch: prepared.body.branch ?? null,
        strategy: prepared.body.strategy ?? null,
        // add-multi-forge-task-delivery: persist the opt-in delivery selector.
        // Omitted ⇒ null (reads back as `none`); the result columns are populated
        // by the push-back attempt at terminal.
        deliver: prepared.body.deliver ?? null,
        // task-preinstall-skills: persist the selected skill ids (inert, like
        // branch/strategy). Omitted ⇒ empty array (the column default), echoed
        // back on every read path. Validation against the server allowlist
        // happens at provision time, not here (storage is permissive).
        skills: prepared.body.skills ?? [],
        // task-guardrail-controls: persist the optional guardrail parameters.
        // They are consumed at admission (arming the idle/deadline watchers) AND
        // persisted so the configured value is readable on every task read path.
        // Coalesce `undefined` (omitted) to `null` — never stale/fabricated; a
        // null `idleTimeoutMs` means "no idle reclaim" (opt-in, off by default).
        idleTimeoutMs: prepared.body.idleTimeoutMs ?? null,
        deadlineMs: prepared.body.deadlineMs ?? null,
        // Initial status is the schema default (`pending`).
      },
    });

    // Under the connect-in model there is NO per-task TASK_TOKEN minted at
    // creation: the orchestrator dials the per-task AIO sandbox by container name
    // on `cap-net`, so there is no dial-back to authenticate (token issuance +
    // the dial-back verifier were removed with the runner, migrate-aio 7.4).

    return taskResponseSchema.parse(taskResponseFromRecord(task));
  }

  /** New explicit-model admission is fail-closed even if DI wiring regresses. */
  assertTaskModelSelectionOpen(): void {
    if (this.taskModelCapability) {
      this.taskModelCapability.assertOpen();
      return;
    }
    throw new RuntimeModelPreflightError(
      RuntimeModelErrorSchema.parse({
        code: 'runtime_model_catalog_unavailable',
        message: 'Runtime model selection is temporarily unavailable.',
        retryable: true,
      }),
    );
  }

  async normalizeTaskTemplateForSchedule(
    repoId: string,
    body: CreateTaskBody,
    userId: string,
    _client: PrismaService = this.prisma,
  ): Promise<CreateTaskBody & { repoId: string; runtime: Runtime; sandboxEnvironmentId: string | null; deliver: Deliver }> {
    const prepared = await this.prepareTaskCreate(
      repoId,
      body,
      'headless-exec',
      userId,
    );
    return {
      ...prepared.body,
      repoId,
      runtime: prepared.runtime,
      sandboxEnvironmentId: prepared.sandboxEnvironmentId,
      deliver: prepared.body.deliver ?? 'none',
    };
  }

  /**
   * Post-commit dispatch for a freshly-created task.
   *
   * Presence of durable admission work is the authoritative mode fence. Such a
   * task may only be consumed by the durable worker, so this path emits at most a
   * local wake signal and never records another audit or calls guardrails/provider
   * code. A legacy adapter that has no work row retains the old audit + admission
   * behavior while the rollout gate is closed.
   */
  async admitCreatedTask(
    taskId: string,
    body: Readonly<CreateTaskBody>,
    userId?: string,
  ): Promise<PostCommitAdmissionResult> {
    const workReader = (
      this.prisma as unknown as {
        taskAdmissionWork?: {
          findUnique(args: {
            where: { taskId: string };
            select: { taskId: true };
          }): Promise<{ taskId: string } | null>;
        };
      }
    ).taskAdmissionWork;
    if (typeof workReader?.findUnique === 'function') {
      let work: { taskId: string } | null;
      try {
        work = await workReader.findUnique({
          where: { taskId },
          select: { taskId: true },
        });
      } catch (err) {
        // An indeterminate read must not risk bypassing an existing work item.
        // Durable polling will recover gate-on work; legacy admission can be
        // retried after the database is readable again.
        this.logger.warn(
          `task ${taskId} admission mode lookup failed closed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'fail-closed';
      }
      if (work) {
        try {
          this.taskAdmissionWake?.wake(taskId);
        } catch (err) {
          this.logger.warn(
            `task ${taskId} durable admission wake failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return 'durable-woken';
      }
    }

    const resolvedUserId = await this.resolveTaskOwnerId(taskId, userId);
    // 6.2 — record the creation audit event (201/info), attributed to the
    // creating operator's ACCOUNT id when known (the `users.id` primary key,
    // present for local + GitHub accounts — fix-local-account-task-attribution).
    // Emitted BEFORE `admit()` so the `task.created` event precedes any
    // `task.running`/`task.queued` event, AND so the owner-scoped Codex credential
    // resolver (which reads this event's `userId`) can later attribute the task.
    await this.recordAudit(() =>
      this.audit?.recordTaskCreated(taskId, resolvedUserId),
    );

    // VR.1 — offer the task to the guardrails concurrency semaphore so the FIFO
    // semaphore actually bounds running tasks. When a slot is free it transitions
    // the task to `running` and arms its deadline + idle timers; otherwise it
    // holds the task in `queued` (no sandbox provisioned). VR.11 — plumb the
    // optional guardrail params through so the deadline + idle watchers arm. Idle
    // is OPT-IN: an omitted `idleTimeoutMs` leaves reclamation to the operator
    // default (off when unset).
    if (this.guardrails) {
      await this.guardrails
        .admit(taskId, {
          deadlineMs: body.deadlineMs,
          idleTimeoutMs: body.idleTimeoutMs,
          userId: resolvedUserId,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `guardrails admit for task ${taskId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
    return 'legacy-admitted';
  }

  private async resolveTaskOwnerId(
    taskId: string,
    fallbackUserId?: string,
  ): Promise<string | undefined> {
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { ownerUserId: true },
      });
      const persisted = task?.ownerUserId ?? undefined;
      if (persisted && fallbackUserId && persisted !== fallbackUserId) {
        this.logger.warn(
          `task ${taskId} admission owner mismatch; using persisted owner ${persisted}`,
        );
      }
      return persisted ?? fallbackUserId;
    } catch (err) {
      this.logger.warn(
        `task ${taskId} owner lookup failed; using caller attribution: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return fallbackUserId;
    }
  }

  async list(): Promise<TaskResponse[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'asc' },
      include: TASK_RESPONSE_INCLUDE,
    });
    return tasks.map((task) =>
      taskResponseSchema.parse(taskResponseFromRecord(task)),
    );
  }

  async findById(id: string): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: TASK_RESPONSE_INCLUDE,
    });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }
    return taskResponseSchema.parse(taskResponseFromRecord(task));
  }

  /**
   * Classify a bounded runtime-output window through the task's selected
   * AgentRuntime policy. The shared task/guardrail layers never inspect
   * provider-specific text themselves.
   */
  async classifyRuntimeOutputFailure(
    id: string,
    output: string,
  ): Promise<RuntimeOutputFailure | null> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { runtime: true },
    });
    if (!task || !this.runtimes) return null;
    const runtime = this.runtimes.resolve(
      (task.runtime ?? DEFAULT_TASK_RUNTIME) as Runtime,
    );
    return runtime.classifyOutputFailure?.(output) ?? null;
  }

  /**
   * Attempts to move a task into `next`. The transition is validated by the
   * lifecycle state machine before any write; an illegal transition (e.g.
   * `completed` -> `pending`) throws {@link IllegalTaskTransitionError} and the
   * persisted status is left unchanged.
   *
   * Returns the updated task on success.
   */
  async transition(
    id: string,
    next: TaskStatus,
    userId?: string,
  ): Promise<TaskResponse> {
    return this.transitionInternal(id, next, userId);
  }

  /**
   * Persist a classified runtime-auth failure in the SAME lifecycle CAS as the
   * terminal status. A stop/completion winner is never overwritten, and readers
   * never observe `failed` without the already-known structured cause.
   */
  async failWithRuntimeFailure(
    id: string,
    code: RuntimeTaskFailureCode,
    exitCode: number | null = null,
  ): Promise<TaskResponse> {
    return this.transitionInternal(id, 'failed', undefined, {
      code,
      occurredAt: new Date(),
      exitCode,
    });
  }

  /**
   * Persist a safe provisioning classification in the same lifecycle CAS as
   * terminal failure. Branch resolution uses this before provider selection so
   * a missing/auth/network ref never degrades to an unstructured failure.
   */
  async failWithProvisioningFailure(
    id: string,
    code: ProvisioningTaskFailureCode,
  ): Promise<TaskResponse> {
    return this.transitionInternal(id, 'failed', undefined, {
      code,
      occurredAt: new Date(),
      exitCode: null,
    });
  }

  private async transitionInternal(
    id: string,
    next: TaskStatus,
    userId?: string,
    failure?: TaskFailureWrite,
  ): Promise<TaskResponse> {
    if (failure && next !== 'failed') {
      throw new Error('Structured task failure can only accompany failed status');
    }
    const failureData = failure
      ? {
          failureCode: failure.code,
          failureAt: failure.occurredAt,
          failureExitCode: failure.exitCode,
        }
      : {};
    let terminalSettlement: Promise<void> | undefined;
    let terminalFenceEstablished = false;
    const startTerminalSettlement = (): void => {
      if (!isTerminal(next) || terminalFenceEstablished) return;
      terminalFenceEstablished = true;
      // Abort the in-process durable claim immediately after the Task CAS. A
      // worker in another replica observes the same version change on its next
      // DB-fenced renewal; both paths feed the provider's cancellation signal.
      this.taskAdmissionCancellation?.abortTask(id);
      // A normally launched durable task has already settled its admission
      // work as `succeeded`. The terminal Task CAS makes that row claimable
      // again only when a generation-fenced SandboxRun still needs cleanup;
      // wake is merely the low-latency hint and database polling remains the
      // cross-replica recovery floor.
      this.taskAdmissionWake?.wake(id);
      if (!this.guardrails) return;
      this.guardrails.fenceTerminal?.(id);
      terminalSettlement = this.guardrails.onTerminal(id).catch((err: unknown) => {
        this.logger.warn(
          `guardrails onTerminal for task ${id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    };

    let updated;
    for (;;) {
      const task = await this.prisma.task.findUnique({
        where: { id },
        include: TASK_RESPONSE_INCLUDE,
      });
      if (!task) throw new NotFoundException(`Task not found: ${id}`);

      const observedStatus = task.status as TaskStatus;
      if (failure && observedStatus === 'failed') {
        // A generic exit/guardrail actor may win the terminal status race just
        // before the runtime classifier finishes. Preserve that lifecycle
        // winner, but fill its still-empty structured cause with a second CAS.
        // Existing causes are immutable; concurrent classifiers observe the
        // first writer and never overwrite it.
        if (task.failureCode) {
          return taskResponseSchema.parse(taskResponseFromRecord(task));
        }
        try {
          const enriched = await this.prisma.task.updateMany({
            where: {
              id,
              status: 'failed',
              lifecycleVersion: task.lifecycleVersion,
              failureCode: null,
            },
            data: failureData,
          });
          if (enriched.count === 1) {
            const enrichedTask = await this.prisma.task.findUnique({
              where: { id },
              include: TASK_RESPONSE_INCLUDE,
            });
            if (!enrichedTask) {
              throw new NotFoundException(`Task not found: ${id}`);
            }
            return taskResponseSchema.parse(taskResponseFromRecord(enrichedTask));
          }
        } catch (err) {
          const confirmed = await this.prisma.task.findUnique({
            where: { id },
            include: TASK_RESPONSE_INCLUDE,
          });
          if (!confirmed) throw new NotFoundException(`Task not found: ${id}`);
          if (
            (confirmed.status as TaskStatus) !== 'failed' ||
            !confirmed.failureCode
          ) {
            throw err;
          }
          return taskResponseSchema.parse(taskResponseFromRecord(confirmed));
        }

        // A concurrent classifier filled the cause between our read and CAS.
        // Re-read through the loop; the branch above returns the winner.
        continue;
      }
      // Validates the edge before every CAS attempt. If another lifecycle actor
      // already committed a terminal state, this throws instead of overwriting
      // that winner with a stale read.
      assertTransition(observedStatus, next);

      const observedLifecycleVersion = task.lifecycleVersion;
      let changed: { count: number };
      try {
        changed = await this.prisma.task.updateMany({
          where: {
            id,
            status: observedStatus,
            lifecycleVersion: observedLifecycleVersion,
          },
          data: {
            status: next,
            lifecycleVersion: { increment: 1 },
            ...failureData,
          },
        });
      } catch (err) {
        // A database acknowledgement can be lost after commit. Re-read the row;
        // terminal cleanup is idempotent, so confirming the requested status is
        // safer than abandoning a committed terminal without teardown.
        const confirmed = await this.prisma.task.findUnique({
          where: { id },
          include: TASK_RESPONSE_INCLUDE,
        });
        if (!confirmed) throw new NotFoundException(`Task not found: ${id}`);
        if (
          (confirmed.status as TaskStatus) !== next ||
          (failure && confirmed.failureCode !== failure.code)
        ) {
          throw err;
        }
        startTerminalSettlement();
        updated = confirmed;
        break;
      }

      if (changed.count === 1) {
        // The status CAS is the terminal linearization point. Establish the
        // in-process provider fence in this same continuation, before the
        // response-row re-read yields to any admission continuation.
        startTerminalSettlement();
        updated = await this.prisma.task.findUnique({
          where: { id },
          include: TASK_RESPONSE_INCLUDE,
        });
        if (!updated) throw new NotFoundException(`Task not found: ${id}`);
        break;
      }

      const winner = await this.prisma.task.findUnique({
        where: { id },
        include: TASK_RESPONSE_INCLUDE,
      });
      if (!winner) throw new NotFoundException(`Task not found: ${id}`);
      if ((winner.status as TaskStatus) === next) {
        if (failure && !winner.failureCode) {
          // A generic failed transition won after our initial read. Loop into
          // the failed-row enrichment branch instead of returning without the
          // already-classified cause.
          continue;
        }
        // Another caller committed the same transition and owns its audit and
        // terminal cleanup. Observe it idempotently without duplicating either.
        return taskResponseSchema.parse(taskResponseFromRecord(winner));
      }
      // A non-terminal winner (for example running -> awaiting_input) may still
      // permit the requested transition. Loop and validate that latest state.
      assertTransition(winner.status as TaskStatus, next);
    }

    // Covers a confirmed ambiguous commit. The ordinary count=1 path already
    // started this before its post-CAS response read.
    startTerminalSettlement();

    // 6.2 — the status write was ACCEPTED (an illegal edge would have thrown
    // above, before any write): record one audit event for this transition,
    // attributed to the operator's ACCOUNT id when known. Best-effort: never
    // rolls back or blocks the transition.
    const response = taskResponseSchema.parse(taskResponseFromRecord(updated));
    await Promise.all([
      this.recordAudit(() =>
        this.audit?.recordTransition(
          id,
          next,
          userId,
          response.failure ?? undefined,
        ),
      ),
      terminalSettlement ?? Promise.resolve(),
    ]);

    return response;
  }

  /**
   * Admission-only lifecycle CAS. Unlike {@link transition}, this method returns
   * no response DTO and therefore has no post-commit parsing failure window. A
   * competing worker that already committed the same target is reported as
   * `already-transitioned`; callers must not provision a second sandbox in that
   * case.
   */
  async reserveDurableAdmissionCapacity(
    request: DurableAdmissionCapacityRequest,
  ): Promise<DurableAdmissionCapacityResult> {
    if (
      !Number.isSafeInteger(request.expectedLifecycleVersion) ||
      request.expectedLifecycleVersion < 0
    ) {
      throw new Error('Invalid durable admission lifecycle fence');
    }
    if (
      !Number.isSafeInteger(request.fallbackMaxConcurrentTasks) ||
      request.fallbackMaxConcurrentTasks < 1
    ) {
      throw new Error('Invalid durable admission capacity ceiling');
    }

    let transitioned = false;
    const result = await this.prisma.$transaction(async (tx) => {
      // All replicas serialize only the short capacity-count/CAS section. Task
      // terminal transitions do not need this lock: a concurrent release either
      // becomes visible before the count or makes this reservation conservatively
      // queue until the durable poll retries it.
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(1128353875, 1)
      `);

      // The ceiling is part of the same DB-linearized decision as the occupied
      // count. A replica-local semaphore may be stale after another replica
      // persists a settings change and therefore is only an absence fallback.
      const settings = await tx.systemSettings.findUnique({
        where: { id: 'system' },
        select: { maxConcurrentTasks: true },
      });
      const maxConcurrentTasks =
        settings &&
        isValidMaxConcurrentTasks(settings.maxConcurrentTasks)
          ? settings.maxConcurrentTasks
          : request.fallbackMaxConcurrentTasks;

      const rows = await tx.$queryRaw<
        Array<{ status: string; lifecycleVersion: number }>
      >(Prisma.sql`
        SELECT
          t."status"::text AS "status",
          t."lifecycle_version" AS "lifecycleVersion"
        FROM "tasks" AS t
        INNER JOIN "task_admission_work" AS w ON w."task_id" = t."id"
        WHERE
          t."id" = ${request.taskId}
          AND t."status"::text = ${request.expectedStatus}
          AND t."lifecycle_version" = ${request.expectedLifecycleVersion}
          AND w."state" = 'running'
          AND w."lease_owner" = ${request.leaseToken}
          AND w."lease_until" > clock_timestamp()
        FOR UPDATE OF t, w
      `);
      const authority = rows[0];
      if (!authority) return { outcome: 'superseded' } as const;

      const current = authority.status as TaskStatus;
      if (current === 'running') {
        return {
          outcome: 'running',
          status: 'running',
          lifecycleVersion: authority.lifecycleVersion,
          transitioned: false,
        } as const;
      }
      if (current !== 'pending' && current !== 'queued') {
        return { outcome: 'superseded' } as const;
      }

      // Claims use SKIP LOCKED so multiple workers may hold leases at once.
      // Capacity promotion still has to preserve the durable admission FIFO,
      // independent of which worker reaches this advisory lock first. Any
      // older accepted/queued/actively-claimed task keeps this task queued.
      const older = await tx.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM "task_admission_work" AS older_w
          INNER JOIN "tasks" AS older_t ON older_t."id" = older_w."task_id"
          INNER JOIN "task_admission_work" AS current_w
            ON current_w."task_id" = ${request.taskId}
          WHERE
            older_t."status"::text IN ('pending', 'queued')
            AND older_w."state" IN ('accepted', 'queued', 'running')
            AND (
              older_w."created_at" < current_w."created_at"
              OR (
                older_w."created_at" = current_w."created_at"
                AND older_w."task_id" < current_w."task_id"
              )
            )
        ) AS "blocked"
      `);
      const blockedByOlderAdmission = older[0]?.blocked === true;

      const occupiedRows = await tx.$queryRaw<Array<{ occupied: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "occupied"
        FROM (
          SELECT t."id" AS "taskId"
          FROM "tasks" AS t
          WHERE t."status"::text IN ('running', 'awaiting_input')
          UNION
          SELECT run."task_id" AS "taskId"
          FROM "sandbox_runs" AS run
          WHERE run."status" IN ('provisioning', 'running', 'deleting')
        ) AS occupied_slots
      `);
      const occupied = occupiedRows[0]?.occupied ?? 0;
      const next: 'queued' | 'running' =
        !blockedByOlderAdmission && occupied < maxConcurrentTasks
          ? 'running'
          : 'queued';
      if (current === next) {
        return {
          outcome: next,
          status: next,
          lifecycleVersion: authority.lifecycleVersion,
          transitioned: false,
        } as const;
      }
      assertTransition(current, next);

      const changed = await tx.task.updateMany({
        where: {
          id: request.taskId,
          status: current,
          lifecycleVersion: authority.lifecycleVersion,
        },
        data:
          next === 'queued'
            ? {
                status: next,
                lifecycleVersion: { increment: 1 },
                queuedAdmissionToken: request.transitionToken,
              }
            : {
                status: next,
                lifecycleVersion: { increment: 1 },
                runningAdmissionToken: request.transitionToken,
              },
      });
      if (changed.count !== 1) {
        return { outcome: 'superseded' } as const;
      }
      transitioned = true;
      return {
        outcome: next,
        status: next,
        lifecycleVersion: authority.lifecycleVersion + 1,
        transitioned: true,
      } as const;
    });

    if (transitioned && result.outcome !== 'superseded') {
      await this.recordAudit(() =>
        this.audit?.recordTransition(
          request.taskId,
          result.status,
          request.userId,
        ),
      );
    }
    return result;
  }

  /**
   * Two-phase durable terminal settlement:
   *  1. atomically terminalize Task and persist the safe work cause while the
   *     work row remains leased/running;
   *  2. strictly confirm sandbox generation cleanup;
   *  3. only then mark work failed and release its lease.
   * A crash/rejection between phases leaves a reclaimable expired running row.
   */
  async settleDurableAdmissionFailure(
    request: DurableAdmissionFailureRequest,
  ): Promise<boolean> {
    const stage = TaskProvisioningStageSchema.parse(request.stage);
    if (
      !Number.isSafeInteger(request.expectedLifecycleVersion) ||
      request.expectedLifecycleVersion < 0
    ) {
      throw new Error('Invalid durable admission failure fence');
    }
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
      throw new Error('Invalid durable admission failure attempt');
    }
    const occurredAt = new Date();
    let taskCommitted = false;
    try {
      taskCommitted = await this.prisma.$transaction(async (tx) => {
        const authority = await tx.$queryRaw<
          Array<{ status: string; lifecycleVersion: number }>
        >(Prisma.sql`
          SELECT
            t."status"::text AS "status",
            t."lifecycle_version" AS "lifecycleVersion"
          FROM "tasks" AS t
          INNER JOIN "task_admission_work" AS w ON w."task_id" = t."id"
          WHERE
            t."id" = ${request.taskId}
            AND t."status"::text = ${request.expectedStatus}
            AND t."lifecycle_version" = ${request.expectedLifecycleVersion}
            AND w."state" = 'running'
            AND w."lease_owner" = ${request.leaseToken}
            AND w."lease_until" > clock_timestamp()
          FOR UPDATE OF t, w
        `);
        if (!authority[0]) return false;
        assertTransition(request.expectedStatus, 'failed');
        const taskChanged = await tx.task.updateMany({
          where: {
            id: request.taskId,
            status: request.expectedStatus,
            lifecycleVersion: request.expectedLifecycleVersion,
          },
          data: {
            status: 'failed',
            lifecycleVersion: { increment: 1 },
            failureCode: request.causeCode,
            failureAt: occurredAt,
            failureExitCode: null,
          },
        });
        if (taskChanged.count !== 1) {
          throw new DurableAdmissionAtomicSettlementError();
        }
        const workChanged = await tx.$executeRaw(Prisma.sql`
          UPDATE "task_admission_work"
          SET
            "stage" = CASE
              WHEN array_position(
                ${DURABLE_ADMISSION_STAGE_ORDER_SQL},
                "stage"
              ) <= array_position(
                ${DURABLE_ADMISSION_STAGE_ORDER_SQL},
                ${stage}
              ) THEN ${stage}
              ELSE "stage"
            END,
            "cause_code" = ${request.causeCode},
            "updated_at" = clock_timestamp()
          WHERE
            "task_id" = ${request.taskId}
            AND "state" = 'running'
            AND "lease_owner" = ${request.leaseToken}
            AND "lease_until" > clock_timestamp()
        `);
        if (workChanged !== 1) {
          throw new DurableAdmissionAtomicSettlementError();
        }
        return true;
      });
    } catch (error) {
      if (error instanceof DurableAdmissionAtomicSettlementError) return false;
      // Resolve a lost phase-1 acknowledgement. Task + the still-running work
      // cause were one transaction, so this exact shape proves commit.
      const [task, work] = await Promise.all([
        this.prisma.task.findUnique({
          where: { id: request.taskId },
          select: {
            status: true,
            lifecycleVersion: true,
            failureCode: true,
            failureAt: true,
          },
        }),
        this.prisma.taskAdmissionWork.findUnique({
          where: { taskId: request.taskId },
          select: { state: true, causeCode: true, leaseOwner: true },
        }),
      ]);
      if (
        task?.status !== 'failed' ||
        task.lifecycleVersion !== request.expectedLifecycleVersion + 1 ||
        task.failureCode !== request.causeCode ||
        !task.failureAt ||
        work?.state !== 'running' ||
        work.causeCode !== request.causeCode ||
        work.leaseOwner !== request.leaseToken
      ) {
        throw error;
      }
      taskCommitted = true;
    }
    if (!taskCommitted) return false;

    const failure = taskFailureFromRecord({
      failureCode: request.causeCode,
      failureAt: occurredAt,
      failureExitCode: null,
    });
    if (!failure || 'runtime' in failure) {
      throw new Error('Durable admission produced an invalid safe failure');
    }
    // Phase 1 is already durable. Terminal audit is a required idempotent
    // boundary (unlike progress audit): if it cannot be confirmed, keep the
    // leased work running so expiry recovery retries before strict cleanup.
    await this.requireProvisioningFailureAudit(
      request.taskId,
      stage,
      request.attempt,
      failure,
    );

    this.guardrails?.fenceTerminal?.(request.taskId);
    if (!this.guardrails?.onDurableAdmissionTerminal) {
      throw new Error('Strict durable admission cleanup is unavailable');
    }
    await this.guardrails.onDurableAdmissionTerminal(
      request.taskId,
      request.leaseToken,
    );

    let workCommitted = false;
    try {
      const changed = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "task_admission_work" AS w
        SET
          "state" = 'failed',
          "lease_owner" = NULL,
          "lease_until" = NULL,
          "updated_at" = clock_timestamp()
        WHERE
          w."task_id" = ${request.taskId}
          AND w."state" = 'running'
          AND w."lease_owner" = ${request.leaseToken}
          AND w."lease_until" > clock_timestamp()
          AND w."cause_code" = ${request.causeCode}
          AND EXISTS (
            SELECT 1
            FROM "tasks" AS t
            WHERE
              t."id" = w."task_id"
              AND t."status"::text = 'failed'
              AND t."lifecycle_version" = ${
                request.expectedLifecycleVersion + 1
              }
          )
      `);
      workCommitted = changed === 1;
    } catch (error) {
      const work = await this.prisma.taskAdmissionWork.findUnique({
        where: { taskId: request.taskId },
        select: { state: true, causeCode: true },
      });
      if (
        work?.state !== 'failed' ||
        work.causeCode !== request.causeCode
      ) {
        throw error;
      }
      workCommitted = true;
    }
    if (!workCommitted) return false;

    this.taskAdmissionCancellation?.abortTask(request.taskId);
    return true;
  }

  async transitionForAdmission(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    userId?: string,
    transitionToken = randomUUID(),
  ): Promise<AdmissionTransitionResult> {
    return this.performAdmissionTransition(
      id,
      next,
      userId,
      transitionToken,
      false,
    );
  }

  /** Resolve/retry an ambiguous admission write without changing its winner token. */
  async reconcileAdmissionTransition(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    transitionToken: string,
    userId?: string,
  ): Promise<AdmissionTransitionResult> {
    return this.performAdmissionTransition(
      id,
      next,
      userId,
      transitionToken,
      true,
    );
  }

  /** True only while this exact running-CAS winner may start provider work. */
  async isAdmissionTransitionCurrent(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    transitionToken: string,
    lifecycleVersion?: number,
  ): Promise<boolean> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: {
        status: true,
        lifecycleVersion: true,
        queuedAdmissionToken: true,
        runningAdmissionToken: true,
      },
    });
    if (!task || task.status !== next) return false;
    if (
      lifecycleVersion !== undefined &&
      task.lifecycleVersion !== lifecycleVersion
    ) {
      return false;
    }
    return (
      (next === 'queued'
        ? task.queuedAdmissionToken
        : task.runningAdmissionToken) === transitionToken
    );
  }

  private async performAdmissionTransition(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    userId: string | undefined,
    transitionToken: string,
    resolvingIndeterminate: boolean,
  ): Promise<AdmissionTransitionResult> {
    let mustResolve = resolvingIndeterminate;

    for (;;) {
      let task: {
        status: TaskStatus;
        lifecycleVersion: number;
        queuedAdmissionToken: string | null;
        runningAdmissionToken: string | null;
      } | null;
      try {
        task = await this.prisma.task.findUnique({
          where: { id },
          select: {
            status: true,
            lifecycleVersion: true,
            queuedAdmissionToken: true,
            runningAdmissionToken: true,
          },
        }) as typeof task;
      } catch (err) {
        if (!mustResolve) throw err;
        throw new AdmissionTransitionIndeterminateError(id, next, transitionToken, err);
      }
      if (!task) throw new NotFoundException(`Task not found: ${id}`);

      const current = task.status as TaskStatus;
      const observedLifecycleVersion = task.lifecycleVersion;
      const persistedToken =
        next === 'queued'
          ? task.queuedAdmissionToken
          : task.runningAdmissionToken;

      if (persistedToken === transitionToken) {
        await this.recordAudit(() => this.audit?.recordTransition(id, next, userId));
        return current === next ? 'transitioned' : 'superseded';
      }
      if (current === next) return 'already-transitioned';

      // Admission owns only pending -> queued/running and queued -> running. A
      // later lifecycle state means another actor has already superseded this
      // attempt; it must never be moved backward or provisioned again.
      const eligible =
        next === 'queued'
          ? current === 'pending'
          : current === 'pending' || current === 'queued';
      if (!eligible) return 'superseded';
      assertTransition(current, next);

      let changed: { count: number };
      try {
        changed = await this.prisma.task.updateMany({
          where: {
            id,
            status: current,
            lifecycleVersion: observedLifecycleVersion,
          },
          data:
            next === 'queued'
              ? {
                  status: next,
                  lifecycleVersion: { increment: 1 },
                  queuedAdmissionToken: transitionToken,
                }
              : {
                  status: next,
                  lifecycleVersion: { increment: 1 },
                  runningAdmissionToken: transitionToken,
                },
        });
      } catch (err) {
        throw new AdmissionTransitionIndeterminateError(id, next, transitionToken, err);
      }

      if (changed.count === 1) {
        await this.recordAudit(() => this.audit?.recordTransition(id, next, userId));
        return 'transitioned';
      }

      // A competing CAS won after our read. Re-read under resolution semantics;
      // a transient read failure must not be mistaken for a safe local release.
      mustResolve = true;
    }
  }

  /**
   * Transitions a task into the distinct `agent_failed_to_start` state, used
   * when the agent process exits before it ever reaches a running state.
   */
  async markAgentFailedToStart(id: string): Promise<TaskResponse> {
    // Reuse the central status CAS so a concurrent stop/completion cannot be
    // overwritten by a stale agent-start failure.
    const updated = await this.transition(id, 'agent_failed_to_start');
    this.guardrails?.recordFailure(id, 'agent_failed_to_start');
    return updated;
  }

  /**
   * Operator-initiated stop (`POST /tasks/:taskId/stop`, task-guardrail-controls).
   * Transitions an ACTIVE task (`queued`/`running`/`awaiting_input`) to the
   * terminal `cancelled` state, which — via {@link transition}'s `isTerminal`
   * hook — runs `GuardrailsService.onTerminal`: sandbox teardown, session-scoped
   * credential destruction, and concurrency-slot release (admitting the next
   * queued task). This is the deliberate, operator-driven mechanism that replaces
   * automatic idle reclamation as the routine way to free a slot.
   *
   * Idempotent: stopping a task already in a terminal state is a safe no-op that
   * returns the task unchanged rather than corrupting state or double-releasing a
   * slot. A task that races to a terminal state between the read and the
   * transition is likewise surfaced as a no-op (the illegal `-> cancelled` edge
   * is swallowed and the current task returned).
   */
  async stop(id: string, userId?: string): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: TASK_RESPONSE_INCLUDE,
    });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }
    if (isTerminal(task.status as TaskStatus)) {
      // Already settled — no-op (never double-release a slot).
      return taskResponseSchema.parse(taskResponseFromRecord(task));
    }
    try {
      // `cancelled` is terminal, so transition() fires onTerminal (teardown +
      // slot release) and records the `task.cancelled` audit event centrally.
      return await this.transition(id, 'cancelled', userId);
    } catch (err) {
      if (err instanceof IllegalTaskTransitionError) {
        // Raced to a terminal state between the read and the transition — treat
        // as an idempotent no-op and return the now-current task.
        return this.findById(id);
      }
      throw err;
    }
  }

  /**
   * Run a best-effort audit recording call, guaranteeing it NEVER throws into the
   * lifecycle path (6.2). The recorder swallows its own persistence failures; this
   * is a defensive second layer so even a synchronous throw or rejected promise
   * from the optional recorder is caught and logged, never affecting the
   * create/transition path.
   */
  private async recordAudit(call: () => Promise<void> | undefined): Promise<void> {
    try {
      await call();
    } catch {
      // The recorder is outside the durable state boundary. Never interpolate
      // its rejected value because it may contain raw provider/Git diagnostics.
      this.logger.warn('audit record failed (swallowed)');
    }
  }

  private async requireProvisioningFailureAudit(
    taskId: string,
    stage: import('@cap/contracts').TaskProvisioningStage,
    attempt: number,
    failure: ProvisioningAuditFailure,
  ): Promise<void> {
    if (!this.audit) throw new DurableAdmissionTerminalAuditError();
    let recorded = false;
    try {
      recorded = await this.audit.recordProvisioningFailure(
        taskId,
        stage,
        attempt,
        failure,
      );
    } catch {
      // Keep the rejected value outside logs; the leased work remains the
      // retryable recovery marker for this durable terminal audit boundary.
    }
    if (!recorded) throw new DurableAdmissionTerminalAuditError();
  }

  private async resolveTaskCreateFoundation(
    repoId: string,
    body: CreateTaskBody,
    client: PrismaService,
    executionMode: ExecutionMode,
    userId?: string,
  ): Promise<Runtime> {
    const repo = await client.repo.findUnique({ where: { id: repoId } });
    if (!repo) throw new NotFoundException(`Repo not found: ${repoId}`);

    // add-claude-code-runtime (4.1): the runtime this create dispatches to. The
    // contract pipe has already rejected any value outside the allowed set with
    // 400 before the body reaches here, so this is either a valid runtime or
    // omitted; omitted resolves the default (`codex`) so existing clients are
    // unchanged.
    const runtime: Runtime = body.runtime ?? DEFAULT_TASK_RUNTIME;

    // add-claude-code-runtime (4.1): RESOLVE the selected runtime so admission
    // dispatches to the right agent. An unknown id throws (a wiring bug, not a
    // valid create), which we fail closed rather than admitting a task that
    // resolves no runtime. When the registry is not wired the persisted `runtime`
    // column the provider reads is the dispatch source of truth.
    if (this.runtimes) {
      try {
        this.runtimes.resolve(runtime);
      } catch {
        throw new RuntimeNotConfiguredException(runtime);
      }
    }

    // add-headless-execution-track (5.4): a programmatic (headless-exec) task whose
    // resolved runtime does not support headless-exec is rejected with a distinct reason
    // — never silently fall back to the interactive launch for a fire-and-forget
    // consumer. (Both shipped runtimes support headless; this guards a future one.)
    if (
      executionMode === 'headless-exec' &&
      this.runtimes &&
      !this.runtimes.resolve(runtime).executionModes.has('headless-exec')
    ) {
      throw new BadRequestException(
        `runtime "${runtime}" does not support headless execution`,
      );
    }

    // add-claude-code-runtime (4.2): FAIL CLOSED before any task row is created
    // when a `claude-code` create selects an unconfigured runtime — never launch
    // an unauthenticated agent. Distinct reason (`runtime not configured`) so the
    // console can tell this apart from a generic failure. Codex degrades to
    // unauthenticated (its prior behavior) and is NOT gated here. When the
    // readiness source is not wired the gate is skipped and the provision-time
    // `injectAuth` remains the fail-closed backstop.
    if (runtime === 'claude-code' && this.claudeReadiness) {
      if (!userId) throw new RuntimeNotConfiguredException(runtime);
      const ready = await this.claudeReadiness.configured(userId);
      if (!ready) {
        throw new RuntimeNotConfiguredException(runtime);
      }
    }

    return runtime;
  }

  private async selectTaskEnvironment(
    body: CreateTaskBody,
    userId: string | undefined,
    client: PrismaService,
  ): Promise<SandboxEnvironmentSelection> {
    let environmentSelection: SandboxEnvironmentSelection;
    if (body.sandboxEnvironmentId === undefined) {
      const ownerDefaultId = await this.loadUserDefaultSandboxEnvironmentId(
        userId,
        client,
      );
      environmentSelection = ownerDefaultId
        ? { kind: 'managed', environmentId: ownerDefaultId }
        : { kind: 'managed-default' };
    } else if (body.sandboxEnvironmentId === null) {
      environmentSelection = { kind: 'deployment-default' };
    } else {
      environmentSelection = {
        kind: 'managed',
        environmentId: body.sandboxEnvironmentId,
      };
    }

    return environmentSelection;
  }

  private async resolveDurableTaskAdmission(
    selection: SandboxEnvironmentSelection,
    runtime: Runtime,
    providerFamily?: SandboxEnvironmentProviderFamily,
    resources?: SandboxResourceSnapshot,
  ) {
    if (!this.sandboxEnvironments) {
      throw new Error(
        'Durable task admission environment resolution is unavailable',
      );
    }
    return this.sandboxEnvironments.resolveTaskAdmission({
      selection,
      runtimeId: runtime,
      ...(providerFamily ? { providerFamily } : {}),
      ...(resources ? { resources } : {}),
    });
  }

  private async resolveTaskEnvironment(args: {
    selection: SandboxEnvironmentSelection;
    runtime: Runtime;
  }) {
    if (!this.sandboxEnvironments) {
      if (args.selection.kind === 'managed') {
        throw new BadRequestException({
          error: 'sandbox_environment_unavailable',
          message: 'Sandbox environment resolution is not available.',
        });
      }
      return null;
    }
    return this.sandboxEnvironments.resolveForTask({
      selection: args.selection,
      runtimeId: args.runtime,
    });
  }

  private async loadUserDefaultSandboxEnvironmentId(
    userId: string | undefined,
    client: Pick<PrismaService, 'accountSettings'>,
  ): Promise<string | null> {
    if (!userId) return null;
    const row = await client.accountSettings.findUnique({
      where: { userId },
      select: { defaultSandboxEnvironmentId: true },
    });
    return row?.defaultSandboxEnvironmentId ?? null;
  }

}

function modelErrorContext(runtime: Runtime, body: CreateTaskBody) {
  return {
    runtime,
    model: body.model,
    ...(Object.prototype.hasOwnProperty.call(body, 'sandboxEnvironmentId')
      ? { sandboxEnvironmentId: body.sandboxEnvironmentId }
      : {}),
  };
}

function executionSnapshotResources(
  snapshot: PreparedTaskCreate['executionEnvironmentSnapshot'],
): SandboxResourceSnapshot | undefined {
  return snapshot?.resources;
}

function isValidWorkspaceMaterializationDeadline(
  value: unknown,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >=
      SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN &&
    (value as number) <= SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX
  );
}

function sameSandboxResources(
  left: SandboxResourceSnapshot | null | undefined,
  right: SandboxResourceSnapshot | null | undefined,
): boolean {
  const normalizedLeft = snapshotSandboxResources(left ?? {});
  const normalizedRight = snapshotSandboxResources(right ?? {});
  return normalizedLeft?.diskSizeGb === normalizedRight?.diskSizeGb;
}

export { IllegalTaskTransitionError };
