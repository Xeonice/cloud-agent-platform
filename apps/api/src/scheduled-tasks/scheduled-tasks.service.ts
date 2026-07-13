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
  computeCurrentSchedulePeriod,
  computeNextScheduleRunAt,
  computeSchedulePeriodForOccurrence,
  normalizeScheduleTiming,
  recurrenceResponseFromCron,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type DispatchScheduleRequest,
  type SchedulePeriodIdentity,
  type ScheduleResponse,
  type ScheduleRunResponse,
  type ScheduleTaskTemplate,
  type UpdateScheduleRequest,
} from '@cap/contracts';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { taskFailureFromRecord } from '../tasks/task-failure';

const ACTIVE_TASK_STATUSES = [
  'pending',
  'queued',
  'running',
  'awaiting_input',
] as const;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const DEFAULT_DUE_LIMIT = 10;
const SCHEDULE_MUTATION_CAS_ATTEMPTS = 3;

type ScheduleRow = Prisma.TaskScheduleGetPayload<{
  include: typeof SCHEDULE_INCLUDE;
}>;

type PeriodRunRow = Prisma.TaskScheduleRunGetPayload<{
  include: typeof RUN_TASK_STATUS_INCLUDE;
}>;

interface ScheduleSummaryRunSource {
  readonly id: string;
  readonly scheduledFor: Date;
  readonly periodKey: string | null;
  readonly triggerSource: string | null;
  readonly triggeredAt: Date | null;
  readonly status: string;
  readonly taskId: string | null;
  readonly task: {
    status: string;
    runtime: string | null;
    failureCode: string | null;
    failureAt: Date | null;
    failureExitCode: number | null;
  } | null;
  readonly error: string | null;
  readonly createdAt: Date;
}

const SCHEDULE_INCLUDE = {
  runs: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      scheduledFor: true,
      periodKey: true,
      triggerSource: true,
      triggeredAt: true,
      status: true,
      taskId: true,
      task: {
        select: {
          status: true,
          runtime: true,
          failureCode: true,
          failureAt: true,
          failureExitCode: true,
        },
      },
      error: true,
      createdAt: true,
    },
  },
} as const;

const RUN_TASK_STATUS_INCLUDE = {
  task: {
    select: {
      status: true,
      runtime: true,
      failureCode: true,
      failureAt: true,
      failureExitCode: true,
    },
  },
} as const;

interface KeysetCursor {
  readonly at: Date;
  readonly id: string;
}

interface OccurrenceDispatch {
  readonly schedule: ScheduleRow;
  readonly scheduledFor: Date;
  readonly periodKey: SchedulePeriodIdentity;
  readonly triggerSource: 'manual' | 'automatic';
  readonly triggeredAt: Date;
  readonly nextRunAt: Date | null;
  readonly claimedAt: Date;
  readonly token: string;
  readonly automatic: boolean;
}

type CommittedOccurrence =
  | {
      readonly kind: 'created';
      readonly runId: string;
      readonly taskId: string;
      readonly taskBody: CreateTaskBody;
    }
  | { readonly kind: 'skipped' };

class ScheduleClaimConflictError extends Error {}

