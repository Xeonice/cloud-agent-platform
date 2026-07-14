import {
  Delete,
  Get,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  type CreateScheduleRequest,
  type DispatchScheduleRequest,
  type ScheduleResponse,
  type UpdateScheduleRequest,
  type V1ListScheduleRunsResponse,
  type V1ListSchedulesResponse,
  type V1ScheduleListQuery,
} from '@cap/contracts';
import { type AuthenticatedRequest } from '../auth/auth.guard';
import { resolveLimit } from './keyset-pagination';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1OwnerId,
} from '../public-surface/public-v1-operation';

@PublicV1Controller('v1/schedules')
export class V1SchedulesController {
  constructor(private readonly schedules: ScheduledTasksService) {}

  @Get()
  @PublicV1Operation('schedules.list')
  async list(
    @PublicV1Input('query')
    query: V1ScheduleListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListSchedulesResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.list);
    return this.schedules.listPage(ownerUserId, {
      limit: resolveLimit(query.limit),
      cursor: query.cursor,
    });
  }

  @Post()
  @PublicV1Operation('schedules.create')
  async create(
    @PublicV1Input('body') body: CreateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.create);
    return this.schedules.create(ownerUserId, body);
  }

  @Get(':id')
  @PublicV1Operation('schedules.get')
  async get(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.get);
    return this.schedules.get(ownerUserId, id);
  }

  @Patch(':id')
  @PublicV1Operation('schedules.update')
  async update(
    @PublicV1Input('params', 'id') id: string,
    @PublicV1Input('body') body: UpdateScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.update);
    return this.schedules.update(ownerUserId, id, body);
  }

  @Post(':id/pause')
  @PublicV1Operation('schedules.pause')
  async pause(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.pause);
    return this.schedules.pause(ownerUserId, id);
  }

  @Post(':id/resume')
  @PublicV1Operation('schedules.resume')
  async resume(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.resume);
    return this.schedules.resume(ownerUserId, id);
  }

  @Post(':id/dispatch')
  @PublicV1Operation('schedules.dispatch')
  async dispatch(
    @PublicV1Input('params', 'id') id: string,
    @PublicV1Input('body') body: DispatchScheduleRequest,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.dispatch);
    return this.schedules.dispatchNow(ownerUserId, id, body);
  }

  @Delete(':id')
  @PublicV1Operation('schedules.delete')
  async delete(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const ownerUserId = requirePublicV1OwnerId(req, this.delete);
    await this.schedules.delete(ownerUserId, id);
  }

  @Get(':id/runs')
  @PublicV1Operation('schedules.runs')
  async listRuns(
    @PublicV1Input('params', 'id') id: string,
    @PublicV1Input('query')
    query: V1ScheduleListQuery,
    @Req() req: AuthenticatedRequest,
  ): Promise<V1ListScheduleRunsResponse> {
    const ownerUserId = requirePublicV1OwnerId(req, this.listRuns);
    return this.schedules.listRunsPage(ownerUserId, id, {
      limit: resolveLimit(query.limit),
      cursor: query.cursor,
    });
  }

}
