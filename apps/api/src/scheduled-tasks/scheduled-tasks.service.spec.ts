import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type UpdateScheduleRequest,
} from '@cap/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type { TasksService } from '../tasks/tasks.service';
import { ScheduledTasksService } from './scheduled-tasks.service';

const USER_A = 'acct-a';
const USER_B = 'acct-b';
const REPO_ID = '11111111-1111-4111-8111-111111111111';
const ENV_ID = '22222222-2222-4222-8222-222222222222';

interface ScheduleRow {
  id: string;
  ownerUserId: string;
  repoId: string;
  name: string | null;
  taskTemplate: Record<string, unknown>;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  overlapPolicy: string;
  misfirePolicy: string;
  claimToken: string | null;
  claimUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  runs?: RunRow[];
}

interface RunRow {
  id: string;
  scheduleId: string;
  scheduledFor: Date;
  periodKey: string | null;
  triggerSource: string | null;
  triggeredAt: Date | null;
  status: string;
  taskId: string | null;
  error: string | null;
  admissionClaimToken?: string | null;
  admissionClaimUntil?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  task?: TaskRow | null;
  schedule?: { ownerUserId: string };
}

interface TaskRow {
  id: string;
  repoId: string;
  prompt: string;
  status: string;
  failureCode?: string | null;
  failureAt?: Date | null;
  failureExitCode?: number | null;
  createdAt: Date;
  branch: string | null;
  strategy: string | null;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  runtime: string | null;
  sandboxEnvironmentId: string | null;
  deliver: string | null;
}

interface ClaimUntilPredicate {
  claimUntil?: { lt?: Date } | null;
}

interface AdmissionClaimUntilPredicate {
  admissionClaimUntil?: { lt?: Date } | null;
}

interface TaskScheduleFindManyArgs {
  where?: {
    ownerUserId?: string;
    enabled?: boolean;
    nextRunAt?: { lte: Date };
    OR?: ClaimUntilPredicate[];
  };
  take?: number;
}

interface TaskScheduleUpdateManyArgs {
  where: {
    id?: string;
    ownerUserId?: string;
    enabled?: boolean;
    claimToken?: string | null;
    nextRunAt?: Date | null;
    updatedAt?: Date;
    OR?: ClaimUntilPredicate[];
  };
  data: Partial<ScheduleRow>;
}

interface TaskScheduleRunFindManyArgs {
  where?: {
    scheduleId?: string;
    periodKey?: string;
    status?: string;
    taskId?: string | { not: null };
    admissionClaimToken?: string | null;
    task?: { status: string };
    OR?: AdmissionClaimUntilPredicate[];
  };
  include?: {
    task?: boolean | { select?: { status?: boolean } };
    schedule?: boolean | { select?: { ownerUserId?: boolean } };
  };
  take?: number;
}

class FakePrisma {
  users = new Map<string, { allowed: boolean }>([
    [USER_A, { allowed: true }],
    [USER_B, { allowed: true }],
  ]);
  schedules: ScheduleRow[] = [];
  runs: RunRow[] = [];
  tasks: TaskRow[] = [];
  runFindManyCalls = 0;
  seq = 0;

  constructor(private readonly runCreateThrows: ReadonlySet<string> = new Set()) {}

