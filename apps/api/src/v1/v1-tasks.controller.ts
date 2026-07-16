import {
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type V1CreateTaskRequest,
  type V1ListQuery,
  type V1ListTasksResponse,
  type TaskResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { type OperatorPrincipal } from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { IdempotencyService } from './idempotency.service';
import { listTaskPage } from './public-list-pages';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1Principal,
} from '../public-surface/public-v1-operation';

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
 * `/v1` task surface (public-v1-api, D1) — additive public data controller that
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
 * scopes and is allow-all (the central boundary treats `scopes === undefined`
 * as unrestricted), an `api-key` missing the required scope is 403'd (distinct from 401). The
 * V1Module that registers this controller is assembled in Integration (3.6).
 */
@PublicV1Controller('v1/tasks')
export class V1TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * `POST /v1/tasks` — create a task with `repoId` in the body.
   *
   * Single acceptance path (D1): every create uses the same preparation and
   * transaction-bound `TasksService.acceptPreparedTask` writer as Console/MCP.
   * An optional `Idempotency-Key` dedups retries (D5): same key+body → the SAME
   * task/work item; same key+different body → 409.
   */
  @Post()
  @PublicV1Operation('tasks.create')
  @Throttle(V1_CREATE_RATE)
  async create(
    @PublicV1Input('body') body: V1CreateTaskRequest,
    @Req() req: AuthenticatedRequest,
    @PublicV1Input('headers', 'Idempotency-Key')
    idempotencyKey?: string,
  ): Promise<TaskResponse> {
    const principal = requirePublicV1Principal(req, this.create);
    // Best-effort attribution by the acting account PRIMARY KEY (`users.id`),
    // present for BOTH local (password/OTP) and GitHub accounts
    // (fix-local-account-task-attribution) so a local account's task is
    // owner-attributed and its stored Codex credential resolves at run time;
    // `undefined` only for a truly identity-less machine/legacy principal.
    const userId = principal.user?.id ?? undefined;
    const { repoId, ...createBody } = body;
    const scopeUserId = idempotencyScope(principal);
    const lookup = await this.idempotency.lookup({
      key: idempotencyKey ?? null,
      // Per-principal dedup scope: the api-key owner / session user identity (D5).
      // A scopeless legacy/session principal with no githubId still dedups under a
      // stable per-kind sentinel so its retries are not cross-aliased.
      scopeUserId,
      body,
      loadTask: (taskId) => this.tasksService.findById(taskId),
    });
    if (lookup.kind === 'replay') return lookup.task;

    let prepared: Awaited<
      ReturnType<TasksService['prepareTaskCreate']>
    >;
    try {
      // Catalog/environment/credential work is deliberately outside the short
      // idempotency transaction. An exact historical replay returned above and
      // therefore never depends on today's catalog state.
      prepared = await this.tasksService.prepareTaskCreate(
        repoId,
        createBody,
        'headless-exec',
        userId,
      );
    } catch (err) {
      // A same-key request may have committed while this preflight was running.
      // Give that winner a short, read-only resolution window before surfacing
      // the current catalog failure.
      const winner = await this.idempotency.waitForWinner({
        key: idempotencyKey ?? null,
        scopeUserId,
        requestHash: lookup.requestHash,
        loadTask: (taskId) => this.tasksService.findById(taskId),
      });
      if (winner) return winner;
      throw err;
    }

    const { task, created } = await this.idempotency.commit({
      key: idempotencyKey ?? null,
      scopeUserId,
      requestHash: lookup.requestHash,
      create: (tx) => this.tasksService.acceptPreparedTask(prepared, tx),
      loadTask: (taskId) => this.tasksService.findById(taskId),
    });
    // Dispatch ONLY a newly-created acceptance. With durable admission this is a
    // best-effort local wake (the polling floor owns recovery); a dedup hit must
    // not wake or restart current provisioning. Run only AFTER the transaction
    // commits so a rolled-back loser cannot leave external side effects.
    if (created) {
      await this.tasksService.admitCreatedTask(
        task.id,
        prepared.body,
        prepared.ownerUserId ?? undefined,
      );
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
  @PublicV1Operation('tasks.list')
  async list(
    @PublicV1Input('query') query: V1ListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListTasksResponse> {
    requirePublicV1Principal(req, this.list);
    return listTaskPage(this.prisma, query);
  }

  /**
   * `GET /v1/tasks/:id` — the GUARANTEED polling floor (D6): every status
   * transition is durably persisted before the response, so a poller observes
   * each `pending → queued → running → terminal` step. 404 when unknown.
   */
  @Get(':id')
  @PublicV1Operation('tasks.get')
  async findById(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    requirePublicV1Principal(req, this.findById);
    return this.tasksService.findById(id);
  }

  /**
   * `POST /v1/tasks/:id/stop` — operator-initiated stop, delegating to the same
   * `TasksService.stop` (terminal `cancelled`, teardown + slot release).
   * Idempotent for an already-terminal task. 404 when unknown.
   */
  @Post(':id/stop')
  @PublicV1Operation('tasks.stop')
  async stop(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    const principal = requirePublicV1Principal(req, this.stop);
    // Best-effort attribution by the acting account PRIMARY KEY (`users.id`),
    // present for local + GitHub accounts (fix-local-account-task-attribution).
    return this.tasksService.stop(id, principal.user?.id ?? undefined);
  }

}

/**
 * Per-principal idempotency scope (D5). An api-key/session principal scopes on its
 * owner's GitHub id; a principal with no GitHub identity (legacy operator token)
 * scopes under a stable per-kind sentinel so its own retries dedup without ever
 * colliding with another principal's keys.
 */
function idempotencyScope(principal: OperatorPrincipal): string {
  if (principal.user?.id) return `user:${principal.user.id}`;
  if (principal.keyId) {
    return `key:${principal.keyId}`;
  }
  return `kind:${principal.kind}`;
}
