import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  DispatchScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  type CreateScheduleRequest,
  type DispatchScheduleRequest,
  type ListScheduleRunsResponse,
  type ListSchedulesResponse,
  type ScheduleResponse,
  type Scope,
  type UpdateScheduleRequest,
} from '@cap/contracts';
import { type AuthenticatedRequest } from '../auth/auth.guard';
import { hasScope } from '../auth/operator-principal';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Controller('schedules')
export class ScheduledTasksController {
  constructor(private readonly schedules: ScheduledTasksService) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<ListSchedulesResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:read');
    return this.schedules.list(ScheduledTasksController.accountId(req));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateScheduleRequestSchema))
  async create(
    @Body() body: CreateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    return this.schedules.create(ScheduledTasksController.optionalAccountId(req), body);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:read');
    return this.schedules.get(ScheduledTasksController.accountId(req), id);
  }

  @Patch(':id')
  @UsePipes(new ZodValidationPipe(UpdateScheduleRequestSchema))
  async update(
    @Param('id') id: string,
    @Body() body: UpdateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    return this.schedules.update(ScheduledTasksController.accountId(req), id, body);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    return this.schedules.pause(ScheduledTasksController.accountId(req), id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    return this.schedules.resume(ScheduledTasksController.accountId(req), id);
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(DispatchScheduleRequestSchema))
  async dispatch(
    @Param('id') id: string,
    @Body() body: DispatchScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    return this.schedules.dispatchNow(
      ScheduledTasksController.accountId(req),
      id,
      body,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    ScheduledTasksController.requireScope(req, 'tasks:write');
    await this.schedules.delete(ScheduledTasksController.accountId(req), id);
  }

  @Get(':id/runs')
  async listRuns(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ListScheduleRunsResponse> {
    ScheduledTasksController.requireScope(req, 'tasks:read');
    return this.schedules.listRuns(ScheduledTasksController.accountId(req), id);
  }

  private static accountId(req: AuthenticatedRequest): string {
    const userId = ScheduledTasksController.optionalAccountId(req);
    if (!userId) {
      throw new ForbiddenException('An account owner is required');
    }
    return userId;
  }

  private static optionalAccountId(req: AuthenticatedRequest): string | undefined {
    return req.operatorPrincipal?.user?.id ?? undefined;
  }

  private static requireScope(req: AuthenticatedRequest, required: Scope): void {
    if (!hasScope(req.operatorPrincipal, required)) {
      throw new ForbiddenException(`Insufficient scope: ${required} required`);
    }
  }
}