  user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.users.get(where.id) ?? null,
  };

  taskSchedule = {
    create: async ({ data }: { data: Partial<ScheduleRow> }) => {
      const now = new Date('2026-07-09T00:00:00.000Z');
      const row: ScheduleRow = {
        id: `00000000-0000-4000-a000-${(++this.seq).toString().padStart(12, '0')}`,
        ownerUserId: data.ownerUserId!,
        repoId: data.repoId!,
        name: data.name ?? null,
        taskTemplate: data.taskTemplate as Record<string, unknown>,
        cron: data.cron!,
        timezone: data.timezone!,
        enabled: data.enabled ?? true,
        nextRunAt: data.nextRunAt ?? null,
        overlapPolicy: data.overlapPolicy ?? 'skip',
        misfirePolicy: data.misfirePolicy ?? 'fire-once',
        claimToken: null,
        claimUntil: null,
        createdAt: now,
        updatedAt: now,
      };
      this.schedules.push(row);
      return this.withRuns(row);
    },
    findMany: async (args: TaskScheduleFindManyArgs = {}) => {
      let rows = [...this.schedules];
      const where = args.where ?? {};
      if (where.ownerUserId) rows = rows.filter((row) => row.ownerUserId === where.ownerUserId);
      if (where.enabled !== undefined) rows = rows.filter((row) => row.enabled === where.enabled);
      const dueBefore = where.nextRunAt?.lte;
      if (dueBefore) {
        rows = rows.filter((row) => row.nextRunAt !== null && row.nextRunAt <= dueBefore);
      }
      if (where.OR?.some((part) => part.claimUntil !== undefined)) {
        const cutoff = where.OR.find((part) => part.claimUntil?.lt)?.claimUntil?.lt;
        rows = rows.filter((row) =>
          cutoff ? row.claimUntil === null || row.claimUntil < cutoff : row.claimUntil === null,
        );
      }
      rows.sort((a, b) => (a.nextRunAt?.getTime() ?? 0) - (b.nextRunAt?.getTime() ?? 0));
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((row) => this.withRuns(row));
    },
    findFirst: async ({ where }: { where: { id: string; ownerUserId: string } }) => {
      const row = this.schedules.find((item) => item.id === where.id && item.ownerUserId === where.ownerUserId);
      return row ? this.withRuns(row) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<ScheduleRow> }) => {
      const row = this.schedules.find((item) => item.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date('2026-07-09T00:01:00.000Z') });
      return this.withRuns(row);
    },
    updateMany: async ({ where, data }: TaskScheduleUpdateManyArgs) => {
      const matched = this.schedules.filter((row) => {
        if (where.id && row.id !== where.id) return false;
        if (where.ownerUserId && row.ownerUserId !== where.ownerUserId) {
          return false;
        }
        if (where.enabled !== undefined && row.enabled !== where.enabled) return false;
        if (where.claimToken !== undefined && row.claimToken !== where.claimToken) return false;
        if (
          where.updatedAt !== undefined &&
          row.updatedAt.getTime() !== where.updatedAt.getTime()
        ) {
          return false;
        }
        if (where.nextRunAt !== undefined) {
          if (where.nextRunAt === null) {
            if (row.nextRunAt !== null) return false;
          } else if (row.nextRunAt?.getTime() !== where.nextRunAt.getTime()) {
            return false;
          }
        }
        if (where.OR?.some((part) => part.claimUntil !== undefined)) {
          const cutoff = where.OR.find((part) => part.claimUntil?.lt)?.claimUntil?.lt;
          return cutoff
            ? row.claimUntil === null || row.claimUntil < cutoff
            : row.claimUntil === null;
        }
        return true;
      });
      for (const row of matched) {
        Object.assign(row, data, {
          updatedAt: new Date(row.updatedAt.getTime() + 1),
        });
      }
      return { count: matched.length };
    },
    deleteMany: async ({
      where,
    }: {
      where: {
        id: string;
        ownerUserId: string;
        runs?: { none: { status: string; task: { status: string } } };
      };
    }) => {
      const matched = this.schedules.find((row) => {
        if (row.id !== where.id || row.ownerUserId !== where.ownerUserId) return false;
        const runGuard = where.runs;
        if (!runGuard) return true;
        return !this.runs.some((run) => {
          if (run.scheduleId !== row.id || run.status !== runGuard.none.status) {
            return false;
          }
          const task = run.taskId
            ? this.tasks.find((candidate) => candidate.id === run.taskId)
            : null;
          return task?.status === runGuard.none.task.status;
        });
      });
      if (!matched) return { count: 0 };
      this.schedules = this.schedules.filter((row) => row.id !== matched.id);
      this.runs = this.runs.filter((run) => run.scheduleId !== matched.id);
      return { count: 1 };
    },
  };

  taskScheduleRun = {
    create: async ({
      data,
    }: {
      data: Pick<RunRow, 'scheduleId' | 'scheduledFor' | 'status'> &
        Partial<
          Pick<
            RunRow,
            'taskId' | 'error' | 'periodKey' | 'triggerSource' | 'triggeredAt'
          >
        >;
    }) => {
      if (this.runCreateThrows.has(data.status)) {
        throw new Error(`run ledger unavailable for ${data.status}`);
      }
      if (
        this.runs.some(
          (run) =>
            run.scheduleId === data.scheduleId &&
            (run.scheduledFor.getTime() === data.scheduledFor.getTime() ||
              (data.periodKey !== null &&
                data.periodKey !== undefined &&
                run.periodKey === data.periodKey)),
        )
      ) {
        throw new Error('unique violation');
      }
      const now = new Date('2026-07-09T00:02:00.000Z');
      const row: RunRow = {
        id: `00000000-0000-4000-b000-${(++this.seq).toString().padStart(12, '0')}`,
        scheduleId: data.scheduleId,
        scheduledFor: data.scheduledFor,
        periodKey: data.periodKey ?? null,
        triggerSource: data.triggerSource ?? null,
        triggeredAt: data.triggeredAt ?? null,
        status: data.status,
        taskId: data.taskId ?? null,
        error: data.error ?? null,
        admissionClaimToken: null,
        admissionClaimUntil: null,
        createdAt: now,
        updatedAt: now,
      };
      this.runs.push(row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: {
        scheduleId_scheduledFor: { scheduleId: string; scheduledFor: Date };
      };
      data: Partial<RunRow>;
    }) => {
      const key = where.scheduleId_scheduledFor;
      const row = this.runs.find(
        (run) =>
          run.scheduleId === key.scheduleId &&
          run.scheduledFor.getTime() === key.scheduledFor.getTime(),
      );
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date('2026-07-09T00:03:00.000Z') });
      return row;
    },
    findFirst: async ({
      where,
    }: {
      where: {
        scheduleId: string;
        periodKey?: string;
        task?: { status: { in: string[] } };
      };
      select?: { id?: boolean };
    }) => {
      return (
        this.runs.find((run) => {
          if (run.scheduleId !== where.scheduleId) return false;
          if (where.periodKey !== undefined) return run.periodKey === where.periodKey;
          if (!where.task) return true;
          const task = run.taskId ? this.tasks.find((row) => row.id === run.taskId) : null;
          return task ? where.task.status.in.includes(task.status) : false;
        }) ?? null
      );
    },
    findMany: async (args: TaskScheduleRunFindManyArgs = {}) => {
      this.runFindManyCalls += 1;
      let rows = [...this.runs];
      const where = args.where ?? {};
      if (where.scheduleId) rows = rows.filter((run) => run.scheduleId === where.scheduleId);
      if (where.periodKey) rows = rows.filter((run) => run.periodKey === where.periodKey);
      if (where.status) rows = rows.filter((run) => run.status === where.status);
      if (typeof where.taskId === 'string') {
        rows = rows.filter((run) => run.taskId === where.taskId);
      } else if (where.taskId?.not === null) {
        rows = rows.filter((run) => run.taskId !== null);
      }
      const taskStatus = where.task?.status;
      if (taskStatus) {
        rows = rows.filter((run) => {
          const task = run.taskId ? this.tasks.find((row) => row.id === run.taskId) : null;
          return task?.status === taskStatus;
        });
      }
      if (where.OR?.some((part) => part.admissionClaimUntil !== undefined)) {
        const cutoff = where.OR.find((part) => part.admissionClaimUntil?.lt)
          ?.admissionClaimUntil?.lt;
        rows = rows.filter((run) =>
          cutoff
            ? !run.admissionClaimUntil || run.admissionClaimUntil < cutoff
            : !run.admissionClaimUntil,
        );
      }
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (args.take) rows = rows.slice(0, args.take);
      if (args.include?.task || args.include?.schedule) {
        return rows.map((run) => ({
          ...run,
          task: run.taskId ? this.tasks.find((task) => task.id === run.taskId) ?? null : null,
          schedule: {
            ownerUserId:
              this.schedules.find((schedule) => schedule.id === run.scheduleId)?.ownerUserId ?? USER_A,
          },
        }));
      }
      return rows;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: TaskScheduleRunFindManyArgs['where'] & { id?: string };
      data: Partial<RunRow>;
    }) => {
      const matched = this.runs.filter((run) => {
        if (where?.id && run.id !== where.id) return false;
        if (where?.status && run.status !== where.status) return false;
        if (typeof where?.taskId === 'string' && run.taskId !== where.taskId) {
          return false;
        }
        if (
          where?.admissionClaimToken !== undefined &&
          (run.admissionClaimToken ?? null) !== where.admissionClaimToken
        ) {
          return false;
        }
        if (where?.OR?.some((part) => part.admissionClaimUntil !== undefined)) {
          const cutoff = where.OR.find((part) => part.admissionClaimUntil?.lt)
            ?.admissionClaimUntil?.lt;
          return cutoff
            ? !run.admissionClaimUntil || run.admissionClaimUntil < cutoff
            : !run.admissionClaimUntil;
        }
        return true;
      });
      for (const run of matched) Object.assign(run, data);
      return { count: matched.length };
    },
  };

  task = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.tasks.find((task) => task.id === where.id) ?? null,
  };

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const schedules = this.schedules.map((row) => ({ ...row }));
    const runs = this.runs.map((row) => ({ ...row }));
    const tasks = this.tasks.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (err) {
      this.schedules = schedules;
      this.runs = runs;
      this.tasks = tasks;
      throw err;
    }
  }

  withRuns(row: ScheduleRow): ScheduleRow {
    const runs = this.runs
      .filter((run) => run.scheduleId === row.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 1)
      .map((run) => ({
        ...run,
        task: run.taskId
          ? this.tasks.find((task) => task.id === run.taskId) ?? null
          : null,
      }));
    return { ...row, runs };
  }
}

function buildHarness(
  options: {
    createThrows?: boolean;
    admitFailures?: number;
    admitKeepsPending?: boolean;
    runCreateThrows?: string[];
  } = {},
) {
  const prisma = new FakePrisma(new Set(options.runCreateThrows));
  const normalizeCalls: Array<{ repoId: string; userId: string }> = [];
  const rowCalls: Array<{ repoId: string; userId?: string }> = [];
  const admitCalls: string[] = [];
  let remainingAdmissionFailures = options.admitFailures ?? 0;
  const tasks = {
    async normalizeTaskTemplateForSchedule(
      repoId: string,
      body: CreateTaskBody,
      userId: string,
    ) {
      normalizeCalls.push({ repoId, userId });
      return {
        ...body,
        repoId,
        runtime: body.runtime ?? 'codex',
        sandboxEnvironmentId: body.sandboxEnvironmentId ?? ENV_ID,
        deliver: body.deliver ?? 'none',
      };
    },
    async createTaskRow(repoId: string, body: CreateTaskBody, _tx: unknown, _mode: unknown, userId?: string) {
      if (options.createThrows) throw new Error('runtime not configured');
      rowCalls.push({ repoId, userId });
      const task: TaskRow = {
        id: `55555555-5555-4555-8555-${(prisma.tasks.length + 1).toString().padStart(12, '0')}`,
        repoId,
        prompt: body.prompt,
        status: 'pending',
        createdAt: new Date('2026-07-09T00:04:00.000Z'),
        branch: body.branch ?? null,
        strategy: body.strategy ?? null,
        skills: body.skills ?? [],
        idleTimeoutMs: body.idleTimeoutMs ?? null,
        deadlineMs: body.deadlineMs ?? null,
        runtime: body.runtime ?? null,
        sandboxEnvironmentId: body.sandboxEnvironmentId ?? null,
        deliver: body.deliver ?? null,
      };
      prisma.tasks.push(task);
      return {
        ...task,
        runtime: task.runtime ?? 'codex',
        executionMode: 'headless-exec',
      };
    },
    async admitCreatedTask(taskId: string) {
      admitCalls.push(taskId);
      if (remainingAdmissionFailures > 0) {
        remainingAdmissionFailures -= 1;
        throw new Error('admission interrupted');
      }
      if (!options.admitKeepsPending) {
        const task = prisma.tasks.find((row) => row.id === taskId);
        if (task) task.status = 'queued';
      }
    },
  } as unknown as TasksService;
  return {
    prisma,
    service: new ScheduledTasksService(prisma as unknown as PrismaService, tasks),
    normalizeCalls,
    rowCalls,
    admitCalls,
    tasks,
  };
}

