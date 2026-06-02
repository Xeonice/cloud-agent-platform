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
}
