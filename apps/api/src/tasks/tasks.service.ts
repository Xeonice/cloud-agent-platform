import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import {
  taskResponseSchema,
  type CreateTaskBody,
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

/**
 * Narrow slice of `GuardrailsService` that `TasksService` depends on.
 * Declared here as an interface (rather than importing the concrete class)
 * to break the circular module reference:
 *   GuardrailsModule -> TasksModule -> GuardrailsModule
 * The runtime instance satisfies this shape; NestJS injects it by token.
 */
export interface IGuardrailsService {
  admit(taskId: string, deadlineMs?: number): Promise<'running' | 'queued'>;
  onTerminal(taskId: string): Promise<void>;
  recordFailure(taskId: string, kind?: string): void;
  recordSuccess(taskId: string): void;
}

/** DI token used when injecting the guardrails service into the tasks service. */
export const GUARDRAILS_SERVICE_TOKEN = 'GUARDRAILS_SERVICE';

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
  ) {}

  /**
   * On process start, reclaim tasks stranded by the PREVIOUS process. A task in
   * a session-bound non-terminal status (`running` / `awaiting_input`) holds a
   * live sandbox + in-memory runner/guardrail state that lived in the prior
   * process and is gone after a restart (deploy, crash); it can never resume, so
   * it is transitioned to `failed` rather than left lingering with a dead
   * session (and a leaked sandbox the provider reaps in parallel on startup).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reclaimOrphanedOnStartup();
  }

  /**
   * Transition every `running` / `awaiting_input` task to `failed` — the
   * startup reclaim of orphaned in-flight tasks. Returns the count reclaimed.
   * Reuses {@link transition} so each reclaim is edge-validated, audited, and
   * runs the terminal guardrail teardown through the single status-write
   * chokepoint. Best-effort per task: a failure is logged and skipped, never
   * blocking boot.
   */
  async reclaimOrphanedOnStartup(): Promise<number> {
    const orphaned = await this.prisma.task.findMany({
      where: { status: { in: ['running', 'awaiting_input'] } },
      select: { id: true },
    });
    let reclaimed = 0;
    for (const { id } of orphaned) {
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

  async create(
    repoId: string,
    body: CreateTaskBody,
    githubId?: number,
  ): Promise<TaskResponse> {
    const repo = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!repo) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

    const task = await this.prisma.task.create({
      data: {
        repoId,
        prompt: body.prompt,
        // 3.2: persist the optional run parameters from the create body so they
        // are durable and readable on every later read path. They are inert with
        // respect to clone/provision/lifecycle behavior. Coalesce `undefined`
        // (field omitted) to `null` so the stored value is the supplied value or
        // an explicit null — never stale/fabricated on read-back (3.3).
        branch: body.branch ?? null,
        strategy: body.strategy ?? null,
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
      // VR.11 — plumb the optional wall-clock deadline through so the guardrails
      // deadline watcher actually arms (`startRunning → deadlines.armAfter`).
      await this.guardrails.admit(task.id, body.deadlineMs).catch((err: unknown) => {
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
    };
  }
}

export { IllegalTaskTransitionError };