@Injectable()
export class ScheduledTasksService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ScheduledTasksService.name);
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SCHEDULED_TASKS_DISABLED === '1') {
      await this.runRecoverySafely();
      return;
    }
    const pollMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_POLL_MS,
      DEFAULT_POLL_MS,
    );
    this.timer = setInterval(() => {
      void this.runTickSafely();
    }, pollMs);
    this.timer.unref?.();
    await this.runTickSafely();
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
    return this.toScheduleResponse(created, now);
  }

  async list(ownerUserId: string, limit?: number): Promise<ScheduleResponse[]> {
    const rows = await this.prisma.taskSchedule.findMany({
      where: { ownerUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: SCHEDULE_INCLUDE,
    });
    return this.toScheduleResponses(rows);
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
      items: await this.toScheduleResponses(page.items),
      nextCursor: page.nextCursor,
    };
  }

  async get(
    ownerUserId: string,
    id: string,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    return this.toScheduleResponse(
      await this.requireOwnedSchedule(ownerUserId, id),
      now,
    );
  }

  async update(
    ownerUserId: string,
    id: string,
    body: UpdateScheduleRequest,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const normalizedTemplate = body.taskTemplate
      ? await this.normalizeTemplate(ownerUserId, body.taskTemplate)
      : null;
    for (let attempt = 0; attempt < SCHEDULE_MUTATION_CAS_ATTEMPTS; attempt += 1) {
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
      const nextRunAt = recurrenceChanged
        ? enabled
          ? await this.advancePastConsumedPeriods(
              {
                id: current.id,
                cron: timing.cronExpression,
                timezone: timing.timezone,
              },
              computeNextScheduleRunAt({
                cronExpression: timing.cronExpression,
                timezone: timing.timezone,
                after: now,
              }),
            )
          : null
        : undefined;
      const updated = await this.prisma.taskSchedule.updateMany({
        where: {
          id,
          ownerUserId,
          updatedAt: current.updatedAt,
          nextRunAt: current.nextRunAt,
        },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(normalizedTemplate
            ? {
                repoId: normalizedTemplate.repoId,
                taskTemplate:
                  normalizedTemplate as unknown as Prisma.InputJsonObject,
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
          ...(recurrenceChanged ? { nextRunAt } : {}),
        },
      });
      if (updated.count === 1) {
        return this.toScheduleResponse(
          await this.requireOwnedSchedule(ownerUserId, id),
          now,
        );
      }
    }
    throw scheduleMutationConflict(id);
  }

  async pause(ownerUserId: string, id: string): Promise<ScheduleResponse> {
    await this.requireOwnedSchedule(ownerUserId, id);
    const updated = await this.prisma.taskSchedule.update({
      where: { id },
      data: {
        enabled: false,
        nextRunAt: null,
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
    for (let attempt = 0; attempt < SCHEDULE_MUTATION_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.requireOwnedSchedule(ownerUserId, id);
      const nextRunAt = await this.advancePastConsumedPeriods(
        current,
        computeNextScheduleRunAt({
          cronExpression: current.cron,
          timezone: current.timezone,
          after: now,
        }),
      );
      const updated = await this.prisma.taskSchedule.updateMany({
        where: {
          id,
          ownerUserId,
          updatedAt: current.updatedAt,
          nextRunAt: current.nextRunAt,
        },
        data: { enabled: true, nextRunAt },
      });
      if (updated.count === 1) {
        return this.toScheduleResponse(
          await this.requireOwnedSchedule(ownerUserId, id),
          now,
        );
      }
    }
    throw scheduleMutationConflict(id);
  }

  async dispatchNow(
    ownerUserId: string,
    id: string,
    bodyOrNow: DispatchScheduleRequest | Date = {},
    requestNow = new Date(),
  ): Promise<ScheduleResponse> {
    const body = bodyOrNow instanceof Date ? {} : bodyOrNow;
    const now = bodyOrNow instanceof Date ? bodyOrNow : requestNow;
    const schedule = await this.requireOwnedSchedule(ownerUserId, id);
    const period = computeCurrentSchedulePeriod({
      cronExpression: schedule.cron,
      timezone: schedule.timezone,
      at: now,
      nextRunAt: schedule.nextRunAt,
    });
    if (body.expectedPeriodKey && body.expectedPeriodKey !== period.key) {
      if (await this.periodRunExists(schedule, body.expectedPeriodKey)) {
        return this.toScheduleResponse(
          await this.requireOwnedSchedule(ownerUserId, id),
          now,
        );
      }
      throw new ConflictException({
        error: 'schedule_period_changed',
        message: 'The schedule moved to another recurrence period.',
        expectedPeriodKey: body.expectedPeriodKey,
        currentPeriodKey: period.key,
      });
    }

    if (await this.periodRunExists(schedule, period.key)) {
      const repairedNextRunAt = await this.nextRunAtAfterManualPeriod(
        schedule,
        period.key,
        now,
      );
      if (
        repairedNextRunAt &&
        schedule.nextRunAt &&
        repairedNextRunAt.getTime() !== schedule.nextRunAt.getTime()
      ) {
        await this.advanceConsumedSchedule(schedule, repairedNextRunAt, now);
      }
      return this.toScheduleResponse(
        await this.requireOwnedSchedule(ownerUserId, id),
        now,
      );
    }

    const nextRunAt = await this.nextRunAtAfterManualPeriod(
      schedule,
      period.key,
      now,
    );
    const dispatched = await this.dispatchOccurrence({
      schedule,
      scheduledFor: period.scheduledFor ?? now,
      periodKey: period.key,
      triggerSource: 'manual',
      triggeredAt: now,
      nextRunAt,
      claimedAt: now,
      token: randomUUID(),
      automatic: false,
    });
    if (!dispatched) {
      if (await this.periodRunExists(schedule, period.key)) {
        return this.toScheduleResponse(
          await this.requireOwnedSchedule(ownerUserId, id),
          now,
        );
      }
      throw new ConflictException({
        error: 'schedule_dispatch_conflict',
        message: 'Schedule is already dispatching or has changed.',
        currentPeriodKey: period.key,
      });
    }
    return this.toScheduleResponse(
      await this.requireOwnedSchedule(ownerUserId, id),
      now,
    );
  }

  private async runTickSafely(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.runRecoverySafely();
      try {
        await this.tick();
      } catch (err) {
        this.logger.warn(`scheduled task tick failed: ${errorMessage(err)}`);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async runRecoverySafely(): Promise<void> {
    try {
      await this.recoverPendingAdmissions();
    } catch (err) {
      this.logger.warn(`scheduled task recovery failed: ${errorMessage(err)}`);
    }
  }

  async delete(ownerUserId: string, id: string): Promise<void> {
    const deleted = await this.prisma.taskSchedule.deleteMany({
      where: {
        id,
        ownerUserId,
        runs: {
          none: {
            status: 'created',
            task: { status: 'pending' },
          },
        },
      },
    });
    if (deleted.count === 1) return;

    const existing = await this.prisma.taskSchedule.findFirst({
      where: { id, ownerUserId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Schedule not found: ${id}`);
    throw new ConflictException(
      'Schedule has a pending task that must finish admission before deletion',
    );
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
      include: RUN_TASK_STATUS_INCLUDE,
    });
    return rows.map((row) => this.toRunResponse(row));
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
      include: RUN_TASK_STATUS_INCLUDE,
    });
    const page = pageRows(rows, args.limit, (row) => row.scheduledFor);
    return {
      items: page.items.map((row) => this.toRunResponse(row)),
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
      if (!row.nextRunAt) continue;
      const periodKey = computeSchedulePeriodForOccurrence({
        cronExpression: row.cron,
        timezone: row.timezone,
        scheduledFor: row.nextRunAt,
      });
      const nextRunAt = computeNextRunAfterPeriod({
        cronExpression: row.cron,
        timezone: row.timezone,
        after: now,
        consumedPeriodKey: periodKey,
      });
      if (await this.periodRunExists(row, periodKey)) {
        await this.advanceConsumedSchedule(row, nextRunAt, now);
        continue;
      }
      const dispatched = await this.dispatchOccurrence({
        schedule: row,
        scheduledFor: row.nextRunAt,
        periodKey,
        triggerSource: 'automatic',
        triggeredAt: now,
        nextRunAt,
        claimedAt: now,
        token: randomUUID(),
        automatic: true,
      });
      if (dispatched) fired += 1;
    }
    return fired;
  }

  async recoverPendingAdmissions(limit = 100): Promise<number> {
    const requestedBatchSize = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const batchSize = Math.max(1, Math.min(requestedBatchSize, 1_000));
    let recovered = 0;
    while (true) {
      const claimedAt = new Date();
      const rows = await this.prisma.taskScheduleRun.findMany({
        where: {
          status: 'created',
          taskId: { not: null },
          task: { status: 'pending' },
          OR: [
            { admissionClaimUntil: null },
            { admissionClaimUntil: { lt: claimedAt } },
          ],
        },
        take: batchSize,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          schedule: { select: { ownerUserId: true } },
          task: true,
        },
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        if (!row.task) continue;
        const token = randomUUID();
        const claimed = await this.claimPendingAdmission({
          runId: row.id,
          taskId: row.task.id,
          claimedAt: new Date(),
          token,
        });
        if (!claimed) continue;

        let release = false;
        try {
          await this.tasks.admitCreatedTask(
            row.task.id,
            taskBodyFromRow(row.task),
            row.schedule.ownerUserId,
          );
          const current = await this.prisma.task.findUnique({
            where: { id: row.task.id },
            select: { status: true },
          });
          release = current === null || current.status !== 'pending';
          if (release && current !== null) {
            recovered += 1;
          } else if (current !== null) {
            this.logger.warn(
              `scheduled task recovery left ${row.task.id} pending; retry is deferred until the claim lease expires`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `scheduled task recovery admission failed for ${row.task.id}: ${errorMessage(err)}`,
          );
        } finally {
          if (release) {
            await this.releaseAdmissionClaim(row.id, token);
          }
        }
      }

      if (rows.length < batchSize) break;
    }
    if (recovered > 0) {
      this.logger.log(
        `scheduled task recovery: admitted ${recovered} pending scheduled task(s)`,
      );
    }
    return recovered;
  }

  private async claimPendingAdmission(args: {
    readonly runId: string;
    readonly taskId: string;
    readonly claimedAt: Date;
    readonly token: string;
  }): Promise<boolean> {
    const claimLeaseMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.taskScheduleRun.updateMany({
        where: {
          id: args.runId,
          taskId: args.taskId,
          status: 'created',
          OR: [
            { admissionClaimUntil: null },
            { admissionClaimUntil: { lt: args.claimedAt } },
          ],
        },
        data: {
          admissionClaimToken: args.token,
          admissionClaimUntil: new Date(args.claimedAt.getTime() + claimLeaseMs),
        },
      });
      if (claimed.count !== 1) return false;

      const task = await tx.task.findUnique({
        where: { id: args.taskId },
        select: { status: true },
      });
      if (task?.status === 'pending') return true;

      await tx.taskScheduleRun.updateMany({
        where: { id: args.runId, admissionClaimToken: args.token },
        data: { admissionClaimToken: null, admissionClaimUntil: null },
      });
      return false;
    });
  }

  private async dispatchOccurrence(
    dispatch: OccurrenceDispatch,
  ): Promise<boolean> {
    let committed: CommittedOccurrence;
    try {
      committed = await this.persistOccurrence(dispatch);
    } catch (err) {
      if (err instanceof ScheduleClaimConflictError || isUniqueViolation(err)) {
        return false;
      }
      const failed = await this.persistFailedOccurrence(
        dispatch,
        errorMessage(err),
      );
      if (!failed) return false;
      await this.releaseClaim(dispatch);
      return true;
    }

    if (committed.kind === 'created') {
      let admissionFailed = false;
      try {
        await this.tasks.admitCreatedTask(
          committed.taskId,
          committed.taskBody,
          dispatch.schedule.ownerUserId,
        );
      } catch (err) {
        admissionFailed = true;
        // The task row and run ledger are already committed. Leave the task
        // pending so startup recovery can retry admission without duplicating it.
        this.logger.warn(
          `scheduled task admission failed for ${committed.taskId}: ${errorMessage(err)}`,
        );
      }
      if (!admissionFailed) {
        try {
          const current = await this.prisma.task.findUnique({
            where: { id: committed.taskId },
            select: { status: true },
          });
          if (current?.status === 'pending') {
            this.logger.warn(
              `scheduled task admission left ${committed.taskId} pending; retry is deferred until the claim lease expires`,
            );
            await this.releaseClaim(dispatch);
            return true;
          }
        } catch (err) {
          this.logger.warn(
            `scheduled task admission status check failed for ${committed.taskId}: ${errorMessage(err)}`,
          );
          await this.releaseClaim(dispatch);
          return true;
        }
      }
      if (!admissionFailed) {
        await this.releaseAdmissionClaim(committed.runId, dispatch.token);
      }
    }
    await this.releaseClaim(dispatch);
    return true;
  }

  private async persistOccurrence(
    dispatch: OccurrenceDispatch,
  ): Promise<CommittedOccurrence> {
    const claimLeaseMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.taskSchedule.updateMany({
        where: {
          id: dispatch.schedule.id,
          updatedAt: dispatch.schedule.updatedAt,
          nextRunAt: dispatch.schedule.nextRunAt,
          ...(dispatch.automatic ? { enabled: true } : {}),
          OR: [
            { claimUntil: null },
            { claimUntil: { lt: dispatch.claimedAt } },
          ],
        },
        data: {
          nextRunAt: dispatch.nextRunAt,
          claimToken: dispatch.token,
          claimUntil: new Date(dispatch.claimedAt.getTime() + claimLeaseMs),
        },
      });
      if (claimed.count !== 1) throw new ScheduleClaimConflictError();

      await this.assertOwnerAvailable(dispatch.schedule.ownerUserId, tx);
      const template = ScheduleTaskTemplateSchema.parse(
        dispatch.schedule.taskTemplate,
      );
      if (dispatch.schedule.overlapPolicy === 'skip') {
        const active = await tx.taskScheduleRun.findFirst({
          where: {
            scheduleId: dispatch.schedule.id,
            task: { status: { in: [...ACTIVE_TASK_STATUSES] } },
          },
          select: { id: true },
        });
        if (active) {
          await tx.taskScheduleRun.create({
            data: {
              scheduleId: dispatch.schedule.id,
              scheduledFor: dispatch.scheduledFor,
              periodKey: dispatch.periodKey,
              triggerSource: dispatch.triggerSource,
              triggeredAt: dispatch.triggeredAt,
              status: 'skipped',
              error: 'overlap: prior scheduled task still active',
            },
          });
          return { kind: 'skipped' };
        }
      }

      const { repoId, ...taskBody } = template;
      await tx.taskScheduleRun.create({
        data: {
          scheduleId: dispatch.schedule.id,
          scheduledFor: dispatch.scheduledFor,
          periodKey: dispatch.periodKey,
          triggerSource: dispatch.triggerSource,
          triggeredAt: dispatch.triggeredAt,
          status: 'claimed',
        },
      });
      const task = await this.tasks.createTaskRow(
        repoId,
        taskBody,
        tx as unknown as PrismaService,
        'headless-exec',
        dispatch.schedule.ownerUserId,
      );
      const run = await tx.taskScheduleRun.update({
        where: {
          scheduleId_scheduledFor: {
            scheduleId: dispatch.schedule.id,
            scheduledFor: dispatch.scheduledFor,
          },
        },
        data: {
          status: 'created',
          taskId: task.id,
          admissionClaimToken: dispatch.token,
          admissionClaimUntil: new Date(
            dispatch.claimedAt.getTime() + claimLeaseMs,
          ),
        },
      });
      return { kind: 'created', runId: run.id, taskId: task.id, taskBody };
    });
  }

  private async persistFailedOccurrence(
    dispatch: OccurrenceDispatch,
    error: string,
  ): Promise<boolean> {
    const claimLeaseMs = positiveIntFromEnv(
      process.env.SCHEDULED_TASKS_CLAIM_LEASE_MS,
      DEFAULT_CLAIM_LEASE_MS,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.taskSchedule.updateMany({
          where: {
            id: dispatch.schedule.id,
            updatedAt: dispatch.schedule.updatedAt,
            nextRunAt: dispatch.schedule.nextRunAt,
            ...(dispatch.automatic ? { enabled: true } : {}),
            OR: [
              { claimUntil: null },
              { claimUntil: { lt: dispatch.claimedAt } },
            ],
          },
          data: {
            nextRunAt: dispatch.nextRunAt,
            claimToken: dispatch.token,
            claimUntil: new Date(dispatch.claimedAt.getTime() + claimLeaseMs),
          },
        });
        if (claimed.count !== 1) throw new ScheduleClaimConflictError();
        await tx.taskScheduleRun.create({
          data: {
            scheduleId: dispatch.schedule.id,
            scheduledFor: dispatch.scheduledFor,
            periodKey: dispatch.periodKey,
            triggerSource: dispatch.triggerSource,
            triggeredAt: dispatch.triggeredAt,
            status: 'failed',
            error,
          },
        });
      });
      return true;
    } catch (err) {
      if (err instanceof ScheduleClaimConflictError || isUniqueViolation(err)) {
        return false;
      }
      throw err;
    }
  }

  private async releaseClaim(dispatch: OccurrenceDispatch): Promise<void> {
    await this.releaseScheduleClaim(dispatch.schedule.id, dispatch.token);
  }

  private async periodRunExists(
    schedule: Pick<ScheduleRow, 'id' | 'cron' | 'timezone'>,
    periodKey: SchedulePeriodIdentity,
  ): Promise<boolean> {
    return (await this.findPeriodRun(schedule, periodKey)) !== null;
  }

  private async findPeriodRun(
    schedule: Pick<ScheduleRow, 'id' | 'cron' | 'timezone'>,
    periodKey: SchedulePeriodIdentity,
  ): Promise<PeriodRunRow | null> {
    const keyed = await this.prisma.taskScheduleRun.findFirst({
      where: { scheduleId: schedule.id, periodKey },
      include: RUN_TASK_STATUS_INCLUDE,
    });
    if (keyed) return keyed;

    const legacy = await this.prisma.taskScheduleRun.findFirst({
      where: {
        scheduleId: schedule.id,
        periodKey: null,
        scheduledFor: legacyPeriodCandidateWindow(periodKey),
      },
      orderBy: { createdAt: 'desc' },
      include: RUN_TASK_STATUS_INCLUDE,
    });
    if (
      legacy &&
      effectivePeriodKey(schedule, legacy) === periodKey
    ) {
      return legacy;
    }

    const otherCandidates = await this.prisma.taskScheduleRun.findMany({
      where: {
        scheduleId: schedule.id,
        periodKey: null,
        scheduledFor: legacyPeriodCandidateWindow(periodKey),
      },
      orderBy: { createdAt: 'desc' },
      include: RUN_TASK_STATUS_INCLUDE,
    });
    return (
      otherCandidates.find(
        (candidate) => effectivePeriodKey(schedule, candidate) === periodKey,
      ) ?? null
    );
  }

  private async nextRunAtAfterManualPeriod(
    schedule: ScheduleRow,
    periodKey: SchedulePeriodIdentity,
    now: Date,
  ): Promise<Date | null> {
    if (!schedule.enabled || !schedule.nextRunAt) return schedule.nextRunAt;
    const nextRunPeriodKey = computeSchedulePeriodForOccurrence({
      cronExpression: schedule.cron,
      timezone: schedule.timezone,
      scheduledFor: schedule.nextRunAt,
    });
    const shouldAdvance =
      schedule.nextRunAt.getTime() <= now.getTime() ||
      nextRunPeriodKey === periodKey;
    const candidate = shouldAdvance
      ? computeNextRunAfterPeriod({
          cronExpression: schedule.cron,
          timezone: schedule.timezone,
          after: new Date(
            Math.max(now.getTime(), schedule.nextRunAt.getTime()),
          ),
          consumedPeriodKey: periodKey,
        })
      : schedule.nextRunAt;
    return this.advancePastConsumedPeriods(schedule, candidate);
  }

  private async advancePastConsumedPeriods(
    schedule: Pick<ScheduleRow, 'id' | 'cron' | 'timezone'>,
    initialNextRunAt: Date,
  ): Promise<Date> {
    let nextRunAt = initialNextRunAt;
    while (true) {
      const periodKey = computeSchedulePeriodForOccurrence({
        cronExpression: schedule.cron,
        timezone: schedule.timezone,
        scheduledFor: nextRunAt,
      });
      if (!(await this.periodRunExists(schedule, periodKey))) return nextRunAt;
      nextRunAt = computeNextRunAfterPeriod({
        cronExpression: schedule.cron,
        timezone: schedule.timezone,
        after: nextRunAt,
        consumedPeriodKey: periodKey,
      });
    }
  }

  private async advanceConsumedSchedule(
    schedule: ScheduleRow,
    nextRunAt: Date,
    now: Date,
  ): Promise<void> {
    await this.prisma.taskSchedule.updateMany({
      where: {
        id: schedule.id,
        updatedAt: schedule.updatedAt,
        nextRunAt: schedule.nextRunAt,
        enabled: true,
        OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
      },
      data: { nextRunAt, claimToken: null, claimUntil: null },
    });
  }

  private async releaseScheduleClaim(
    scheduleId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.prisma.taskSchedule.updateMany({
        where: { id: scheduleId, claimToken: token },
        data: { claimToken: null, claimUntil: null },
      });
    } catch (err) {
      // A committed occurrence must not look failed merely because best-effort
      // lease cleanup failed. The token remains bounded by claimUntil.
      this.logger.warn(
        `scheduled task claim cleanup failed for ${scheduleId}: ${errorMessage(err)}`,
      );
    }
  }

  private async releaseAdmissionClaim(
    runId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.prisma.taskScheduleRun.updateMany({
        where: { id: runId, admissionClaimToken: token },
        data: { admissionClaimToken: null, admissionClaimUntil: null },
      });
    } catch (err) {
      this.logger.warn(
        `scheduled task admission claim cleanup failed for ${runId}: ${errorMessage(err)}`,
      );
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

  private async assertOwnerAvailable(
    ownerUserId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const owner = await client.user.findUnique({
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

  private async toScheduleResponse(
    row: ScheduleRow,
    now = new Date(),
  ): Promise<ScheduleResponse> {
    const [response] = await this.toScheduleResponses([row], now);
    if (!response) throw new Error('Schedule response projection is empty.');
    return response;
  }

  private async toScheduleResponses(
    rows: readonly ScheduleRow[],
    now = new Date(),
  ): Promise<ScheduleResponse[]> {
    const contexts = rows.map((row) => {
      const currentPeriod = computeCurrentSchedulePeriod({
        cronExpression: row.cron,
        timezone: row.timezone,
        at: now,
        nextRunAt: row.nextRunAt,
      });
      const latest = row.runs[0] ?? null;
      return { row, currentPeriod, latest };
    });
    const currentRuns = new Map<string, ScheduleSummaryRunSource>();
    const unresolved = contexts.filter(({ row, currentPeriod, latest }) => {
      if (!latest) return false;
      if (effectivePeriodKey(row, latest) !== currentPeriod.key) return true;
      currentRuns.set(row.id, latest);
      return false;
    });

    if (unresolved.length > 0) {
      const keyedRuns = await this.prisma.taskScheduleRun.findMany({
        where: {
          OR: unresolved.map(({ row, currentPeriod }) => ({
            scheduleId: row.id,
            periodKey: currentPeriod.key,
          })),
        },
        include: RUN_TASK_STATUS_INCLUDE,
      });
      const expectedPeriodBySchedule = new Map(
        unresolved.map(({ row, currentPeriod }) => [
          row.id,
          currentPeriod.key,
        ]),
      );
      for (const run of keyedRuns) {
        if (run.periodKey === expectedPeriodBySchedule.get(run.scheduleId)) {
          currentRuns.set(run.scheduleId, run);
        }
      }

      const legacyContexts = unresolved.filter(
        ({ row }) => !currentRuns.has(row.id),
      );
      if (legacyContexts.length > 0) {
        const legacyRuns = await this.prisma.taskScheduleRun.findMany({
          where: {
            OR: legacyContexts.map(({ row, currentPeriod }) => ({
              scheduleId: row.id,
              periodKey: null,
              scheduledFor: legacyPeriodCandidateWindow(currentPeriod.key),
            })),
          },
          orderBy: { createdAt: 'desc' },
          include: RUN_TASK_STATUS_INCLUDE,
        });
        const contextBySchedule = new Map(
          legacyContexts.map((context) => [context.row.id, context]),
        );
        for (const run of legacyRuns) {
          if (run.periodKey !== null || currentRuns.has(run.scheduleId)) continue;
          const context = contextBySchedule.get(run.scheduleId);
          if (
            context &&
            effectivePeriodKey(context.row, run) === context.currentPeriod.key
          ) {
            currentRuns.set(run.scheduleId, run);
          }
        }
      }
    }

    return contexts.map(({ row, currentPeriod, latest }) => {
      const latestRun = scheduleRunSummary(latest);
      const currentRun = scheduleRunSummary(currentRuns.get(row.id) ?? null);
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
        latestRun,
        currentPeriod: {
          ...currentPeriod,
          scheduledFor: currentRun?.scheduledFor ?? currentPeriod.scheduledFor,
          run: currentRun,
        },
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    });
  }

  private toRunResponse(row: {
    id: string;
    scheduleId: string;
    scheduledFor: Date;
    periodKey: string | null;
    triggerSource: string | null;
    triggeredAt: Date | null;
    status: string;
    taskId: string | null;
    task: {
      status: string;
      runtime?: string | null;
      failureCode?: string | null;
      failureAt?: Date | null;
      failureExitCode?: number | null;
    } | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ScheduleRunResponse {
    return ScheduleRunResponseSchema.parse({
      ...row,
      taskStatus: row.task?.status ?? null,
      taskFailure: row.task ? taskFailureFromRecord(row.task) : null,
    });
  }
}

function scheduleRunSummary(run: ScheduleSummaryRunSource | null) {
  return run
    ? {
        ...run,
        taskStatus: run.task?.status ?? null,
        taskFailure: run.task ? taskFailureFromRecord(run.task) : null,
      }
    : null;
}

function effectivePeriodKey(
  schedule: Pick<ScheduleRow, 'cron' | 'timezone'>,
  run: { periodKey: string | null; scheduledFor: Date },
): SchedulePeriodIdentity {
  return (
    run.periodKey ??
    computeSchedulePeriodForOccurrence({
      cronExpression: schedule.cron,
      timezone: schedule.timezone,
      scheduledFor: run.scheduledFor,
    })
  );
}

function legacyPeriodCandidateWindow(
  periodKey: SchedulePeriodIdentity,
): { gte: Date; lt: Date } {
  const separator = periodKey.indexOf(':');
  const kind = periodKey.slice(0, separator);
  const value = periodKey.slice(separator + 1);
  if (!value) throw new Error(`Invalid schedule period key: ${periodKey}`);
  if (kind === 'cron') {
    const at = new Date(value);
    return { gte: at, lt: new Date(at.getTime() + 1) };
  }
  if (kind === 'day' || kind === 'week') {
    const start = new Date(`${value}T00:00:00.000Z`);
    const beforeDays = 2;
    const afterDays = kind === 'day' ? 3 : 9;
    return {
      gte: new Date(start.getTime() - beforeDays * 24 * 60 * 60_000),
      lt: new Date(start.getTime() + afterDays * 24 * 60 * 60_000),
    };
  }
  if (kind === 'month') {
    const [yearText, monthText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const next = new Date(Date.UTC(year, month, 1));
    return {
      gte: new Date(start.getTime() - 2 * 24 * 60 * 60_000),
      lt: new Date(next.getTime() + 2 * 24 * 60 * 60_000),
    };
  }
  throw new Error(`Unsupported schedule period key: ${periodKey}`);
}

function scheduleMutationConflict(scheduleId: string): ConflictException {
  return new ConflictException({
    error: 'schedule_mutation_conflict',
    message: 'Schedule changed while the update was being applied.',
    scheduleId,
  });
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

function computeNextRunAfterPeriod(input: {
  cronExpression: string;
  timezone: string;
  after: Date;
  consumedPeriodKey: SchedulePeriodIdentity;
}): Date {
  let candidate = computeNextScheduleRunAt(input);
  while (
    computeSchedulePeriodForOccurrence({
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      scheduledFor: candidate,
    }) === input.consumedPeriodKey
  ) {
    candidate = computeNextScheduleRunAt({
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      after: candidate,
    });
  }
  return candidate;
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