function addDueSchedule(
  prisma: FakePrisma,
  overrides: Partial<ScheduleRow> = {},
): ScheduleRow {
  const row: ScheduleRow = {
    id: `99999999-9999-4999-8999-${(prisma.schedules.length + 1).toString().padStart(12, '0')}`,
    ownerUserId: USER_A,
    repoId: REPO_ID,
    name: null,
    taskTemplate: {
      repoId: REPO_ID,
      prompt: 'scheduled',
      runtime: 'codex',
      sandboxEnvironmentId: ENV_ID,
      deliver: 'none',
    },
    cron: '*/5 * * * *',
    timezone: 'UTC',
    enabled: true,
    nextRunAt: new Date('2026-07-09T00:00:00.000Z'),
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    claimToken: null,
    claimUntil: null,
    createdAt: new Date('2026-07-08T00:00:00.000Z'),
    updatedAt: new Date('2026-07-08T00:00:00.000Z'),
    ...overrides,
  };
  prisma.schedules.push(row);
  return row;
}

function addRecoverableRun(prisma: FakePrisma, index = prisma.tasks.length): RunRow {
  const schedule = addDueSchedule(prisma, {
    nextRunAt: new Date('2026-07-10T00:00:00.000Z'),
  });
  const suffix = (index + 1).toString().padStart(12, '0');
  const task: TaskRow = {
    id: `55555555-5555-4555-8555-${suffix}`,
    repoId: REPO_ID,
    prompt: `pending ${index + 1}`,
    status: 'pending',
    createdAt: new Date(Date.parse('2026-07-09T00:00:00.000Z') + index),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  };
  const run: RunRow = {
    id: `66666666-6666-4666-8666-${suffix}`,
    scheduleId: schedule.id,
    scheduledFor: new Date(Date.parse('2026-07-09T00:00:00.000Z') + index),
    periodKey: null,
    triggerSource: null,
    triggeredAt: null,
    status: 'created',
    taskId: task.id,
    error: null,
    createdAt: new Date(Date.parse('2026-07-09T00:00:00.000Z') + index),
    updatedAt: new Date(Date.parse('2026-07-09T00:00:00.000Z') + index),
  };
  prisma.tasks.push(task);
  prisma.runs.push(run);
  return run;
}

test('create normalizes the task template and scopes schedule reads to the owner', async () => {
  const { service, normalizeCalls } = buildHarness();
  const created = await service.create(USER_A, {
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    taskTemplate: { repoId: REPO_ID, prompt: 'daily' },
  });
  assert.equal(created.ownerUserId, USER_A);
  assert.equal(created.taskTemplate.sandboxEnvironmentId, ENV_ID);
  assert.equal(created.recurrence.kind, 'daily');
  assert.equal(created.recurrence.label, '每天 09:00');
  assert.deepEqual(normalizeCalls, [{ repoId: REPO_ID, userId: USER_A }]);
  assert.equal((await service.list(USER_A)).length, 1);
  assert.equal((await service.list(USER_B)).length, 0);
  await assert.rejects(() => service.get(USER_B, created.id), NotFoundException);
});

test('create accepts recurrence descriptors and keeps cron compatibility for custom summaries', async () => {
  const { prisma, service } = buildHarness();
  const created = await service.create(
    USER_A,
    CreateScheduleRequestSchema.parse({
      name: 'weekday check',
      recurrence: {
        kind: 'weekdays',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
      taskTemplate: { repoId: REPO_ID, prompt: 'weekday check' },
    }),
    new Date('2026-07-09T00:00:00.000Z'),
  );
  assert.equal(prisma.schedules[0].cron, '30 9 * * 1-5');
  assert.equal(prisma.schedules[0].timezone, 'Asia/Shanghai');
  assert.equal(created.recurrence.kind, 'weekdays');
  assert.equal(created.recurrence.label, '工作日 09:30');
  assert.equal(created.nextRunAt?.toISOString(), '2026-07-09T01:30:00.000Z');

  const custom = await service.create(
    USER_A,
    CreateScheduleRequestSchema.parse({
      cronExpression: '7,37 * * * *',
      timezone: 'UTC',
      taskTemplate: { repoId: REPO_ID, prompt: 'legacy cron' },
    }),
  );
  assert.equal(custom.cronExpression, '7,37 * * * *');
  assert.equal(custom.recurrence.kind, 'custom');
  assert.equal(custom.recurrence.label, '自定义重复');
});

test('sub-day descriptors round-trip through create, update, list, and get', async () => {
  const { prisma, service } = buildHarness();
  const hourly = await service.create(
    USER_A,
    CreateScheduleRequestSchema.parse({
      name: 'hourly check',
      recurrence: {
        kind: 'hourly',
        minuteOfHour: 15,
        timezone: 'Asia/Shanghai',
      },
      taskTemplate: { repoId: REPO_ID, prompt: 'hourly check' },
    }),
    new Date('2026-07-09T00:00:00.000Z'),
  );
  const interval = await service.create(
    USER_A,
    CreateScheduleRequestSchema.parse({
      name: 'interval check',
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 15,
        timezone: 'Europe/London',
      },
      taskTemplate: { repoId: REPO_ID, prompt: 'interval check' },
    }),
    new Date('2026-07-09T00:02:00.000Z'),
  );

  assert.equal(prisma.schedules[0].cron, '15 * * * *');
  assert.equal(hourly.recurrence.kind, 'hourly');
  assert.equal(hourly.recurrence.label, '每小时第 15 分钟');
  assert.equal(prisma.schedules[1].cron, '*/15 * * * *');
  assert.equal(interval.recurrence.kind, 'minuteInterval');
  assert.equal(interval.recurrence.label, '每 15 分钟');

  const listed = await service.list(USER_A);
  assert.deepEqual(
    listed.map((schedule) => schedule.recurrence.kind).sort(),
    ['hourly', 'minuteInterval'],
  );
  assert.equal((await service.get(USER_A, hourly.id)).recurrence.kind, 'hourly');
  assert.equal(
    (await service.get(USER_A, interval.id)).recurrence.kind,
    'minuteInterval',
  );

  const updated = await service.update(
    USER_A,
    hourly.id,
    UpdateScheduleRequestSchema.parse({
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 30,
        timezone: 'UTC',
      },
    }),
    new Date('2026-07-09T00:02:00.000Z'),
  );
  assert.equal(prisma.schedules[0].cron, '*/30 * * * *');
  assert.equal(updated.recurrence.kind, 'minuteInterval');
  assert.equal(updated.recurrence.label, '每 30 分钟');

  const beforeUpdate = {
    cron: prisma.schedules[0].cron,
    timezone: prisma.schedules[0].timezone,
    nextRunAt: prisma.schedules[0].nextRunAt?.toISOString(),
  };
  await assert.rejects(() =>
    service.update(
      USER_A,
      hourly.id,
      {
        recurrence: {
          kind: 'minuteInterval',
          intervalMinutes: 7,
          timezone: 'UTC',
        },
      } as unknown as UpdateScheduleRequest,
    ),
  );
  assert.deepEqual(
    {
      cron: prisma.schedules[0].cron,
      timezone: prisma.schedules[0].timezone,
      nextRunAt: prisma.schedules[0].nextRunAt?.toISOString(),
    },
    beforeUpdate,
  );

  const scheduleCount = prisma.schedules.length;
  await assert.rejects(() =>
    service.create(
      USER_A,
      {
        recurrence: {
          kind: 'minuteInterval',
          intervalMinutes: 60,
          timezone: 'UTC',
        },
        taskTemplate: { repoId: REPO_ID, prompt: 'invalid interval' },
      } as unknown as CreateScheduleRequest,
    ),
  );
  assert.equal(prisma.schedules.length, scheduleCount);
});

