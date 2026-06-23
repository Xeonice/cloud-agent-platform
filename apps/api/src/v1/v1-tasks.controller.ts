import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  taskResponseSchema,
  type V1CreateTaskRequest,
  type V1ListQuery,
  type V1ListTasksResponse,
  type TaskResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import {
  hasScope,
  type OperatorPrincipal,
} from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { IdempotencyService } from './idempotency.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
  KEYSET_ORDER_BY,
  resolveLimit,
} from './keyset-pagination';

/**
 * Stricter per-principal create cap on `POST /v1/tasks` (D7 / task 3.5).
 *
 * Keyed under the named throttler `'create'`, which Integration (6.1) MUST
 * register in `ThrottlerModule.forRoot([...])` ALONGSIDE the global `'default'`
 * request throttler — an unknown throttler name is silently inert, so the
 * integrator wires a `{ name: 'create', ... }` throttler (env-overridable
 * defaults, the same per-principal `getTracker` keyed off `req.operatorPrincipal`)
 * for this override to bite. It is DISTINCT from the global request throttler:
 * the running-task semaphore bounds RUNNING tasks, not CREATED ones, so an
 * unbounded queued backlog is the real abuse surface and this is its backstop.
 */
const V1_CREATE_RATE: Parameters<typeof Throttle>[0] = {
  create: { limit: 10, ttl: 60_000 },
};

/**
 * `/v1` task surface (public-v1-api, D1) — additive `@Controller('v1/...')` that
 * delegates to the SAME `TasksService` the console uses, so there is exactly one
 * task-admission path and the console's unversioned endpoints stay byte-identical
 * (no `app.enableVersioning()`).
 *
 * Routes:
 *   - `POST   /v1/tasks`           — create (repoId in the BODY), idempotent via
 *                                    an optional `Idempotency-Key` header, gated
 *                                    by `tasks:write`, create-rate capped.
 *   - `GET    /v1/tasks`           — keyset-paginated list, gated by `tasks:read`.
 *   - `GET    /v1/tasks/:id`       — fetch by id (the guaranteed polling floor),
 *                                    gated by `tasks:read`.
 *   - `POST   /v1/tasks/:id/stop`  — operator stop, gated by `tasks:write`.
 *
 * Auth: behind the global auth guard (an unauthenticated caller is 401'd before
 * any handler). Each handler additionally enforces the shared scope vocabulary on
 * the guard-attached `operatorPrincipal` — a session/legacy principal carries no
 * scopes and is allow-all (`hasScope` returns true for `scopes === undefined`),
 * an `api-key` missing the required scope is 403'd (distinct from 401). The
 * V1Module that registers this controller is assembled in Integration (3.6).
 */
