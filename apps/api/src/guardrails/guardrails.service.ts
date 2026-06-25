import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { TaskStatus } from '@cap/contracts';
import { TasksService } from '../tasks/tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  SANDBOX_PROVIDER,
  type SandboxConnection,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import {
  buildSandboxProvisionPlan,
  forceFailSettlePlan,
  selectDeliverySandboxProvider,
  selectSandboxProvider,
  terminalSettlePlan,
  type SandboxSettlePlan,
} from '../sandbox/sandbox-scheduler';
import type { ProvisionLookup } from '../sandbox/provision-lookup.port';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '../audit/audit-recorder.port';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { ConcurrencySemaphore } from './semaphore';
import { DeadlineWatcher } from './deadline-watcher';
import { IdleTracker } from './idle-tracker';
import { CircuitBreaker, type FailureKind } from './circuit-breaker';
import type { SemaphoreProjectionSource } from '../metrics/metrics-projection';
import {
  RunnerMinutesLedger,
  type RunningInterval,
} from '../metrics/runner-minutes';
import { runWithTaskLog } from '../observability/log-context';

/**
 * Guardrails integration (integration 12.1b).
 *
 * Composes the four self-contained guardrail classes — the concurrency semaphore
 * (12.1), wall-clock deadline watcher (12.2), idle tracker (12.3), and start/turn
 * circuit breaker (12.4) — and WIRES their cross-track call sites:
 *
 *  - admit-queued: the semaphore's `onAdmit` callback drives the lifecycle
 *    `queued -> running` transition for the oldest queued task when a slot frees.
 *  - force-fail + teardown + slot-release: the deadline / idle / circuit-breaker
 *    callbacks transition the task to `failed`, tear down its session-scoped
 *    credentials (the primary safety boundary), and release its concurrency slot
 *    (which may admit the next queued task). Under the connect-in model there is
 *    no per-task `TASK_TOKEN` to revoke — the session-scoped credentials are the
 *    sole authentication boundary.
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
  openSession(connection: SandboxConnection): unknown;
  /** Remove a task's terminal session (e.g. on completion/teardown). */
  unregisterSession(taskId: string): void;
  /**
   * Sample the tail of a task's API-side `session.log` for the failure-detail
   * audit (record-task-failure-reason). Returns `''` when no transcript exists;
   * never throws. Reads the API-side log, so it works after sandbox teardown.
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
}

/** Defaults sourced from env at module construction; safe for local/dev. */
export const DEFAULT_GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 5,
  // Idle reclamation is OPT-IN and OFF by default: no implicit ceiling. An
  // operator sets `MAX_IDLE_MS` for a global default, or a task supplies its own
  // `idleTimeoutMs`; with neither, a task is never force-failed for idleness.
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};

/**
 * Optional per-task guardrail parameters supplied at admission. Both are opt-in:
 * an absent `idleTimeoutMs` leaves idle reclamation to the operator-level default
 * (off when unset); an absent `deadlineMs` means no wall-clock deadline.
 */
export interface GuardrailParams {
  /** Wall-clock deadline in ms from admission; absent ⇒ no deadline. */
  readonly deadlineMs?: number;
  /** Per-task idle ceiling in ms; absent ⇒ operator-level default (off when unset). */
  readonly idleTimeoutMs?: number;
}