test('update changes only future schedule definition and leaves existing runs/tasks untouched', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
  });
  prisma.tasks.push({
    id: '55555555-5555-4555-8555-000000000001',
    repoId: REPO_ID,
    prompt: 'already created',
    status: 'running',
    createdAt: new Date('2026-07-09T00:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  });
  prisma.runs.push({
    id: '66666666-6666-4666-8666-000000000001',
    scheduleId: schedule.id,
    scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
    periodKey: null,
    triggerSource: null,
    triggeredAt: null,
    status: 'created',
    taskId: prisma.tasks[0].id,
    error: null,
    createdAt: new Date('2026-07-09T09:00:00.000Z'),
    updatedAt: new Date('2026-07-09T09:00:00.000Z'),
  });

  const updated = await service.update(
    USER_A,
    schedule.id,
    UpdateScheduleRequestSchema.parse({
      name: 'weekly check',
      recurrence: {
        kind: 'weekly',
        weekday: 1,
        time: '10:15',
        timezone: 'Europe/London',
      },
    }),
    new Date('2026-07-09T00:00:00.000Z'),
  );

  assert.equal(schedule.name, 'weekly check');
  assert.equal(schedule.cron, '15 10 * * 1');
  assert.equal(schedule.timezone, 'Europe/London');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-13T09:15:00.000Z');
  assert.equal(updated.recurrence.kind, 'weekly');
  assert.equal(updated.recurrence.label, '每周一 10:15');
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].taskId, prisma.tasks[0].id);
  assert.equal(prisma.tasks[0].status, 'running');
  await assert.rejects(
    () => service.update(USER_B, schedule.id, { name: 'wrong owner' }),
    NotFoundException,
  );
});

test('future definition changes preserve a live dispatch or recovery lease', async () => {
  const { prisma, service } = buildHarness();
  const claimToken = 'live-admission-claim';
  const claimUntil = new Date('2026-07-09T00:10:00.000Z');
  const schedule = addDueSchedule(prisma, { claimToken, claimUntil });

  await service.update(
    USER_A,
    schedule.id,
    UpdateScheduleRequestSchema.parse({
      recurrence: { kind: 'daily', time: '12:00', timezone: 'UTC' },
    }),
    new Date('2026-07-09T00:00:00.000Z'),
  );
  assert.equal(schedule.claimToken, claimToken);
  assert.equal(schedule.claimUntil?.getTime(), claimUntil.getTime());

  await service.pause(USER_A, schedule.id);
  assert.equal(schedule.claimToken, claimToken);
  assert.equal(schedule.claimUntil?.getTime(), claimUntil.getTime());

  await service.resume(
    USER_A,
    schedule.id,
    new Date('2026-07-09T00:00:00.000Z'),
  );
  assert.equal(schedule.claimToken, claimToken);
  assert.equal(schedule.claimUntil?.getTime(), claimUntil.getTime());
});

test('delete refuses to orphan a pending task that still needs admission', async () => {
  const { prisma, service } = buildHarness();
  const run = addRecoverableRun(prisma);

  await assert.rejects(
    () => service.delete(USER_A, run.scheduleId),
    ConflictException,
  );
  assert.equal(prisma.schedules.length, 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.tasks.length, 1);

  prisma.tasks[0].status = 'queued';
  await service.delete(USER_A, run.scheduleId);
  assert.equal(prisma.schedules.length, 0);
  assert.equal(prisma.runs.length, 0);
  assert.equal(prisma.tasks.length, 1);
  await assert.rejects(
    () => service.delete(USER_A, run.scheduleId),
    NotFoundException,
  );
});

test('ownerless create is rejected with the shared owner-required shape', async () => {
  const { service } = buildHarness();
  await assert.rejects(
    () =>
      service.create(undefined, {
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        overlapPolicy: 'skip',
        misfirePolicy: 'fire-once',
        taskTemplate: { repoId: REPO_ID, prompt: 'daily' },
      }),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestException);
      assert.deepEqual(err.getResponse(), {
        error: 'schedule_owner_required',
        message: 'Schedules require an authenticated account owner.',
      });
      return true;
    },
  );
});

test('raced scheduler ticks claim one occurrence and advance nextRunAt', async () => {
  const { prisma, service, rowCalls, admitCalls } = buildHarness();
  const schedule = addDueSchedule(prisma);
  const now = new Date('2026-07-09T00:12:00.000Z');
  const [first, second] = await Promise.all([service.tick(now), service.tick(now)]);
  assert.equal(first + second, 1);
  assert.equal(rowCalls.length, 1);
  assert.equal(admitCalls.length, 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].status, 'created');
  assert.ok(schedule.nextRunAt && schedule.nextRunAt > now);
});

test('dispatchNow consumes the current period and same-period retries reuse its task', async () => {
  const { prisma, service, rowCalls, admitCalls } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-09T09:00:00.000Z'),
  });

  const updated = await service.dispatchNow(
    USER_A,
    schedule.id,
    new Date('2026-07-09T08:00:00.000Z'),
  );

  assert.equal(rowCalls.length, 1);
  assert.equal(admitCalls.length, 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].status, 'created');
  assert.equal(prisma.runs[0].scheduledFor.toISOString(), '2026-07-09T09:00:00.000Z');
  assert.equal(prisma.runs[0].periodKey, 'day:2026-07-09');
  assert.equal(prisma.runs[0].triggerSource, 'manual');
  assert.equal(prisma.runs[0].triggeredAt?.toISOString(), '2026-07-09T08:00:00.000Z');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-10T09:00:00.000Z');
  assert.equal(updated.nextRunAt?.toISOString(), '2026-07-10T09:00:00.000Z');
  assert.equal(updated.latestRun?.taskId, prisma.tasks[0].id);
  assert.equal(updated.currentPeriod?.key, 'day:2026-07-09');
  assert.equal(updated.currentPeriod?.run?.taskId, prisma.tasks[0].id);

  const retried = await service.dispatchNow(
    USER_A,
    schedule.id,
    { expectedPeriodKey: 'day:2026-07-09' },
    new Date('2026-07-09T08:30:00.000Z'),
  );
  assert.equal(retried.currentPeriod?.run?.taskId, prisma.tasks[0].id);
  assert.equal(rowCalls.length, 1);
  assert.equal(admitCalls.length, 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(await service.tick(new Date('2026-07-09T09:00:00.000Z')), 0);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-10T09:00:00.000Z');
});

test('early sub-day dispatch consumes one nominal occurrence and retries reuse it', async () => {
  const { prisma, service, rowCalls, admitCalls } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '*/15 * * * *',
    nextRunAt: new Date('2026-07-09T08:15:00.000Z'),
  });
  const periodKey = 'cron:2026-07-09T08:15:00.000Z';

  const dispatched = await service.dispatchNow(
    USER_A,
    schedule.id,
    { expectedPeriodKey: periodKey },
    new Date('2026-07-09T08:10:00.000Z'),
  );

  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].scheduledFor.toISOString(), '2026-07-09T08:15:00.000Z');
  assert.equal(prisma.runs[0].periodKey, periodKey);
  assert.equal(prisma.runs[0].triggerSource, 'manual');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T08:30:00.000Z');
  assert.equal(dispatched.latestRun?.periodKey, periodKey);

  const retried = await service.dispatchNow(
    USER_A,
    schedule.id,
    { expectedPeriodKey: periodKey },
    new Date('2026-07-09T08:11:00.000Z'),
  );
  assert.equal(retried.latestRun?.periodKey, periodKey);
  assert.equal(rowCalls.length, 1);
  assert.equal(admitCalls.length, 1);
  assert.equal(prisma.tasks.length, 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T08:30:00.000Z');
});

test('manual and automatic sub-day dispatch compete for one nominal occurrence', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const now = new Date('2026-07-09T08:15:00.000Z');
  const periodKey = 'cron:2026-07-09T08:15:00.000Z';
  const schedule = addDueSchedule(prisma, {
    cron: '*/15 * * * *',
    nextRunAt: now,
  });

  const [manual, automatic] = await Promise.all([
    service.dispatchNow(
      USER_A,
      schedule.id,
      { expectedPeriodKey: periodKey },
      now,
    ),
    service.tick(now),
  ]);

  assert.equal(manual.latestRun?.periodKey, periodKey);
  assert.ok(automatic === 0 || automatic === 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].periodKey, periodKey);
  assert.equal(prisma.tasks.length, 1);
  assert.equal(rowCalls.length, 1);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T08:30:00.000Z');
});

