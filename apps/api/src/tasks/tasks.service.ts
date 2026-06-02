import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  taskResponseSchema,
  type CreateTaskBody,
  type TaskResponse,
  type TaskStatus,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TaskTokenService } from './task-token.service';
import {
  IllegalTaskTransitionError,
  assertTransition,
  isTerminal,
  toAgentFailedToStart,
} from './task-lifecycle';

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
 * terminal-state transition calls `onTerminal()` so credentials + TASK_TOKENs
 * are torn down on the happy path.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taskTokens: TaskTokenService,
    @Optional()
    @Inject(GUARDRAILS_SERVICE_TOKEN)
    private readonly guardrails?: IGuardrailsService,
  ) {}

  async create(repoId: string, body: CreateTaskBody): Promise<TaskResponse> {
    const repo = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!repo) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

    const task = await this.prisma.task.create({
      data: {
        repoId,
        prompt: body.prompt,
        // Initial status is the schema default (`pending`).
      },
    });

    // 8.3: mint the per-task `TASK_TOKEN` at creation. It is scoped to exactly
    // this task, non-reusable across tasks, and bounded by a TTL. The token is
    // injected into the runner's environment when its sandbox is provisioned and
    // is later verified by the dial-back handshake verifier (8.2). It is NOT
    // surfaced on the operator-facing task response.
    this.taskTokens.issue(task.id);

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

  /**
   * Returns the per-task `TASK_TOKEN` minted at creation so the provisioning
   * path can inject it into the runner sandbox environment. Distinct from the
   * operator `AUTH_TOKEN`; never included in any REST response body.
   */
  issueTaskToken(taskId: string): string {
    return this.taskTokens.issue(taskId);
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
  async transition(id: string, next: TaskStatus): Promise<TaskResponse> {
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

    // VR.5 — on any natural terminal transition (completed / failed /
    // agent_failed_to_start), notify the guardrails service so it clears timers,
    // tears down ephemeral credentials + TASK_TOKEN, and releases the concurrency
    // slot. Without this, creds and TASK_TOKENs leak on every cleanly-completing
    // task (the forced-failure paths already call teardownSession directly).
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
  }): TaskResponse {
    return {
      id: task.id,
      repoId: task.repoId,
      prompt: task.prompt,
      status: task.status as TaskStatus,
      createdAt: task.createdAt,
    };
  }
}

export { IllegalTaskTransitionError };
