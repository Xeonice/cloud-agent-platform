import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DEFAULT_TASK_RUNTIME,
  taskResponseSchema,
  type CreateTaskBody,
  type Runtime,
  type TaskResponse,
  type TaskStatus,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  IllegalTaskTransitionError,
  assertTransition,
  isTerminal,
  toAgentFailedToStart,
} from './task-lifecycle';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '../audit/audit-recorder.port';
import {
  SANDBOX_PROVIDER,
  type SandboxConnection,
} from '../sandbox/sandbox-provider.port';

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
    params?: { deadlineMs?: number; idleTimeoutMs?: number },
  ): Promise<'running' | 'queued'>;
  onTerminal(taskId: string): Promise<void>;
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
  ): void;
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
}

/** DI token used when injecting the guardrails service into the tasks service. */
export const GUARDRAILS_SERVICE_TOKEN = 'GUARDRAILS_SERVICE';

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
  listReadoptable?(): Promise<string[]>;
  reattach?(taskId: string): Promise<SandboxConnection | undefined>;
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
  resolve(runtime: Runtime | null | undefined): { id: Runtime };
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
  configured(): Promise<boolean>;
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
export class TasksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TasksService.name);

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
  ) {}

  /**
   * THREE-phase startup recovery (configurable-task-slots 6.1 +
   * survive-api-redeploy guardrails-recovery 4.2) so a process restart never
   * strands work AND never needlessly kills a still-running task.
   *
   * Phase 0 (re-adopt): codex now runs in a DETACHED tmux session that outlives
   * the api, so a task whose `cap-aio-*` container AND `task<taskId>` session
   * survived the restart is RE-ADOPTED — the provider re-registers its tracking
   * and the guardrails service re-accounts the slot + re-arms the deadline/idle
   * watchers from the persisted params — and KEPT in its current
   * `running`/`awaiting_input` state, NOT failed. Runs FIRST so the slots it
   * holds reduce the capacity the later re-offer admits against.
   *
   * Phase 1 (reclaim): a `running`/`awaiting_input` task that was NOT re-adopted
   * in Phase 0 (its sandbox/session did not survive) holds in-memory
   * runner/guardrail state that is gone after the restart and can never resume,
   * so it is transitioned to `failed` rather than left lingering with a dead
   * session.
   *
   * Ceiling-first ordering (6.2): between the phases, the persisted system-level
   * slot ceiling is loaded into the live semaphore, so Phase 2 admits against
   * the persisted value rather than the env seed (persisted 2, env 5, 3 queued
   * ⇒ exactly 2 admitted, minus any re-adopted slots). Best-effort: a load
   * failure logs and falls through — re-offering against the env seed beats
   * stranding the queue.
   *
   * Phase 2 (re-offer): DB `queued` tasks survived the restart as data but lost
   * their in-memory semaphore entry; they are re-offered FIFO so the oldest fit
   * the REMAINING capacity (after re-adopted tasks hold their slots) begin
   * admission and the remainder stay queued in order.
   */
  async onApplicationBootstrap(): Promise<void> {
    const readopted = await this.readoptSurvivorsOnStartup();
    await this.reclaimOrphanedOnStartup(readopted);
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
    await this.reofferQueuedOnStartup();
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
   * them. Best-effort + fully optional: no provider / no `listReadoptable` / no
   * `guardrails.readopt` makes this a no-op (recovery degrades to the prior
   * reclaim + re-offer), and a per-task failure is logged and skipped, never
   * blocking boot.
   */
  async readoptSurvivorsOnStartup(): Promise<Set<string>> {
    const readopted = new Set<string>();
    if (!this.sandbox?.listReadoptable || !this.guardrails?.readopt) {
      return readopted;
    }
    let candidates: string[];
    try {
      candidates = await this.sandbox.listReadoptable();
    } catch (err) {
      this.logger.warn(
        `startup re-adopt: could not list re-adoptable sandboxes (none re-adopted): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return readopted;
    }
    for (const taskId of candidates) {
      try {
        // Pull the still-valid connection handle (provider re-registers its maps).
        const connection = await this.sandbox.reattach?.(taskId);
        if (!connection) {
          // Raced to gone between the list and the reattach — let Phase 1 fail it.
          continue;
        }
        // Restore the persisted per-task guardrail params (null -> undefined, so
        // a re-adopted task arms identically to one admitted before the restart).
        const row = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { deadlineMs: true, idleTimeoutMs: true },
        });
        this.guardrails.readopt(taskId, connection, {
          deadlineMs: row?.deadlineMs ?? undefined,
          idleTimeoutMs: row?.idleTimeoutMs ?? undefined,
        });
        // KEEP the task in its current state — NO transition to failed.
        readopted.add(taskId);
      } catch (err) {
        this.logger.warn(
          `startup re-adopt: could not re-adopt task ${taskId} (will be reclaimed): ${
            err instanceof Error ? err.message : String(err)
          }`,
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
  ): Promise<number> {
    const orphaned = await this.prisma.task.findMany({
      where: { status: { in: ['running', 'awaiting_input'] } },
      select: { id: true },
    });
    let reclaimed = 0;
    for (const { id } of orphaned) {
      // Re-adopted survivors are kept in their current state, not failed.
      if (readopted.has(id)) {
        continue;
      }
      try {
        await this.transition(id, 'failed');
        reclaimed += 1;
      } catch (err) {
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
   * DB `queued` task to the in-memory concurrency semaphore in `createdAt asc`
   * (FIFO) order, restoring each task's persisted per-task guardrail parameters
   * (`deadlineMs`, `idleTimeoutMs`) from its task row — zero new columns, since
   * task-guardrail-controls already persisted them. `admit()` arms the deadline
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
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, deadlineMs: true, idleTimeoutMs: true },
    });
    let reoffered = 0;
    for (const task of queued) {
      try {
        await this.guardrails.admit(task.id, {
          deadlineMs: task.deadlineMs ?? undefined,
          idleTimeoutMs: task.idleTimeoutMs ?? undefined,
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
    githubId?: number,
  ): Promise<TaskResponse> {
    const repo = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!repo) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

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

    // add-claude-code-runtime (4.2): FAIL CLOSED before any task row is created
    // when a `claude-code` create selects an unconfigured runtime — never launch
    // an unauthenticated agent. Distinct reason (`runtime not configured`) so the
    // console can tell this apart from a generic failure. Codex degrades to
    // unauthenticated (its prior behavior) and is NOT gated here. When the
    // readiness source is not wired the gate is skipped and the provision-time
    // `injectAuth` remains the fail-closed backstop.
    if (runtime === 'claude-code' && this.claudeReadiness) {
      const ready = await this.claudeReadiness.configured();
      if (!ready) {
        throw new RuntimeNotConfiguredException(runtime);
      }
    }

    const task = await this.prisma.task.create({
      data: {
        repoId,
        prompt: body.prompt,
        // add-claude-code-runtime (4.1): persist the selected runtime so it is
        // durable and readable on every later read path AND so the provider
        // dispatches to the right agent at provision time. Coalesce `undefined`
        // (omitted) to `null`; a null column reads back as the default `codex`
        // (repo-and-task-management: a prior task with no runtime reads as codex).
        runtime: body.runtime ?? null,
        // 3.2: persist the optional run parameters from the create body so they
        // are durable and readable on every later read path. They are inert with
        // respect to clone/provision/lifecycle behavior. Coalesce `undefined`
        // (field omitted) to `null` so the stored value is the supplied value or
        // an explicit null — never stale/fabricated on read-back (3.3).
        branch: body.branch ?? null,
        strategy: body.strategy ?? null,
        // task-preinstall-skills: persist the selected skill ids (inert, like
        // branch/strategy). Omitted ⇒ empty array (the column default), echoed
        // back on every read path. Validation against the server allowlist
        // happens at provision time, not here (storage is permissive).
        skills: body.skills ?? [],
        // task-guardrail-controls: persist the optional guardrail parameters.
        // They are consumed at admission (arming the idle/deadline watchers) AND
        // persisted so the configured value is readable on every task read path.
        // Coalesce `undefined` (omitted) to `null` — never stale/fabricated; a
        // null `idleTimeoutMs` means "no idle reclaim" (opt-in, off by default).
        idleTimeoutMs: body.idleTimeoutMs ?? null,
        deadlineMs: body.deadlineMs ?? null,
        // Initial status is the schema default (`pending`).
      },
    });

    // Under the connect-in model there is NO per-task TASK_TOKEN minted at
    // creation: the orchestrator dials the per-task AIO sandbox by container name
    // on `cap-net`, so there is no dial-back to authenticate (token issuance +
    // the dial-back verifier were removed with the runner, migrate-aio 7.4).

    // 6.2 — record the creation audit event (201/info), attributed to the
    // creating operator's GitHub identity when known. Emitted BEFORE `admit()` so
    // the `task.created` event precedes any `task.running`/`task.queued` event
    // for this task in the timeline. Best-effort: never blocks creation.
    await this.recordAudit(() => this.audit?.recordTaskCreated(task.id, githubId));

    // VR.1 — offer the newly created task to the guardrails concurrency semaphore
    // so the FIFO semaphore actually bounds running tasks. When a slot is free the
    // semaphore transitions the task to `running` and arms its deadline + idle
    // timers; otherwise it holds the task in `queued` (no sandbox provisioned).
    if (this.guardrails) {
      // VR.11 — plumb the optional guardrail params through so the deadline and
      // idle watchers arm (`startRunning → deadlines.armAfter` / `idle.start`).
      // Idle is OPT-IN: an omitted `idleTimeoutMs` leaves reclamation to the
      // operator-level default (off when unset), so the task is not reclaimed.
      await this.guardrails
        .admit(task.id, {
          deadlineMs: body.deadlineMs,
          idleTimeoutMs: body.idleTimeoutMs,
        })
        .catch((err: unknown) => {
        this.logger.warn(
          `guardrails admit for task ${task.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return taskResponseSchema.parse(this.toResponse(task));
  }

  async list(): Promise<TaskResponse[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return tasks.map((task) => taskResponseSchema.parse(this.toResponse(task)));
  }

  async findById(id: string): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }
    return taskResponseSchema.parse(this.toResponse(task));
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
    githubId?: number,
  ): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }

    // Validates the edge; throws on an illegal transition so we never write.
    assertTransition(task.status as TaskStatus, next);

    const updated = await this.prisma.task.update({
      where: { id },
      data: { status: next },
    });

    // 6.2 — the status write was ACCEPTED (an illegal edge would have thrown
    // above, before any write): record one audit event for this transition,
    // attributed to the operator's GitHub identity when known. This is the single
    // central per-transition seam every status-changing caller funnels through.
    // Best-effort: never rolls back or blocks the transition.
    await this.recordAudit(() => this.audit?.recordTransition(id, next, githubId));

    // VR.5 — on any natural terminal transition (completed / failed /
    // agent_failed_to_start), notify the guardrails service so it clears timers,
    // tears down the session-scoped credentials, and releases the concurrency
    // slot. Without this, credentials leak on every cleanly-completing task (the
    // forced-failure paths already call teardownSession directly).
    if (isTerminal(next) && this.guardrails) {
      await this.guardrails.onTerminal(id).catch((err: unknown) => {
        this.logger.warn(
          `guardrails onTerminal for task ${id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return taskResponseSchema.parse(this.toResponse(updated));
  }

  /**
   * Transitions a task into the distinct `agent_failed_to_start` state, used
   * when the agent process exits before it ever reaches a running state.
   */
  async markAgentFailedToStart(id: string): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }

    const next = toAgentFailedToStart(task.status as TaskStatus);
    const updated = await this.prisma.task.update({
      where: { id },
      data: { status: next },
    });

    // 6.2 — record the `agent_failed_to_start` terminal (422/error). Best-effort.
    await this.recordAudit(() => this.audit?.recordTransition(id, next));

    // VR.4 — record the start failure in the circuit breaker so repeated
    // agent-failed-to-start events trip the breaker and stop the burn loop.
    if (this.guardrails) {
      this.guardrails.recordFailure(id, 'agent_failed_to_start');
    }

    // VR.5 — agent_failed_to_start is a terminal state; tear down credentials
    // and release the concurrency slot on this path too.
    if (this.guardrails) {
      await this.guardrails.onTerminal(id).catch((err: unknown) => {
        this.logger.warn(
          `guardrails onTerminal for task ${id} (agent_failed_to_start) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return taskResponseSchema.parse(this.toResponse(updated));
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
  async stop(id: string, githubId?: number): Promise<TaskResponse> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException(`Task not found: ${id}`);
    }
    if (isTerminal(task.status as TaskStatus)) {
      // Already settled — no-op (never double-release a slot).
      return taskResponseSchema.parse(this.toResponse(task));
    }
    try {
      // `cancelled` is terminal, so transition() fires onTerminal (teardown +
      // slot release) and records the `task.cancelled` audit event centrally.
      return await this.transition(id, 'cancelled', githubId);
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
    } catch (err) {
      this.logger.warn(
        `audit record failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Shapes a Prisma `Task` row into the contracts response shape. The contracts
   * `TaskSchema.createdAt` is a `Date` (`z.coerce.date()`), so the row's native
   * `Date` is passed through unchanged; the HTTP boundary serializes it to an ISO
   * string on the way out.
   */
  private toResponse(task: {
    id: string;
    repoId: string;
    prompt: string;
    status: string;
    createdAt: Date;
    branch: string | null;
    strategy: string | null;
    skills: string[];
    idleTimeoutMs: number | null;
    deadlineMs: number | null;
    runtime?: string | null;
  }): TaskResponse {
    return {
      id: task.id,
      repoId: task.repoId,
      prompt: task.prompt,
      status: task.status as TaskStatus,
      createdAt: task.createdAt,
      // 3.3: echo the persisted run parameters back on every read path (create
      // 201, list, fetch-by-id, and the transition/mark responses, which all
      // funnel through here). Prisma stores `null` for omitted values, so the
      // read-back is the supplied value or `null` — never stale/fabricated.
      branch: task.branch,
      strategy: task.strategy,
      // task-preinstall-skills: echo the persisted skill ids (Postgres text[],
      // empty array when none selected — never stale/fabricated).
      skills: task.skills,
      // task-guardrail-controls: echo the persisted guardrail parameters (null
      // when omitted — never stale/fabricated). A null `idleTimeoutMs` reads back
      // honestly as "no idle reclaim configured" for the console.
      idleTimeoutMs: task.idleTimeoutMs,
      deadlineMs: task.deadlineMs,
      // add-claude-code-runtime (4.1): echo the persisted runtime on every read
      // path (create 201, list, fetch-by-id, transition/mark). A null column (a
      // pre-runtime row or an omitted request) reads back as the default `codex`
      // — never stale/fabricated (sent value == readable value).
      runtime: (task.runtime ?? DEFAULT_TASK_RUNTIME) as Runtime,
    };
  }
}

export { IllegalTaskTransitionError };