test('manual retry reuses a sub-day occurrence after automatic dispatch advances it', async () => {
  const { prisma, service, rowCalls, admitCalls } = buildHarness();
  const scheduledFor = new Date('2026-07-09T08:15:00.000Z');
  const periodKey = `cron:${scheduledFor.toISOString()}`;
  const schedule = addDueSchedule(prisma, {
    cron: '*/15 * * * *',
    nextRunAt: scheduledFor,
  });

  assert.equal(await service.tick(scheduledFor), 1);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T08:30:00.000Z');
  assert.equal(prisma.runs[0]?.periodKey, periodKey);

  const retried = await service.dispatchNow(
    USER_A,
    schedule.id,
    { expectedPeriodKey: periodKey },
    new Date('2026-07-09T08:15:00.001Z'),
  );
  assert.equal(retried.latestRun?.periodKey, periodKey);
  assert.equal(retried.latestRun?.taskId, prisma.tasks[0]?.id);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.tasks.length, 1);
  assert.equal(rowCalls.length, 1);
  assert.equal(admitCalls.length, 1);

  await assert.rejects(
    () =>
      service.dispatchNow(
        USER_A,
        schedule.id,
        { expectedPeriodKey: 'cron:2026-07-09T08:00:00.000Z' },
        new Date('2026-07-09T08:15:00.001Z'),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.deepEqual(error.getResponse(), {
        error: 'schedule_period_changed',
        message: 'The schedule moved to another recurrence period.',
        expectedPeriodKey: 'cron:2026-07-09T08:00:00.000Z',
        currentPeriodKey: 'cron:2026-07-09T08:30:00.000Z',
      });
      return true;
    },
  );
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.tasks.length, 1);
});

test('schedule reads expose the linked task status without changing the dispatch result', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-09T09:00:00.000Z'),
  });

  const dispatched = await service.dispatchNow(
    USER_A,
    schedule.id,
    new Date('2026-07-09T08:00:00.000Z'),
  );
  assert.equal(dispatched.latestRun?.status, 'created');
  assert.equal(dispatched.latestRun?.taskStatus, 'queued');
  assert.ok(dispatched.latestRun?.createdAt);
  assert.equal(
    dispatched.latestRun.createdAt.toISOString(),
    '2026-07-09T00:02:00.000Z',
  );

  prisma.tasks[0].status = 'failed';
  prisma.tasks[0].runtime = 'claude-code';
  prisma.tasks[0].failureCode = 'runtime_auth_rejected';
  prisma.tasks[0].failureAt = new Date('2026-07-09T08:15:00.000Z');
  prisma.tasks[0].failureExitCode = 1;

  const refreshed = await service.get(
    USER_A,
    schedule.id,
    new Date('2026-07-09T08:30:00.000Z'),
  );
  assert.equal(refreshed.latestRun?.status, 'created');
  assert.equal(refreshed.latestRun?.taskStatus, 'failed');
  assert.equal(refreshed.latestRun?.taskFailure?.runtime, 'claude-code');
  assert.equal(refreshed.latestRun?.taskFailure?.code, 'runtime_auth_rejected');
  assert.equal(refreshed.latestRun?.error, null);
  assert.equal(refreshed.currentPeriod?.run?.taskStatus, 'failed');
  assert.equal(
    refreshed.currentPeriod?.run?.taskFailure?.code,
    'runtime_auth_rejected',
  );
  assert.equal('task' in (refreshed.latestRun ?? {}), false);

  const runs = await service.listRuns(USER_A, schedule.id);
  assert.equal(runs[0].status, 'created');
  assert.equal(runs[0].taskStatus, 'failed');
  assert.equal(runs[0].taskFailure?.runtime, 'claude-code');
  assert.equal(runs[0].taskFailure?.code, 'runtime_auth_rejected');
  assert.equal(runs[0].error, null);
  assert.equal(runs[0].createdAt.toISOString(), '2026-07-09T00:02:00.000Z');
  assert.equal('task' in runs[0], false);

  const page = await service.listRunsPage(USER_A, schedule.id, { limit: 10 });
  assert.equal(page.items[0].status, 'created');
  assert.equal(page.items[0].taskStatus, 'failed');
  assert.equal(page.items[0].taskFailure?.runtime, 'claude-code');
  assert.equal(page.items[0].taskFailure?.code, 'runtime_auth_rejected');
});

test('dispatchNow advances an already-due occurrence to avoid a duplicate scheduled fire', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 * * * *',
    nextRunAt: new Date('2026-07-09T08:00:00.000Z'),
  });

  await service.dispatchNow(
    USER_A,
    schedule.id,
    new Date('2026-07-09T08:05:00.000Z'),
  );

  assert.equal(prisma.runs[0].scheduledFor.toISOString(), '2026-07-09T08:00:00.000Z');
  assert.equal(prisma.runs[0].periodKey, 'cron:2026-07-09T08:00:00.000Z');
  assert.equal(prisma.runs[0].triggeredAt?.toISOString(), '2026-07-09T08:05:00.000Z');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T09:00:00.000Z');
  assert.equal(await service.tick(new Date('2026-07-09T08:05:00.000Z')), 0);
});

test('hourly occurrences across a DST fold keep distinct run and task identities', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const firstOccurrence = new Date('2026-11-01T05:00:00.000Z');
  const secondOccurrence = new Date('2026-11-01T06:00:00.000Z');
  const schedule = addDueSchedule(prisma, {
    cron: '0 * * * *',
    timezone: 'America/New_York',
    overlapPolicy: 'enqueue',
    nextRunAt: firstOccurrence,
  });

  assert.equal(await service.tick(firstOccurrence), 1);
  assert.equal(schedule.nextRunAt?.toISOString(), secondOccurrence.toISOString());
  assert.equal(await service.tick(secondOccurrence), 1);

  assert.deepEqual(
    prisma.runs.map((run) => run.periodKey),
    [
      'cron:2026-11-01T05:00:00.000Z',
      'cron:2026-11-01T06:00:00.000Z',
    ],
  );
  assert.deepEqual(
    prisma.runs.map((run) => run.scheduledFor.toISOString()),
    [firstOccurrence.toISOString(), secondOccurrence.toISOString()],
  );
  assert.equal(prisma.tasks.length, 2);
  assert.equal(rowCalls.length, 2);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-11-01T07:00:00.000Z');
});

test('minute-interval occurrences across a DST fold keep distinct run identities', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const occurrences = [
    '2026-11-01T05:00:00.000Z',
    '2026-11-01T05:15:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T05:45:00.000Z',
    '2026-11-01T06:00:00.000Z',
    '2026-11-01T06:15:00.000Z',
    '2026-11-01T06:30:00.000Z',
    '2026-11-01T06:45:00.000Z',
  ];
  const schedule = addDueSchedule(prisma, {
    cron: '*/15 * * * *',
    timezone: 'America/New_York',
    overlapPolicy: 'enqueue',
    nextRunAt: new Date(occurrences[0]!),
  });

  for (const occurrence of occurrences) {
    assert.equal(await service.tick(new Date(occurrence)), 1);
  }

  assert.deepEqual(
    prisma.runs.map((run) => run.periodKey),
    occurrences.map((occurrence) => `cron:${occurrence}`),
  );
  assert.deepEqual(
    prisma.runs.map((run) => run.scheduledFor.toISOString()),
    occurrences,
  );
  assert.equal(new Set(prisma.runs.map((run) => run.periodKey)).size, 8);
  assert.equal(prisma.tasks.length, 8);
  assert.equal(rowCalls.length, 8);
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-11-01T07:00:00.000Z');
});

test('dispatchNow consumes today and clears an overdue pointer from an earlier calendar period', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-09T09:00:00.000Z'),
  });
  const now = new Date('2026-07-10T08:00:00.000Z');

  const dispatched = await service.dispatchNow(USER_A, schedule.id, now);

  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].periodKey, 'day:2026-07-10');
  assert.equal(prisma.runs[0].scheduledFor.toISOString(), '2026-07-10T09:00:00.000Z');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-11T09:00:00.000Z');
  assert.equal(dispatched.nextRunAt?.toISOString(), '2026-07-11T09:00:00.000Z');
  assert.equal(await service.tick(now), 0);
  assert.equal(prisma.runs.length, 1);
});

test('resume and timing updates do not point back into an already-consumed day', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
  });

  await service.dispatchNow(
    USER_A,
    schedule.id,
    new Date('2026-07-10T08:00:00.000Z'),
  );
  await service.pause(USER_A, schedule.id);
  const resumed = await service.resume(
    USER_A,
    schedule.id,
    new Date('2026-07-10T08:30:00.000Z'),
  );
  assert.equal(resumed.nextRunAt?.toISOString(), '2026-07-11T09:00:00.000Z');

  const updated = await service.update(
    USER_A,
    schedule.id,
    UpdateScheduleRequestSchema.parse({
      recurrence: { kind: 'daily', time: '10:00', timezone: 'UTC' },
    }),
    new Date('2026-07-10T08:45:00.000Z'),
  );
  assert.equal(updated.nextRunAt?.toISOString(), '2026-07-11T10:00:00.000Z');
  assert.equal(prisma.runs.length, 1);
});