@Controller('v1/tasks')
export class V1TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * `POST /v1/tasks` — create a task with `repoId` in the body.
   *
   * Single admission path (D1): every create funnels through
   * `TasksService.create(repoId, body)` — the same guardrails admission the
   * console's `POST /repos/:repoId/tasks` uses. An optional `Idempotency-Key`
   * dedups retries (D5): same key+body → the SAME task (one sandbox admission),
   * same key+different body → 409.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle(V1_CREATE_RATE)
  @UsePipes(new ZodValidationPipe(V1CreateTaskRequestSchema))
  async create(
    @Body() body: V1CreateTaskRequest,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TaskResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    // Best-effort attribution by the acting account PRIMARY KEY (`users.id`),
    // present for BOTH local (password/OTP) and GitHub accounts
    // (fix-local-account-task-attribution) so a local account's task is
    // owner-attributed and its stored Codex credential resolves at run time;
    // `undefined` only for a truly identity-less machine/legacy principal.
    const userId = principal.user?.id ?? undefined;
    const { repoId, ...createBody } = body;

    const { task, created } = await this.idempotency.run({
      key: idempotencyKey ?? null,
      // Per-principal dedup scope: the api-key owner / session user identity (D5).
      // A scopeless legacy/session principal with no githubId still dedups under a
      // stable per-kind sentinel so its retries are not cross-aliased.
      scopeUserId: idempotencyScope(principal),
      body,
      // V.1 — persist the task ROW on the transaction-bound `tx` client so it
      // commits ATOMICALLY with the dedup row; a raced/retried create can never
      // leave a committed task without its dedup row (and so never double-admits).
      // add-headless-execution-track: `/v1` is a programmatic consumer → headless-exec.
      admit: (tx) =>
        this.tasksService.createTaskRow(repoId, createBody, tx, 'headless-exec'),
      loadTask: (taskId) => this.tasksService.findById(taskId),
    });
    // Provision ONLY a newly-created task — a dedup hit was already admitted by the
    // first call. Run AFTER the dedup transaction has COMMITTED so a rolled-back
    // transaction never leaves a provisioned sandbox (V.1 / TasksService split).
    if (created) {
      await this.tasksService.admitCreatedTask(task.id, createBody, userId);
    }
    return task;
  }

  /**
   * `GET /v1/tasks` — keyset-paginated list ordered by `(createdAt, id)` (D4).
   * Reads the shared pool directly (read-only; not an admission path) so the
   * cursor `where`/`orderBy`/`take` can be composed without mutating
   * `TasksService`. `nextCursor` is null on the last page.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(V1ListQuerySchema)) query: V1ListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListTasksResponse> {
    this.requireScope(req, 'tasks:read');
    const limit = resolveLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.task.findMany({
      where: cursorWhere(cursor),
      orderBy: KEYSET_ORDER_BY,
      take: limit + 1,
    });

    const page = buildPage(rows, limit);
    return {
      items: page.items.map((row) => taskResponseSchema.parse(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * `GET /v1/tasks/:id` — the GUARANTEED polling floor (D6): every status
   * transition is durably persisted before the response, so a poller observes
   * each `pending → queued → running → terminal` step. 404 when unknown.
   */
  @Get(':id')
  async findById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    this.requireScope(req, 'tasks:read');
    return this.tasksService.findById(id);
  }

  /**
   * `POST /v1/tasks/:id/stop` — operator-initiated stop, delegating to the same
   * `TasksService.stop` (terminal `cancelled`, teardown + slot release).
   * Idempotent for an already-terminal task. 404 when unknown.
   */
  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  async stop(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    // Best-effort attribution by the acting account PRIMARY KEY (`users.id`),
    // present for local + GitHub accounts (fix-local-account-task-attribution).
    return this.tasksService.stop(id, principal.user?.id ?? undefined);
  }

  /**
   * Reads the guard-attached principal and enforces the required scope (task 3.4).
   * A scopeless principal (session/legacy: `scopes === undefined`) is allow-all;
   * a principal carrying scopes that does NOT include `required` is rejected 403
   * (insufficient scope) — distinct from the 401 the guard returns for an absent
   * credential. Returns the principal so the caller can attribute the action.
   */
  private requireScope(
    req: AuthenticatedRequest,
    required: Parameters<typeof hasScope>[1],
  ): OperatorPrincipal {
    const principal = req.operatorPrincipal;
    // The global auth guard attaches the principal on every admitted request; its
    // absence means the guard was bypassed (a wiring error) — fail closed.
    if (!principal) {
      throw new ForbiddenException('Missing operator principal');
    }
    if (!hasScope(principal, required)) {
      throw new ForbiddenException(`Insufficient scope: ${required} required`);
    }
    return principal;
  }
}

/**
 * Per-principal idempotency scope (D5). An api-key/session principal scopes on its
 * owner's GitHub id; a principal with no GitHub identity (legacy operator token)
 * scopes under a stable per-kind sentinel so its own retries dedup without ever
 * colliding with another principal's keys.
 */
function idempotencyScope(principal: OperatorPrincipal): string {
  const githubId = principal.user?.githubId;
  if (githubId !== undefined && githubId !== null) {
    return `github:${githubId}`;
  }
  if (principal.keyId) {
    return `key:${principal.keyId}`;
  }
  return `kind:${principal.kind}`;
}