@Injectable()
export class GuardrailsService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(GuardrailsService.name);

  /**
   * `TasksService` is resolved lazily in {@link onModuleInit} (not injected in the
   * constructor) to BREAK the Tasks<->Guardrails construction cycle: TasksService
   * @Optional-injects GuardrailsService (GUARDRAILS_SERVICE_TOKEN), and a
   * constructor-time dependency back on TasksService made NestFactory.create()
   * deadlock — the app silently exited 0 mid-bootstrap (no listen). Resolving it
   * after all providers are instantiated gives both sides the real instance.
   */
  private tasks!: TasksService;

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

  private readonly semaphore: ConcurrencySemaphore;
  private readonly deadlines: DeadlineWatcher;
  private readonly idle: IdleTracker;
  private readonly breaker: CircuitBreaker;
  /**
   * Operator-level default idle ceiling (ms) for tasks created without a per-task
   * `idleTimeoutMs`; `null` ⇒ no default (idle reclamation off unless opted in).
   */
  private readonly defaultIdleTimeoutMs: number | null;
  /**
   * Guardrail params ({deadlineMs?, idleTimeoutMs?}) parked for tasks admitted to
   * `queued` (no free slot at admit time). The semaphore's `AdmitCallback` is
   * taskId-only, so the params are stashed here at `admit()` and consumed when the
   * task is later promoted `queued -> running` in {@link onAdmit} — so a
   * queued-then-admitted task still arms its deadline/idle watchers, not only a
   * task that runs immediately.
   */
  private readonly pendingGuardrails = new Map<string, GuardrailParams>();

  /**
   * Per-process ledger of task running intervals (admission→terminal), the
   * source for the DERIVED runner-minutes metric (be-metrics 5.4). The
   * guardrails service is the admission/terminal seam, so it is the natural
   * place to observe RUNNING durations; the `Task` table persists only
   * `createdAt`, so this timing is observed in-process and resets on restart —
   * which is exactly why the metric is labeled derived accounting, not billing.
   */
  private readonly runnerMinutes = new RunnerMinutesLedger();

  /**
   * The addressable {@link SandboxConnection} handle returned by `provision()`
   * for each running task, keyed by taskId. Captured at `startRunning` (4.1) so
   * the terminal gateway can open an `AioPtyClient` to `connection.wsUrl`; the
   * integration track hands this handle through to the gateway (4.2). Cleared on
   * teardown when the task settles.
   */
  private readonly connections = new Map<string, SandboxConnection>();

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
     * constructs without it; when absent, transitions proceed unaudited. Every
     * call is fire-and-forget and the recorder never throws (6.2), so it can never
     * affect a transition.
     */
    @Optional()
    @Inject(AUDIT_RECORDER_TOKEN)
    private readonly audit?: AuditRecorderPort,
    /**
     * Prisma client for the bootstrap-time persisted-ceiling read
     * (configurable-task-slots). Optional so guardrails-only unit contexts
     * still construct without a database; when absent,
     * {@link loadPersistedCeiling} degrades to the env-seeded ceiling. The
     * admission hot path NEVER touches it — the in-memory ceiling is
     * authoritative and is written only at bootstrap load and on a
     * settings-save push.
     */
    @Optional()
    private readonly prisma?: PrismaService,
    /**
     * Best-effort durable transcript capture (persist-session-transcripts 3.1),
     * supplied under {@link TRANSCRIPT_SERVICE_TOKEN} by the Integration track
     * (I.2) from the already-imported `TasksModule`. Optional so guardrails-only
     * unit contexts still construct without it; when absent, the terminal
     * chokepoints skip capture and proceed exactly as before. The provider is
     * best-effort by contract, but the call sites wrap it defensively so even a
     * surprise throw can never block a terminal transition / teardown / slot release.
     */
    @Optional()
    @Inject(TRANSCRIPT_SERVICE_TOKEN)
    private readonly transcripts?: ITranscriptCapture,
  ) {
    // admit-queued: when a slot frees, drive `queued -> running` for the admitted
    // task (FIFO) — the cross-track lifecycle call site for 12.1.
    this.semaphore = new ConcurrencySemaphore({
      maxConcurrentTasks: config.maxConcurrentTasks,
      onAdmit: (taskId) => void this.onAdmit(taskId),
    });

    // Operator-level idle default (off when null); per-task idleTimeoutMs overrides.
    this.defaultIdleTimeoutMs = config.defaultIdleTimeoutMs;

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
   * Resolve `TasksService` and the terminal gateway after all providers are
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
    this.tasks = this.moduleRef.get(TasksService, { strict: false });
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
    } catch {
      // Forge module not wired in this context — result delivery is skipped.
      this.forgeResolver = undefined;
      this.forgeRegistry = undefined;
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
      if (persisted !== undefined && Number.isInteger(persisted) && persisted >= 1) {
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
   * Offer a newly created task to the concurrency semaphore (12.1). When a slot
   * is free the task is admitted to `running` and its guardrail timers are armed;
   * otherwise it is held `queued` (no sandbox provisioned) and its lifecycle is
   * moved to `queued`. Returns the admission outcome.
   */
  async admit(taskId: string, params: GuardrailParams = {}): Promise<'running' | 'queued'> {
    const outcome = this.semaphore.offer(taskId);
    if (outcome === 'running') {
      await this.startRunning(taskId, params);
    } else {
      // Park the guardrail params so they arm when the slot frees and this queued
      // task is promoted to running (onAdmit), not silently dropped.
      if (params.deadlineMs !== undefined || params.idleTimeoutMs !== undefined) {
        this.pendingGuardrails.set(taskId, params);
      }
      await this.safeTransition(taskId, 'queued');
    }
    return outcome;
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
   *  - re-inserts the task into the semaphore running set via `offer()` so the
   *    slot is re-accounted (at boot the running set starts empty, so each
   *    re-adopt takes a slot; this is what reduces the capacity the later queued
   *    re-offer admits against). Idempotent: a re-offer of an already-running
   *    task is a no-op in the semaphore.
   *  - captures the connection handle (so terminal reconnect / teardown find it)
   *    and hands it to the terminal gateway, whose `openSession` ATTACHES to the
   *    live named session rather than launching fresh (Track 2 D2). Best-effort:
   *    a terminal-wiring hiccup never fails the re-adoption.
   *  - re-arms the idle tracker (when an effective ceiling exists) and the
   *    deadline watcher from the PERSISTED `deadlineMs`/`idleTimeoutMs`, identical
   *    to a task admitted before the restart, and re-opens the runner-minutes
   *    interval so the derived accounting resumes.
   */
  readopt(
    taskId: string,
    connection: SandboxConnection,
    params: GuardrailParams = {},
  ): void {
    // Re-account the slot. At boot the running set is empty so this takes a slot;
    // idempotent if the same task is re-adopted twice. This is the slot the later
    // queued re-offer's capacity is reduced by.
    this.semaphore.offer(taskId);
    // Capture the still-valid handle so terminal reconnect + teardown resolve it.
    this.connections.set(taskId, connection);
    // Re-attach the terminal: openSession ATTACHES to the live named session
    // (Track 2 D2) rather than launching a fresh codex. Best-effort.
    if (this.gateway) {
      try {
        this.gateway.openSession(connection);
      } catch (err: unknown) {
        this.logger.error(
          `re-attaching terminal session for re-adopted task ${taskId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Re-arm the idle ceiling (opt-in: only when a per-task or operator-level
    // ceiling exists) and the wall-clock deadline from the persisted values.
    const idleMs = params.idleTimeoutMs ?? this.defaultIdleTimeoutMs ?? undefined;
    if (idleMs !== undefined) {
      this.idle.start(taskId, idleMs);
    }
    if (params.deadlineMs !== undefined) {
      this.deadlines.armAfter(taskId, params.deadlineMs);
    }
    // Resume the runner-minutes interval for the re-adopted running task (5.4).
    this.runnerMinutes.recordStart(taskId);
    this.logger.log(`re-adopted running task ${taskId} (slot held, timers re-armed)`);
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
      // Abnormal exit: the sandbox died unexpectedly (WS closed before the session
      // was established, container killed, OOM, or an unresolvable exit code). A
      // dead sandbox cannot recover, so force-fail the task now to release its
      // concurrency slot and admit the next queued task. `safeTransition` and
      // `semaphore.release` tolerate double-calls, so this is safe even when a
      // teardown was already triggered for the same task.
      // record-task-failure-reason: capture the exit code + transcript tail
      // BEFORE teardown so an abnormal failure is diagnosable (best-effort).
      void this.recordExitDetail(taskId, status);
      void this.forceFail(taskId, 'abnormal_exit');
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
      void this.recordExitDetail(taskId, status);
      void this.safeTransition(taskId, 'failed');
    }
    });
  }

  /**
   * Emit the `task.exited` failure-detail audit (exit code + mapped reason +
   * sampled transcript tail) for a non-success exit (record-task-failure-reason).
   * Fire-and-forget + best-effort: it reads the API-SIDE `session.log` tail (so
   * it works after sandbox teardown) and records a DETAIL event ALONGSIDE the
   * central `task.failed` transition. ANY failure is swallowed so it can never
   * affect the lifecycle transition, teardown, or slot release.
   */
  private async recordExitDetail(taskId: string, status: ExitStatus): Promise<void> {
    if (!this.audit) return;
    try {
      const tail = (await this.gateway?.readSessionLogTail(taskId)) ?? '';
      await this.audit.recordExited(taskId, status.code, status.abnormal, tail);
    } catch (err) {
      this.logger.debug(
        `exit-detail audit for task ${taskId} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
   * unconditionally. A no-op when no transcript provider is wired (e.g. a
   * guardrails-only unit context).
   */
  private async captureTranscript(taskId: string): Promise<void> {
    if (!this.transcripts) return;
    try {
      await this.transcripts.capture(taskId);
    } catch (err) {
      this.logger.warn(
        `transcript capture for task ${taskId} failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
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

  /**
   * A task reached a terminal state on its own (completion/failure). Clear its
   * guardrail timers, tear down its session credentials, and release its slot —
   * which admits the next queued task if any (12.1 slot-release; session-end
   * teardown). Idempotent.
   */
  async onTerminal(taskId: string): Promise<void> {
    this.clearTimers(taskId);
    // Close the runner-minutes interval (no-op if the task never ran) (5.4).
    this.runnerMinutes.recordEnd(taskId);
    await this.settleTask(taskId, terminalSettlePlan());
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
    if (plan.captureTranscript) {
      await this.captureTranscript(taskId);
    }
    if (plan.deliverWorkspace) {
      await this.deliverResult(taskId);
    }
    if (plan.teardownSandbox && this.sandbox) {
      await this.sandbox.teardownSandbox(taskId).catch((err: unknown) => {
        this.logger.warn(
          `sandbox teardown for task ${taskId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
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
        authHeader: forge.cloneAuthHeader(target),
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
      const baseBranch = task.branch ?? (await forge.resolveBaseBranch(target));
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
    } catch (err) {
      this.logger.warn(
        `result delivery for task ${taskId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
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

  /** Admit a previously-queued task: `queued -> running` + arm timers (12.1). */
  private async onAdmit(taskId: string): Promise<void> {
    // Consume the guardrail params parked at admit() so a queued-then-admitted
    // task arms its deadline/idle watchers just like one that ran immediately.
    const parked = this.pendingGuardrails.get(taskId) ?? {};
    this.pendingGuardrails.delete(taskId);
    await this.startRunning(taskId, parked);
  }

  /** Transition to `running`, arm the idle tracker (if opted in) and deadline (if any). */
  private async startRunning(taskId: string, params: GuardrailParams = {}): Promise<void> {
    await this.safeTransition(taskId, 'running');
    // Idle tracking is OPT-IN: arm only when an effective ceiling exists — the
    // task's own `idleTimeoutMs`, else the operator-level default. With neither,
    // the task is NOT idle-tracked and is never force-failed for idleness, so a
    // legitimately long, quiet task is not reclaimed.
    const idleMs = params.idleTimeoutMs ?? this.defaultIdleTimeoutMs ?? undefined;
    if (idleMs !== undefined) {
      this.idle.start(taskId, idleMs);
    }
    // Begin the runner-minutes interval the moment the task enters RUNNING (5.4).
    this.runnerMinutes.recordStart(taskId);
    if (params.deadlineMs !== undefined) {
      this.deadlines.armAfter(taskId, params.deadlineMs);
    }
    // Provision the execution sandbox under the connect-in model: `provision()`
    // creates the per-task AIO container and returns an addressable
    // `SandboxConnection` the orchestrator dials by container name on `cap-net` —
    // there is no dial-back to authenticate, so NO per-task TASK_TOKEN is minted.
    // The returned handle is captured (stashed by taskId) AND handed to the
    // terminal gateway, which opens an `AioPtyClient` to `connection.wsUrl` and
    // registers the `TerminalSession` (4.2). Best-effort: a provision failure is
    // logged, not fatal to the lifecycle transition.
    const sandbox = this.sandbox;
    if (sandbox) {
      const provisionPlan = await this.resolveProvisionPlan(taskId).catch(
        (err: unknown) => {
          this.logger.error(
            `resolve sandbox requirements for task ${taskId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        },
      );
      if (!provisionPlan) {
        await this.forceFail(taskId, 'provision_failed');
        return;
      }

      const selected = await Promise.resolve()
        .then(() =>
          selectSandboxProvider(sandbox, provisionPlan.requiredCapabilities),
        )
        .catch((err: unknown) => {
          this.logger.error(
            `select sandbox provider for task ${taskId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        });
      if (!selected) {
        await this.forceFail(taskId, 'provision_failed');
        return;
      }

      const connection = await selected.provider
        .provision({ taskId, cloneSpec: provisionPlan.cloneSpec })
        .catch((err: unknown) => {
          this.logger.error(
            `provision sandbox for task ${taskId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        });
      if (connection) {
        this.connections.set(taskId, connection);
        // 4.2 — hand the handle through to the terminal gateway so it dials the
        // sandbox terminal OUT and registers the session (replacing the previous
        // dial-back-registers-the-session flow). Idempotent on the gateway side;
        // best-effort so a terminal wiring hiccup never fails the lifecycle.
        if (this.gateway) {
          try {
            this.gateway.openSession(connection);
          } catch (err: unknown) {
            this.logger.error(
              `opening terminal session for task ${taskId} failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } else {
        // provision REJECTED (or returned no handle): the provider already tore
        // down any partially-started container (its own try/catch). Reclaim NOW
        // instead of waiting for the idle ceiling — forceFail transitions the
        // task to `failed`, clears its timers, tears down the session, and
        // RELEASES the run slot (admitting the next queued task). Without this
        // the slot stays held until idle-timeout, starving the queue whenever a
        // provision fails (e.g. codex auth / clone fail-closed).
        await this.forceFail(taskId, 'provision_failed');
      }
    }
  }

  private async resolveProvisionPlan(taskId: string) {
    const cloneSpec = await this.provisionLookup?.getCloneSpec(taskId);
    return buildSandboxProvisionPlan({ cloneSpec });
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
  ): Promise<void> {
    // structured-logging: bind taskId for all force-fail logs (incl. timer-driven
    // deadline/idle/circuit_breaker entrypoints that run outside any request).
    return runWithTaskLog(taskId, async () => {
      // An idle ceiling on a RESIDENT session is a graceful end of life —
      // reclaim it as `completed`, not a force-`failed`. Every other cause stays
      // a failure. The capture / stop-only teardown / slot-release below is
      // identical for both.
      const terminal: 'completed' | 'failed' = cause === 'idle' ? 'completed' : 'failed';
      this.logger.warn(
        `${terminal === 'completed' ? 'reclaiming idle task' : 'force-failing task'} ${taskId} (${cause})`,
      );
      this.clearTimers(taskId);
      // Close the runner-minutes interval on the forced-failure terminal too (5.4).
      this.runnerMinutes.recordEnd(taskId);
      // 6.2 — record the force-fail naming its CAUSE (deadline / idle /
      // circuit_breaker), so the timeline shows WHY the task was reclaimed. The
      // generic `task.failed` transition is also recorded centrally by the tasks
      // service when the `failed` write below is accepted; the two are distinct
      // events (the terminal transition + its cause).
      // The cause-specific `recordForceFailed` event is only for actual failures;
      // an idle reclamation to `completed` relies on the central `task.completed`
      // audit emitted by the status-write chokepoint.
      if (terminal === 'failed') {
        await this.recordAudit(() => this.audit?.recordForceFailed(taskId, cause));
      }
      await this.safeTransition(taskId, terminal);
      await this.settleTask(taskId, forceFailSettlePlan({ terminal }));
    });
  }

  /** Clear deadline + idle timers for a task (it has settled). */
  private clearTimers(taskId: string): void {
    this.deadlines.clear(taskId);
    this.idle.stop(taskId);
    // Drop any guardrail params parked while the task was queued but never promoted.
    this.pendingGuardrails.delete(taskId);
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
  private async safeTransition(taskId: string, next: TaskStatus): Promise<void> {
    try {
      await this.tasks.transition(taskId, next);
    } catch (err) {
      this.logger.debug(
        `guardrail transition ${taskId} -> ${next} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    } catch (err) {
      this.logger.debug(
        `guardrail audit record failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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

  // -------------------------------------------------------------------------
  // Metrics projection sources (be-metrics 5.1 / 5.2 / 5.4)
  // -------------------------------------------------------------------------

  /**
   * A LIVE, read-only projection source over the concurrency semaphore for the
   * derived capacity block (5.1 / 5.2). Every property/method delegates directly
   * to the semaphore, so a `/metrics` read reflects the exact admission state at
   * request time — there is NO parallel counter that could drift. The metrics
   * layer's pure projection/slot-table builders consume this view.
   */
  semaphoreProjection(): SemaphoreProjectionSource {
    const semaphore = this.semaphore;
    return {
      get maxConcurrentTasks() {
        return semaphore.maxConcurrentTasks;
      },
      get runningCount() {
        return semaphore.runningCount;
      },
      get queuedCount() {
        return semaphore.queuedCount;
      },
      snapshotRunning: () => semaphore.snapshotRunning(),
      snapshotQueue: () => semaphore.snapshotQueue(),
    };
  }

  /** Observed running intervals for the derived runner-minutes metric (5.4). */
  runnerMinuteIntervals(): RunningInterval[] {
    return this.runnerMinutes.intervals();
  }
}