test('resume retries its CAS when a manual period commits after the ledger scan', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 28 * *',
    enabled: false,
    nextRunAt: null,
  });
  const originalUpdateMany = prisma.taskSchedule.updateMany;
  let injected = false;
  prisma.taskSchedule.updateMany = async (args) => {
    if (!injected && args.data.enabled === true && args.data.nextRunAt instanceof Date) {
      injected = true;
      const committedAt = new Date('2026-07-10T08:00:00.000Z');
      prisma.runs.push({
        id: '66666666-6666-4666-8666-000000000104',
        scheduleId: schedule.id,
        scheduledFor: new Date('2026-07-28T09:00:00.000Z'),
        periodKey: 'month:2026-07',
        triggerSource: 'manual',
        triggeredAt: committedAt,
        status: 'failed',
        taskId: null,
        error: 'concurrent manual result',
        createdAt: committedAt,
        updatedAt: committedAt,
      });
      schedule.updatedAt = new Date(schedule.updatedAt.getTime() + 1);
    }
    return originalUpdateMany(args);
  };

  const resumed = await service.resume(
    USER_A,
    schedule.id,
    new Date('2026-07-10T07:30:00.000Z'),
  );

  assert.equal(injected, true);
  assert.equal(resumed.currentPeriod?.run?.status, 'failed');
  assert.equal(resumed.nextRunAt?.toISOString(), '2026-08-28T09:00:00.000Z');
});

test('timing update retries its CAS when the newly defined period commits concurrently', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    enabled: false,
    nextRunAt: null,
  });
  const originalUpdateMany = prisma.taskSchedule.updateMany;
  let injected = false;
  prisma.taskSchedule.updateMany = async (args) => {
    if (!injected && args.data.cron === '0 9 28 * *') {
      injected = true;
      const committedAt = new Date('2026-07-10T08:00:00.000Z');
      prisma.runs.push({
        id: '66666666-6666-4666-8666-000000000105',
        scheduleId: schedule.id,
        scheduledFor: new Date('2026-07-28T09:00:00.000Z'),
        periodKey: 'month:2026-07',
        triggerSource: 'manual',
        triggeredAt: committedAt,
        status: 'created',
        taskId: null,
        error: null,
        createdAt: committedAt,
        updatedAt: committedAt,
      });
      schedule.updatedAt = new Date(schedule.updatedAt.getTime() + 1);
    }
    return originalUpdateMany(args);
  };

  const updated = await service.update(
    USER_A,
    schedule.id,
    UpdateScheduleRequestSchema.parse({
      recurrence: {
        kind: 'monthly',
        dayOfMonth: 28,
        time: '09:00',
        timezone: 'UTC',
      },
      enabled: true,
    }),
    new Date('2026-07-10T07:30:00.000Z'),
  );

  assert.equal(injected, true);
  assert.equal(updated.currentPeriod?.run?.status, 'created');
  assert.equal(updated.nextRunAt?.toISOString(), '2026-08-28T09:00:00.000Z');
});

test('legacy runs without a period key still consume their calendar period', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
  });
  const task: TaskRow = {
    id: '55555555-5555-4555-8555-000000000099',
    repoId: REPO_ID,
    prompt: 'legacy manual dispatch',
    status: 'failed',
    createdAt: new Date('2026-07-10T08:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  };
  prisma.tasks.push(task);
  prisma.runs.push({
    id: '66666666-6666-4666-8666-000000000099',
    scheduleId: schedule.id,
    scheduledFor: new Date('2026-07-10T08:00:00.000Z'),
    periodKey: null,
    triggerSource: null,
    triggeredAt: null,
    status: 'created',
    taskId: task.id,
    error: null,
    createdAt: new Date('2026-07-10T08:00:00.000Z'),
    updatedAt: new Date('2026-07-10T08:00:00.000Z'),
  });

  const response = await service.dispatchNow(
    USER_A,
    schedule.id,
    { expectedPeriodKey: 'day:2026-07-10' },
    new Date('2026-07-10T08:30:00.000Z'),
  );

  assert.equal(rowCalls.length, 0);
  assert.equal(prisma.runs.length, 1);
  assert.equal(response.currentPeriod?.run?.id, prisma.runs[0].id);
  assert.equal(response.currentPeriod?.run?.taskStatus, 'failed');
  assert.equal(response.nextRunAt?.toISOString(), '2026-07-11T09:00:00.000Z');
});

test('a later overdue legacy row does not hide the legacy run for the current day', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
  });
  const currentCreatedAt = new Date('2026-07-10T08:00:00.000Z');
  prisma.runs.push(
    {
      id: '66666666-6666-4666-8666-000000000106',
      scheduleId: schedule.id,
      scheduledFor: new Date('2026-07-10T08:00:00.000Z'),
      periodKey: null,
      triggerSource: null,
      triggeredAt: null,
      status: 'failed',
      taskId: null,
      error: 'current legacy result',
      createdAt: currentCreatedAt,
      updatedAt: currentCreatedAt,
    },
    {
      id: '66666666-6666-4666-8666-000000000107',
      scheduleId: schedule.id,
      scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
      periodKey: null,
      triggerSource: null,
      triggeredAt: null,
      status: 'created',
      taskId: null,
      error: null,
      createdAt: new Date('2026-07-10T10:00:00.000Z'),
      updatedAt: new Date('2026-07-10T10:00:00.000Z'),
    },
  );

  const response = await service.dispatchNow(
    USER_A,
    schedule.id,
    new Date('2026-07-10T08:30:00.000Z'),
  );

  assert.equal(rowCalls.length, 0);
  assert.equal(response.currentPeriod?.run?.id, prisma.runs[0].id);
  assert.equal(prisma.runs.length, 2);
});

test('currentPeriod resolves its own run even when a different run was created later', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '0 9 * * *',
    nextRunAt: new Date('2026-07-11T09:00:00.000Z'),
  });
  prisma.runs.push(
    {
      id: '66666666-6666-4666-8666-000000000101',
      scheduleId: schedule.id,
      scheduledFor: new Date('2026-07-10T09:00:00.000Z'),
      periodKey: 'day:2026-07-10',
      triggerSource: 'manual',
      triggeredAt: new Date('2026-07-10T08:00:00.000Z'),
      status: 'failed',
      taskId: null,
      error: 'current failure',
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    },
    {
      id: '66666666-6666-4666-8666-000000000102',
      scheduleId: schedule.id,
      scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
      periodKey: 'day:2026-07-09',
      triggerSource: 'automatic',
      triggeredAt: new Date('2026-07-10T10:00:00.000Z'),
      status: 'created',
      taskId: null,
      error: null,
      createdAt: new Date('2026-07-10T10:00:00.000Z'),
      updatedAt: new Date('2026-07-10T10:00:00.000Z'),
    },
  );

  const response = await service.get(
    USER_A,
    schedule.id,
    new Date('2026-07-10T12:00:00.000Z'),
  );

  assert.equal(response.latestRun?.id, prisma.runs[1].id);
  assert.equal(response.currentPeriod?.run?.id, prisma.runs[0].id);
  assert.equal(response.currentPeriod?.run?.status, 'failed');
});

