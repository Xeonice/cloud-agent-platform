import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  ScheduleOwnerRequiredErrorSchema,
  ScheduleResponseSchema,
  ScheduleRunResponseSchema,
  ScheduleTaskTemplateSchema,
  computeNextScheduleRunAt,
  normalizeScheduleTiming,
  recurrenceResponseFromCron,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type ScheduleResponse,
  type ScheduleRunResponse,
  type ScheduleTaskTemplate,
  type UpdateScheduleRequest,
} from '@cap/contracts';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';

const ACTIVE_TASK_STATUSES = [
  'pending',
  'queued',
  'running',
  'awaiting_input',
] as const;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const DEFAULT_DUE_LIMIT = 10;

type ScheduleRow = Prisma.TaskScheduleGetPayload<{
  include: typeof SCHEDULE_INCLUDE;
}>;

const SCHEDULE_INCLUDE = {
  runs: {
    orderBy: { scheduledFor: 'desc' as const },
    take: 1,
    select: {
      id: true,
      scheduledFor: true,
      status: true,
      taskId: true,
      error: true,
    },
  },
} as const;

interface KeysetCursor {
  readonly at: Date;
  readonly id: string;
}

@Injectable()
export class ScheduledTasksService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ScheduledTasksService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverPendingAdmissions();
    if (process.env.SCHEDULED_TASKS_DISABLED === '1') {
      return;
    }
    const pollMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_POLL_MS,
      DEFAULT_POLL_MS,
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.warn(
          `scheduled task tick failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async create(
    ownerUserId: string | undefined,
    body: CreateScheduleRequest,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const ownerId = this.requireOwner(ownerUserId);
    await this.assertOwnerAvailable(ownerId);

    const normalizedTemplate = await this.normalizeTemplate(
      ownerId,
      body.taskTemplate,
    );
    const timing = normalizeScheduleTiming(body);
    const enabled = body.enabled ?? true;
    const created = await this.prisma.taskSchedule.create({
      data: {
        ownerUserId: ownerId,
        repoId: normalizedTemplate.repoId,
        name: body.name ?? null,
        taskTemplate: normalizedTemplate as unknown as Prisma.InputJsonObject,
        cron: timing.cronExpression,
        timezone: timing.timezone,
        enabled,
        nextRunAt: enabled
          ? computeNextScheduleRunAt({
              cronExpression: timing.cronExpression,
              timezone: timing.timezone,
              after: now,
            })
          : null,
        overlapPolicy: body.overlapPolicy,
        misfirePolicy: body.misfirePolicy,
      },
      include: SCHEDULE_INCLUDE,
    });
    return this.toScheduleResponse(created);
  }

  async list(ownerUserId: string, limit?: number): Promise<ScheduleResponse[]> {
    const rows = await this.prisma.taskSchedule.findMany({
      where: { ownerUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: SCHEDULE_INCLUDE,
    });
    return rows.map((row) => this.toScheduleResponse(row));
  }

  async listPage(
    ownerUserId: string,
    args: { limit: number; cursor?: string },
  ): Promise<{ items: ScheduleResponse[]; nextCursor: string | null }> {
    const cursor = args.cursor ? decodeCursor(args.cursor) : null;
    const rows = await this.prisma.taskSchedule.findMany({
      where: {
        ownerUserId,
        ...(cursor ? createdBefore(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.limit + 1,
      include: SCHEDULE_INCLUDE,
    });
    const page = pageRows(rows, args.limit, (row) => row.createdAt);
    return {
      items: page.items.map((row) => this.toScheduleResponse(row)),
      nextCursor: page.nextCursor,
    };
  }

  async get(ownerUserId: string, id: string): Promise<ScheduleResponse> {
    return this.toScheduleResponse(await this.requireOwnedSchedule(ownerUserId, id));
  }

  async update(
    ownerUserId: string,
    id: string,
    body: UpdateScheduleRequest,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const current = await this.requireOwnedSchedule(ownerUserId, id);

    const timingChanged =
      body.recurrence !== undefined ||
      body.cronExpression !== undefined ||
      body.timezone !== undefined;
    const timing = timingChanged
      ? normalizeScheduleTiming({
          recurrence: body.recurrence,
          cronExpression: body.cronExpression ?? current.cron,
          timezone: body.timezone ?? current.timezone,
        })
      : { cronExpression: current.cron, timezone: current.timezone };
    const enabled = body.enabled ?? current.enabled;
    const recurrenceChanged = timingChanged || body.enabled !== undefined;
    const normalizedTemplate = body.taskTemplate
      ? await this.normalizeTemplate(ownerUserId, body.taskTemplate)
      : null;

    const updated = await this.prisma.taskSchedule.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(normalizedTemplate
          ? {
              repoId: normalizedTemplate.repoId,
              taskTemplate: normalizedTemplate as unknown as Prisma.InputJsonObject,
            }
          : {}),
        ...(timingChanged
          ? { cron: timing.cronExpression, timezone: timing.timezone }
          : {}),
        ...(body.enabled !== undefined ? { enabled } : {}),
        ...(body.overlapPolicy !== undefined
          ? { overlapPolicy: body.overlapPolicy }
          : {}),
        ...(body.misfirePolicy !== undefined
          ? { misfirePolicy: body.misfirePolicy }
          : {}),
        ...(recurrenceChanged
          ? {
              nextRunAt: enabled
                ? computeNextScheduleRunAt({
                    cronExpression: timing.cronExpression,
                    timezone: timing.timezone,
                    after: now,
                  })
                : null,
              claimToken: null,
              claimUntil: null,
            }
          : {}),
      },
      include: SCHEDULE_INCLUDE,
    });
    return this.toScheduleResponse(updated);
  }

  async pause(ownerUserId: string, id: string): Promise<ScheduleResponse> {
    await this.requireOwnedSchedule(ownerUserId, id);
    const updated = await this.prisma.taskSchedule.update({
      where: { id },
      data: {
        enabled: false,
        nextRunAt: null,
        claimToken: null,
        claimUntil: null,
      },
      include: SCHEDULE_INCLUDE,
    });
    return this.toScheduleResponse(updated);
  }

  async resume(
    ownerUserId: string,
    id: string,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const current = await this.requireOwnedSchedule(ownerUserId, id);
    const updated = await this.prisma.taskSchedule.update({
      where: { id },
      data: {
        enabled: true,
        nextRunAt: computeNextScheduleRunAt({
          cronExpression: current.cron,
          timezone: current.timezone,
          after: now,
        }),
        claimToken: null,
        claimUntil: null,
      },
      include: SCHEDULE_INCLUDE,
    });
    return this.toScheduleResponse(updated);
  }

  async dispatchNow(
    ownerUserId: string,
    id: string,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const schedule = await this.requireOwnedSchedule(ownerUserId, id);
    const scheduledFor = schedule.nextRunAt ?? now;
    const advanceAfter = scheduledFor > now ? scheduledFor : now;
    const nextRunAt = schedule.enabled
      ? computeNextScheduleRunAt({
          cronExpression: schedule.cron,
          timezone: schedule.timezone,
          after: advanceAfter,
        })
      : null;
    const token = randomUUID();
    const claimLeaseMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
    const claimed = await this.prisma.taskSchedule.updateMany({
      where: {
        id: schedule.id,
        nextRunAt: schedule.nextRunAt,
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
      },
      data: {
        nextRunAt,
        claimToken: token,
        claimUntil: new Date(now.getTime() + claimLeaseMs),
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Schedule is already dispatching');
    }
    await this.executeClaim(schedule, scheduledFor, token);
    return this.get(ownerUserId, id);
  }

  async delete(ownerUserId: string, id: string): Promise<void> {
    const deleted = await this.prisma.taskSchedule.deleteMany({
      where: { id, ownerUserId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException(`Schedule not found: ${id}`);
    }
  }

  async listRuns(
    ownerUserId: string,
    scheduleId: string,
    limit = 50,
  ): Promise<ScheduleRunResponse[]> {
    await this.requireOwnedSchedule(ownerUserId, scheduleId);
    const rows = await this.prisma.taskScheduleRun.findMany({
      where: { scheduleId },
      orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ScheduleRunResponseSchema.parse(row));
  }

  async listRunsPage(
    ownerUserId: string,
    scheduleId: string,
    args: { limit: number; cursor?: string },
  ): Promise<{ items: ScheduleRunResponse[]; nextCursor: string | null }> {
    await this.requireOwnedSchedule(ownerUserId, scheduleId);
    const cursor = args.cursor ? decodeCursor(args.cursor) : null;
    const rows = await this.prisma.taskScheduleRun.findMany({
      where: {
        scheduleId,
        ...(cursor ? scheduledBefore(cursor) : {}),
      },
      orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
      take: args.limit + 1,
    });
    const page = pageRows(rows, args.limit, (row) => row.scheduledFor);
    return {
      items: page.items.map((row) => ScheduleRunResponseSchema.parse(row)),
      nextCursor: page.nextCursor,
    };
  }

  async tick(now = new Date(), limit = DEFAULT_DUE_LIMIT): Promise<number> {
    const rows = await this.prisma.taskSchedule.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
      },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: SCHEDULE_INCLUDE,
    });

    let fired = 0;
    for (const row of rows) {
      const claimed = await this.claim(row, now);
      if (!claimed) continue;
      fired += 1;
      await this.executeClaim(claimed.schedule, claimed.scheduledFor, claimed.token);
    }
    return fired;
  }

  async recoverPendingAdmissions(limit = 100): Promise<number> {
    const rows = await this.prisma.taskScheduleRun.findMany({
      where: {
        status: 'created',
        taskId: { not: null },
        task: { status: 'pending' },
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
      include: {
        schedule: { select: { ownerUserId: true } },
        task: true,
      },
    });

    let recovered = 0;
    for (const row of rows) {
      if (!row.task) continue;
      await this.tasks.admitCreatedTask(
        row.task.id,
        taskBodyFromRow(row.task),
        row.schedule.ownerUserId,
      );
      recovered += 1;
    }
    if (recovered > 0) {
      this.logger.log(
        `scheduled task recovery: admitted ${recovered} pending scheduled task(s)`,
      );
    }
    return recovered;
  }

  private async claim(
    schedule: ScheduleRow,
    now: Date,
  ): Promise<{ schedule: ScheduleRow; scheduledFor: Date; token: string } | null> {
    if (!schedule.nextRunAt) return null;
    const scheduledFor = schedule.nextRunAt;
    const token = randomUUID();
    const claimLeaseMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
    const nextRunAt = computeNextScheduleRunAt({
      cronExpression: schedule.cron,
      timezone: schedule.timezone,
      after: now,
    });
    const claimed = await this.prisma.taskSchedule.updateMany({
      where: {
        id: schedule.id,
        enabled: true,
        nextRunAt: scheduledFor,
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
      },
      data: {
        nextRunAt,
        claimToken: token,
        claimUntil: new Date(now.getTime() + claimLeaseMs),
      },
    });
    return claimed.count === 1 ? { schedule, scheduledFor, token } : null;
  }

  private async executeClaim(
    schedule: ScheduleRow,
    scheduledFor: Date,
    token: string,
  ): Promise<void> {
    try {
      await this.assertOwnerAvailable(schedule.ownerUserId);
      const template = ScheduleTaskTemplateSchema.parse(schedule.taskTemplate);
      if (schedule.overlapPolicy === 'skip') {
        const active = await this.prisma.taskScheduleRun.findFirst({
          where: {
            scheduleId: schedule.id,
            task: { status: { in: [...ACTIVE_TASK_STATUSES] } },
          },
          select: { id: true },
        });
        if (active) {
          await this.recordSkippedRun(
            schedule.id,
            scheduledFor,
            'overlap: prior scheduled task still active',
          );
          return;
        }
      }
      await this.createTaskForRun(schedule, scheduledFor, template);
    } catch (err) {
      await this.recordFailedRun(schedule.id, scheduledFor, errorMessage(err));
    } finally {
      await this.prisma.taskSchedule.updateMany({
        where: { id: schedule.id, claimToken: token },
        data: { claimToken: null, claimUntil: null },
      });
    }
  }

  private async createTaskForRun(
    schedule: ScheduleRow,
    scheduledFor: Date,
    template: ScheduleTaskTemplate,
  ): Promise<void> {
    const { repoId, ...taskBody } = template;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.taskScheduleRun.create({
        data: {
          scheduleId: schedule.id,
          scheduledFor,
          status: 'claimed',
        },
      });
      const task = await this.tasks.createTaskRow(
        repoId,
        taskBody,
        tx as unknown as PrismaService,
        'headless-exec',
        schedule.ownerUserId,
      );
      await tx.taskScheduleRun.update({
        where: {
          scheduleId_scheduledFor: {
            scheduleId: schedule.id,
            scheduledFor,
          },
        },
        data: {
          status: 'created',
          taskId: task.id,
        },
      });
      return { task, taskBody };
    });
    await this.tasks.admitCreatedTask(
      created.task.id,
      created.taskBody,
      schedule.ownerUserId,
    );
  }

  private async recordSkippedRun(
    scheduleId: string,
    scheduledFor: Date,
    error: string,
  ): Promise<void> {
    await this.createRunOnce({
      scheduleId,
      scheduledFor,
      status: 'skipped',
      error,
    });
  }

  private async recordFailedRun(
    scheduleId: string,
    scheduledFor: Date,
    error: string,
  ): Promise<void> {
    await this.createRunOnce({
      scheduleId,
      scheduledFor,
      status: 'failed',
      error,
    });
  }

  private async createRunOnce(data: {
    scheduleId: string;
    scheduledFor: Date;
    status: 'skipped' | 'failed';
    error: string;
  }): Promise<void> {
    try {
      await this.prisma.taskScheduleRun.create({ data });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }

  private async normalizeTemplate(
    ownerUserId: string,
    input: CreateScheduleRequest['taskTemplate'],
  ): Promise<ScheduleTaskTemplate> {
    const { repoId, ...taskBody } = input;
    const normalized = await this.tasks.normalizeTaskTemplateForSchedule(
      repoId,
      taskBody,
      ownerUserId,
    );
    return ScheduleTaskTemplateSchema.parse(normalized);
  }

  private requireOwner(ownerUserId: string | undefined): string {
    if (ownerUserId) return ownerUserId;
    throw new BadRequestException(
      ScheduleOwnerRequiredErrorSchema.parse({
        error: 'schedule_owner_required',
        message: 'Schedules require an authenticated account owner.',
      }),
    );
  }

  private async assertOwnerAvailable(ownerUserId: string): Promise<void> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { allowed: true },
    });
    if (!owner?.allowed) {
      throw new BadRequestException({
        error: 'schedule_owner_unavailable',
        message: 'Schedule owner is no longer available.',
      });
    }
  }

  private async requireOwnedSchedule(
    ownerUserId: string,
    id: string,
  ): Promise<ScheduleRow> {
    const row = await this.prisma.taskSchedule.findFirst({
      where: { id, ownerUserId },
      include: SCHEDULE_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException(`Schedule not found: ${id}`);
    }
    return row;
  }

  private toScheduleResponse(row: ScheduleRow): ScheduleResponse {
    return ScheduleResponseSchema.parse({
      id: row.id,
      ownerUserId: row.ownerUserId,
      repoId: row.repoId,
      name: row.name,
      cronExpression: row.cron,
      timezone: row.timezone,
      recurrence: recurrenceResponseFromCron(row.cron, row.timezone),
      enabled: row.enabled,
      nextRunAt: row.nextRunAt,
      overlapPolicy: row.overlapPolicy,
      misfirePolicy: row.misfirePolicy,
      taskTemplate: row.taskTemplate,
      latestRun: row.runs[0] ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}

function taskBodyFromRow(task: {
  prompt: string;
  branch: string | null;
  strategy: string | null;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  runtime: string | null;
  sandboxEnvironmentId: string | null;
  deliver: string | null;
}): CreateTaskBody {
  return {
    prompt: task.prompt,
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.strategy ? { strategy: task.strategy } : {}),
    ...(task.skills.length > 0 ? { skills: task.skills } : {}),
    ...(task.idleTimeoutMs ? { idleTimeoutMs: task.idleTimeoutMs } : {}),
    ...(task.deadlineMs ? { deadlineMs: task.deadlineMs } : {}),
    ...(task.runtime ? { runtime: task.runtime as never } : {}),
    sandboxEnvironmentId: task.sandboxEnvironmentId,
    ...(task.deliver ? { deliver: task.deliver as never } : {}),
  };
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): KeysetCursor {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep <= 0 || sep === raw.length - 1) {
    throw new BadRequestException('Invalid cursor');
  }
  const at = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException('Invalid cursor');
  }
  return { at, id };
}

function createdBefore(cursor: KeysetCursor): Prisma.TaskScheduleWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.at } },
      { createdAt: cursor.at, id: { lt: cursor.id } },
    ],
  };
}

function scheduledBefore(cursor: KeysetCursor): Prisma.TaskScheduleRunWhereInput {
  return {
    OR: [
      { scheduledFor: { lt: cursor.at } },
      { scheduledFor: cursor.at, id: { lt: cursor.id } },
    ],
  };
}

function pageRows<T extends { id: string }>(
  rows: T[],
  limit: number,
  dateOf: (row: T) => Date,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return last
    ? { items, nextCursor: encodeCursor({ at: dateOf(last), id: last.id }) }
    : { items, nextCursor: null };
}
