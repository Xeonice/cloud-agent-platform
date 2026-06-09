import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UsePipes,
} from '@nestjs/common';
import { createTaskBodySchema, type CreateTaskBody, type TaskResponse } from '@cap/contracts';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
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
  ): Promise<TaskResponse> {
    return this.tasksService.create(repoId, body);
  }

  @Get('tasks')
  async list(): Promise<TaskResponse[]> {
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
  async stop(@Param('taskId') taskId: string): Promise<TaskResponse> {
    return this.tasksService.stop(taskId);
  }
}