test('schedule lists batch current-period lookups instead of querying once per row', async () => {
  const { prisma, service } = buildHarness();
  for (let index = 0; index < 3; index += 1) {
    const schedule = addDueSchedule(prisma, {
      cron: '0 9 * * *',
      nextRunAt: new Date('2099-01-01T09:00:00.000Z'),
    });
    const at = new Date(`2020-01-0${index + 1}T09:00:00.000Z`);
    prisma.runs.push({
      id: `66666666-6666-4666-8666-${(200 + index).toString().padStart(12, '0')}`,
      scheduleId: schedule.id,
      scheduledFor: at,
      periodKey: `day:2020-01-0${index + 1}`,
      triggerSource: 'automatic',
      triggeredAt: at,
      status: 'created',
      taskId: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  const before = prisma.runFindManyCalls;
  const schedules = await service.list(USER_A);

  assert.equal(schedules.length, 3);
  assert.equal(prisma.runFindManyCalls - before, 2);
  assert.ok(schedules.every((schedule) => schedule.currentPeriod?.run === null));
});

test('an executed DST fall-back period keeps the occurrence that actually ran', async () => {
  const { prisma, service } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    cron: '30 1 * * *',
    timezone: 'Europe/London',
    nextRunAt: new Date('2026-10-26T01:30:00.000Z'),
  });
  prisma.runs.push({
    id: '66666666-6666-4666-8666-000000000103',
    scheduleId: schedule.id,
    scheduledFor: new Date('2026-10-25T00:30:00.000Z'),
    periodKey: 'day:2026-10-25',
    triggerSource: 'automatic',
    triggeredAt: new Date('2026-10-25T00:30:00.000Z'),
    status: 'created',
    taskId: null,
    error: null,
    createdAt: new Date('2026-10-25T00:30:00.000Z'),
    updatedAt: new Date('2026-10-25T00:30:00.000Z'),
  });

  const response = await service.get(
    USER_A,
    schedule.id,
    new Date('2026-10-25T02:00:00.000Z'),
  );

  assert.equal(response.currentPeriod?.key, 'day:2026-10-25');
  assert.equal(
    response.currentPeriod?.scheduledFor?.toISOString(),
    '2026-10-25T00:30:00.000Z',
  );
});

test('application bootstrap immediately processes overdue schedules before the first interval', async () => {
  const previousDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  delete process.env.SCHEDULED_TASKS_DISABLED;
  const { prisma, service, rowCalls, admitCalls } = buildHarness();
  addDueSchedule(prisma, {
    nextRunAt: new Date('2020-01-01T00:00:00.000Z'),
  });

  try {
    await service.onApplicationBootstrap();
    assert.equal(rowCalls.length, 1);
    assert.equal(admitCalls.length, 1);
    assert.equal(prisma.runs.length, 1);
    assert.equal(prisma.runs[0].scheduledFor.toISOString(), '2020-01-01T00:00:00.000Z');
  } finally {
    service.onModuleDestroy();
    if (previousDisabled === undefined) {
      delete process.env.SCHEDULED_TASKS_DISABLED;
    } else {
      process.env.SCHEDULED_TASKS_DISABLED = previousDisabled;
    }
  }
});

test('application bootstrap keeps polling when the immediate tick fails', async () => {
  const previousDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  const previousPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  delete process.env.SCHEDULED_TASKS_DISABLED;
  process.env.SCHEDULED_TASKS_POLL_MS = '5';
  const { service } = buildHarness();
  let tickCalls = 0;
  let resolvePolled: (() => void) | undefined;
  const polled = new Promise<void>((resolve) => {
    resolvePolled = resolve;
  });
  let retryTimeout: NodeJS.Timeout | undefined;
  service.tick = async () => {
    tickCalls += 1;
    if (tickCalls === 1) throw new Error('temporary database failure');
    resolvePolled?.();
    return 0;
  };

  try {
    await assert.doesNotReject(() => service.onApplicationBootstrap());
    await Promise.race([
      polled,
      new Promise<never>((_resolve, reject) => {
        retryTimeout = setTimeout(
          () => reject(new Error('scheduled poller did not retry')),
          500,
        );
      }),
    ]);
    assert.ok(tickCalls >= 2);
  } finally {
    if (retryTimeout) clearTimeout(retryTimeout);
    service.onModuleDestroy();
    if (previousDisabled === undefined) {
      delete process.env.SCHEDULED_TASKS_DISABLED;
    } else {
      process.env.SCHEDULED_TASKS_DISABLED = previousDisabled;
    }
    if (previousPollMs === undefined) {
      delete process.env.SCHEDULED_TASKS_POLL_MS;
    } else {
      process.env.SCHEDULED_TASKS_POLL_MS = previousPollMs;
    }
  }
});

test('application bootstrap keeps polling when recovery fails', async () => {
  const previousDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  const previousPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  delete process.env.SCHEDULED_TASKS_DISABLED;
  process.env.SCHEDULED_TASKS_POLL_MS = '5';
  const { service } = buildHarness();
  let tickCalls = 0;
  let resolvePolled: (() => void) | undefined;
  const polled = new Promise<void>((resolve) => {
    resolvePolled = resolve;
  });
  let retryTimeout: NodeJS.Timeout | undefined;
  service.recoverPendingAdmissions = async () => {
    throw new Error('temporary recovery failure');
  };
  service.tick = async () => {
    tickCalls += 1;
    if (tickCalls >= 2) resolvePolled?.();
    return 0;
  };

  try {
    await assert.doesNotReject(() => service.onApplicationBootstrap());
    await Promise.race([
      polled,
      new Promise<never>((_resolve, reject) => {
        retryTimeout = setTimeout(
          () => reject(new Error('scheduled poller stopped after recovery failure')),
          500,
        );
      }),
    ]);
    assert.ok(tickCalls >= 2);
  } finally {
    if (retryTimeout) clearTimeout(retryTimeout);
    service.onModuleDestroy();
    if (previousDisabled === undefined) {
      delete process.env.SCHEDULED_TASKS_DISABLED;
    } else {
      process.env.SCHEDULED_TASKS_DISABLED = previousDisabled;
    }
    if (previousPollMs === undefined) {
      delete process.env.SCHEDULED_TASKS_POLL_MS;
    } else {
      process.env.SCHEDULED_TASKS_POLL_MS = previousPollMs;
    }
  }
});

test('application bootstrap does not overlap poll cycles in one process', async () => {
  const previousDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  const previousPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  delete process.env.SCHEDULED_TASKS_DISABLED;
  process.env.SCHEDULED_TASKS_POLL_MS = '5';
  const { service } = buildHarness();
  let recoveryCalls = 0;
  let tickCalls = 0;
  let releaseFirstRecovery: (() => void) | undefined;
  const firstRecoveryBlocked = new Promise<void>((resolve) => {
    releaseFirstRecovery = resolve;
  });
  service.recoverPendingAdmissions = async () => {
    recoveryCalls += 1;
    if (recoveryCalls === 1) await firstRecoveryBlocked;
    return 0;
  };
  service.tick = async () => {
    tickCalls += 1;
    return 0;
  };

  try {
    const bootstrap = service.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(recoveryCalls, 1);
    assert.equal(tickCalls, 0);

    releaseFirstRecovery?.();
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(recoveryCalls >= 2);
    assert.ok(tickCalls >= 2);
  } finally {
    releaseFirstRecovery?.();
    service.onModuleDestroy();
    if (previousDisabled === undefined) {
      delete process.env.SCHEDULED_TASKS_DISABLED;
    } else {
      process.env.SCHEDULED_TASKS_DISABLED = previousDisabled;
    }
    if (previousPollMs === undefined) {
      delete process.env.SCHEDULED_TASKS_POLL_MS;
    } else {
      process.env.SCHEDULED_TASKS_POLL_MS = previousPollMs;
    }
  }
});

test('overlapPolicy=skip records a skipped run without fabricating a task', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  const schedule = addDueSchedule(prisma, {
    overlapPolicy: 'skip',
    nextRunAt: new Date('2026-07-09T00:05:00.000Z'),
  });
  prisma.tasks.push({
    id: '55555555-5555-4555-8555-000000000001',
    repoId: REPO_ID,
    prompt: 'active',
    status: 'running',
    createdAt: new Date(),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  });
  prisma.runs.push({
    id: '66666666-6666-4666-8666-000000000001',
    scheduleId: schedule.id,
    scheduledFor: new Date('2026-07-09T00:00:00.000Z'),
    periodKey: null,
    triggerSource: null,
    triggeredAt: null,
    status: 'created',
    taskId: prisma.tasks[0].id,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await service.tick(new Date('2026-07-09T00:05:00.000Z'));
  assert.equal(rowCalls.length, 0);
  const skipped = prisma.runs.find((run) => run.status === 'skipped');
  assert.ok(skipped);
  assert.equal(skipped?.taskId, null);
  assert.equal(skipped?.periodKey, 'cron:2026-07-09T00:05:00.000Z');
  assert.equal(schedule.nextRunAt?.toISOString(), '2026-07-09T00:10:00.000Z');
});

test('overlapPolicy=enqueue creates another ordinary task', async () => {
  const { prisma, service, rowCalls } = buildHarness();
  addDueSchedule(prisma, { overlapPolicy: 'enqueue' });
  prisma.tasks.push({
    id: '55555555-5555-4555-8555-000000000001',
    repoId: REPO_ID,
    prompt: 'active',
    status: 'running',
    createdAt: new Date(),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  });
  await service.tick(new Date('2026-07-09T00:05:00.000Z'));
  assert.equal(rowCalls.length, 1);
  assert.equal(prisma.runs.at(-1)?.status, 'created');
});

test('failed fire records a failed run and creates no task', async () => {
  const { prisma, service } = buildHarness({ createThrows: true });
  addDueSchedule(prisma);
  const now = new Date('2026-07-09T00:05:00.000Z');
  await service.tick(now);
  assert.equal(prisma.tasks.length, 0);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].status, 'failed');
  assert.match(prisma.runs[0].error ?? '', /runtime not configured/);
  assert.ok(prisma.schedules[0].nextRunAt && prisma.schedules[0].nextRunAt > now);
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.schedules[0].claimUntil, null);
});

