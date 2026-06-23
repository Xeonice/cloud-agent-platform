import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  createTaskBodySchema,
  type CreateTaskBody,
  type Scope,
  type TaskResponse,
} from '@cap/contracts';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { type AuthenticatedRequest } from '../auth/auth.guard';
import { hasScope } from '../auth/operator-principal';
import { TasksService } from './tasks.service';

/**
 * REST surface for tasks.
 *
 * - `POST /repos/:repoId/tasks` -> 201 with the created task and its initial
 *                                  status (400 on invalid body; 404 when the
 *                                  referenced repo does not exist — no record
 *                                  is created in either case).
 * - `GET  /tasks`               -> 200 with the list of tasks.
 * - `GET  /tasks/:id`           -> 200 with the task, or 404 when it does not
 *                                  exist.
 * - `POST /tasks/:taskId/stop`  -> 200 with the task transitioned to `cancelled`
 *                                  (operator-initiated stop; 404 when the task
 *                                  does not exist; idempotent no-op for a task
 *                                  already in a terminal state).
 *
 * Auth: the whole surface is behind the global `APP_GUARD` (auth.module), so the
 * stop route is rejected with 401 for an unauthenticated / de-allowlisted caller
 * before any state change, exactly like the read/create routes.
 *
 * Scopes (api-key-machine-identity, route-integration 6.2): the guard attaches a
 * resolved {@link OperatorPrincipal}. A principal that carries scopes (an
 * api-key) is admitted to a scoped route only when its scopes include the route's
 * required scope; otherwise this controller rejects with 403 (insufficient
 * scope), distinct from the guard's 401. A scopeless principal (a GitHub session
 * or the legacy operator token) has `scopes === undefined`, which {@link hasScope}
 * treats as allow-all, so existing console behavior is unchanged.
 *
 * Attribution (route-integration 6.1; fix-local-account-task-attribution): the
 * controller reads the principal's ACCOUNT primary key (`operatorPrincipal?.user?.id`)
 * and threads it into `TasksService.create/stop`, so a task action attributes to
 * the acting operator (the session user — local OR GitHub — or the api-key's owner)
 * instead of being system-attributed. The account id (not the GitHub numeric id)
 * is used so a LOCAL account (password/OTP, which has no `githubId`) is also
 * owner-attributed and its stored Codex credential resolves at run time.
 */
@Controller()
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post('repos/:repoId/tasks')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createTaskBodySchema))
  async create(
    @Param('repoId') repoId: string,
    @Body() body: CreateTaskBody,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    TasksController.requireScope(req, 'tasks:write');
    return this.tasksService.create(repoId, body, TasksController.accountId(req));
  }

  @Get('tasks')
  async list(@Req() req: AuthenticatedRequest): Promise<TaskResponse[]> {
    TasksController.requireScope(req, 'tasks:read');
    return this.tasksService.list();
  }

  @Get('tasks/:id')
  async findById(@Param('id') id: string): Promise<TaskResponse> {
    return this.tasksService.findById(id);
  }

  /**
   * Operator-initiated stop: transitions an active task to `cancelled` (tearing
   * down its sandbox and releasing its concurrency slot). Idempotent for a task
   * already in a terminal state. 200 with the resulting task; 404 when unknown.
   */
  @Post('tasks/:taskId/stop')
  @HttpCode(HttpStatus.OK)
  async stop(
    @Param('taskId') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TaskResponse> {
    TasksController.requireScope(req, 'tasks:write');
    return this.tasksService.stop(taskId, TasksController.accountId(req));
  }

  /**
   * The acting operator's ACCOUNT primary key (`users.id`), or `undefined` when the
   * principal carries NO account identity at all (the legacy shared-token
   * operator). This is the attribution threaded into the service (6.1;
   * fix-local-account-task-attribution) — never trusted from the client; it comes
   * only from the principal the guard attached.
   *
   * The account id is present for BOTH a LOCAL account (password/OTP) and a GitHub
   * account, so it — unlike the GitHub numeric `githubId`, which a local account
   * lacks — owner-attributes a local account's task too, letting the owner-scoped
   * Codex credential resolve at run time. `undefined` remains the "identity-less
   * machine/legacy principal" defensive case (system attribution).
   */
  private static accountId(req: AuthenticatedRequest): string | undefined {
    return req.operatorPrincipal?.user?.id ?? undefined;
  }

  /**
   * Enforce a scoped route (6.2): a principal whose scopes do NOT include
   * `required` is rejected with 403 (insufficient scope), distinct from the
   * guard's 401 for an absent/invalid credential. A scopeless principal
   * (`scopes === undefined`) passes via {@link hasScope}'s allow-all default.
   */
  private static requireScope(req: AuthenticatedRequest, required: Scope): void {
    if (!hasScope(req.operatorPrincipal, required)) {
      throw new ForbiddenException(`Insufficient scope: ${required} required`);
    }
  }
}
