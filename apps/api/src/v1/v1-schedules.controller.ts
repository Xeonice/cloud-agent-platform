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
  Query,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  V1ScheduleListQuerySchema,
  type CreateScheduleRequest,
  type ScheduleResponse,
  type UpdateScheduleRequest,
  type V1ListScheduleRunsResponse,
  type V1ListSchedulesResponse,
  type V1ScheduleListQuery,
} from '@cap/contracts';
import { type AuthenticatedRequest } from '../auth/auth.guard';
import {
  hasScope,
  type OperatorPrincipal,
} from '../auth/operator-principal';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { resolveLimit } from './keyset-pagination';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';

@Controller('v1/schedules')
export class V1SchedulesController {
  constructor(private readonly schedules: ScheduledTasksService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(V1ScheduleListQuerySchema))
    query: V1ScheduleListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListSchedulesResponse> {
    const principal = this.requireScope(req, 'tasks:read');
    return this.schedules.listPage(this.accountId(principal), {
      limit: resolveLimit(query.limit),
      cursor: query.cursor,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateScheduleRequestSchema))
  async create(
    @Body() body: CreateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    return this.schedules.create(principal.user?.id ?? undefined, body);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:read');
    return this.schedules.get(this.accountId(principal), id);
  }

  @Patch(':id')
  @UsePipes(new ZodValidationPipe(UpdateScheduleRequestSchema))
  async update(
    @Param('id') id: string,
    @Body() body: UpdateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    return this.schedules.update(this.accountId(principal), id, body);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    return this.schedules.pause(this.accountId(principal), id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    return this.schedules.resume(this.accountId(principal), id);
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  async dispatch(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const principal = this.requireScope(req, 'tasks:write');
    return this.schedules.dispatchNow(this.accountId(principal), id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const principal = this.requireScope(req, 'tasks:write');
    await this.schedules.delete(this.accountId(principal), id);
  }

  @Get(':id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(V1ScheduleListQuerySchema))
    query: V1ScheduleListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListScheduleRunsResponse> {
    const principal = this.requireScope(req, 'tasks:read');
    return this.schedules.listRunsPage(this.accountId(principal), id, {
      limit: resolveLimit(query.limit),
      cursor: query.cursor,
    });
  }

  private accountId(principal: OperatorPrincipal): string {
    if (!principal.user?.id) {
      throw new ForbiddenException('An account owner is required');
    }
    return principal.user.id;
  }

  private requireScope(
    req: AuthenticatedRequest,
    required: Parameters<typeof hasScope>[1],
  ): OperatorPrincipal {
    const principal = req.operatorPrincipal;
    if (!principal) {
      throw new ForbiddenException('Missing operator principal');
    }
    if (!hasScope(principal, required)) {
      throw new ForbiddenException(`Insufficient scope: ${required} required`);
    }
    return principal;
  }
}