test('failed ledger write rolls back the schedule advance and leaves the occurrence due', async () => {
  const { prisma, service } = buildHarness({
    createThrows: true,
    runCreateThrows: ['failed'],
  });
  const dueAt = new Date('2026-07-09T00:00:00.000Z');
  addDueSchedule(prisma, { nextRunAt: dueAt });

  await assert.rejects(
    () => service.tick(new Date('2026-07-09T00:05:00.000Z')),
    /run ledger unavailable for failed/,
  );

  assert.equal(prisma.tasks.length, 0);
  assert.equal(prisma.runs.length, 0);
  assert.equal(prisma.schedules[0].nextRunAt?.getTime(), dueAt.getTime());
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.schedules[0].claimUntil, null);
});

test('skip ledger failure cannot commit a schedule advance without an outcome', async () => {
  const { prisma, service } = buildHarness({
    runCreateThrows: ['skipped', 'failed'],
  });
  const dueAt = new Date('2026-07-09T00:05:00.000Z');
  const schedule = addDueSchedule(prisma, { nextRunAt: dueAt });
  prisma.tasks.push({
    id: '55555555-5555-4555-8555-000000000001',
    repoId: REPO_ID,
    prompt: 'active',
    status: 'running',
    createdAt: new Date(),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: ENV_ID,
    deliver: 'none',
  });
  prisma.runs.push({
    id: '66666666-6666-4666-8666-000000000001',
    scheduleId: schedule.id,
    scheduledFor: new Date('2026-07-09T00:00:00.000Z'),
    periodKey: null,
    triggerSource: null,
    triggeredAt: null,
    status: 'created',
    taskId: prisma.tasks[0].id,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await assert.rejects(
    () => service.tick(new Date('2026-07-09T00:05:00.000Z')),
    /run ledger unavailable for failed/,
  );

  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.schedules[0].nextRunAt?.getTime(), dueAt.getTime());
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.schedules[0].claimUntil, null);
});

test('post-commit admission failure leaves one pending task for startup recovery', async () => {
  const { prisma, service, admitCalls } = buildHarness({ admitFailures: 1 });
  addDueSchedule(prisma);

  assert.equal(await service.tick(new Date('2026-07-09T00:05:00.000Z')), 1);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].status, 'created');
  assert.equal(prisma.tasks.length, 1);
  assert.equal(prisma.tasks[0].status, 'pending');
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.ok(prisma.runs[0].admissionClaimToken);

  prisma.runs[0].admissionClaimUntil = new Date(0);
  assert.equal(await service.recoverPendingAdmissions(), 1);
  assert.deepEqual(admitCalls, [prisma.tasks[0].id, prisma.tasks[0].id]);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.tasks.length, 1);
  assert.equal(prisma.tasks[0].status, 'queued');
  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.equal(admitCalls.length, 2);
});

test('dispatch retains only the run admission lease when admission leaves the task pending', async () => {
  const { prisma, service, admitCalls } = buildHarness({ admitKeepsPending: true });
  const now = new Date();
  addDueSchedule(prisma, {
    nextRunAt: new Date(now.getTime() - 1_000),
  });

  assert.equal(await service.tick(now), 1);
  assert.equal(prisma.tasks[0].status, 'pending');
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.schedules[0].claimUntil, null);
  assert.ok(prisma.runs[0].admissionClaimToken);
  assert.ok(prisma.runs[0].admissionClaimUntil);
  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.equal(admitCalls.length, 1);
});

test('startup recovery admits created pending scheduled tasks once', async () => {
  const { prisma, service, admitCalls } = buildHarness();
  addRecoverableRun(prisma);
  const recovered = await service.recoverPendingAdmissions();
  assert.equal(recovered, 1);
  assert.deepEqual(admitCalls, [prisma.tasks[0].id]);
  assert.equal(prisma.tasks[0].status, 'queued');
  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.equal(admitCalls.length, 1);
});

test('competing recovery workers admit one pending scheduled task once', async () => {
  const { prisma, service, tasks, admitCalls } = buildHarness();
  addRecoverableRun(prisma);
  const competingService = new ScheduledTasksService(
    prisma as unknown as PrismaService,
    tasks as unknown as TasksService,
  );

  const recovered = await Promise.all([
    service.recoverPendingAdmissions(),
    competingService.recoverPendingAdmissions(),
  ]);

  assert.equal(recovered[0] + recovered[1], 1);
  assert.equal(admitCalls.length, 1);
  assert.equal(prisma.tasks[0].status, 'queued');
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.runs[0].admissionClaimToken, null);
});

test('recovery drains more than one batch of pending scheduled tasks', async () => {
  const { prisma, service, admitCalls } = buildHarness();
  for (let index = 0; index < 101; index += 1) {
    addRecoverableRun(prisma, index);
  }

  assert.equal(await service.recoverPendingAdmissions(10), 101);
  assert.equal(admitCalls.length, 101);
  assert.ok(prisma.tasks.every((task) => task.status === 'queued'));
  assert.ok(prisma.schedules.every((schedule) => schedule.claimToken === null));
});

test('recovery retains its lease when admission resolves but leaves the task pending', async () => {
  const { prisma, service, admitCalls } = buildHarness({ admitKeepsPending: true });
  addRecoverableRun(prisma);

  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.equal(prisma.tasks[0].status, 'pending');
  assert.equal(prisma.schedules[0].claimToken, null);
  assert.equal(prisma.schedules[0].claimUntil, null);
  assert.ok(prisma.runs[0].admissionClaimToken);
  assert.ok(prisma.runs[0].admissionClaimUntil);
  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.equal(admitCalls.length, 1);
});

test('run-level admission leases do not block sibling recovery or the next cadence', async () => {
  const { prisma, service, admitCalls } = buildHarness({ admitKeepsPending: true });
  const firstRun = addRecoverableRun(prisma);
  const schedule = prisma.schedules[0];
  schedule.overlapPolicy = 'enqueue';
  const nextTask: TaskRow = {
    ...prisma.tasks[0],
    id: '55555555-5555-4555-8555-000000000002',
    prompt: 'second pending',
    createdAt: new Date('2026-07-09T00:00:01.000Z'),
  };
  prisma.tasks.push(nextTask);
  prisma.runs.push({
    ...firstRun,
    id: '66666666-6666-4666-8666-000000000002',
    taskId: nextTask.id,
    scheduledFor: new Date('2026-07-09T00:00:01.000Z'),
    createdAt: new Date('2026-07-09T00:00:01.000Z'),
    updatedAt: new Date('2026-07-09T00:00:01.000Z'),
    admissionClaimToken: null,
    admissionClaimUntil: null,
  });

  assert.equal(await service.recoverPendingAdmissions(), 0);
  assert.deepEqual(admitCalls, [prisma.tasks[0].id, nextTask.id]);
  assert.ok(prisma.runs[0].admissionClaimToken);
  assert.ok(prisma.runs[1].admissionClaimToken);
  assert.equal(schedule.claimToken, null);

  const dueAt = new Date('2026-07-11T00:00:00.000Z');
  schedule.nextRunAt = new Date(dueAt.getTime() - 1_000);
  assert.equal(await service.tick(dueAt), 1);
  assert.equal(prisma.runs.length, 3);
  assert.equal(schedule.claimToken, null);
});
