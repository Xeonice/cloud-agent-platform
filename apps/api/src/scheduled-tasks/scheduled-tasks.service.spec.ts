import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CreateTaskBody } from '@cap/contracts';
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
  status: string;
  taskId: string | null;
  error: string | null;
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
    enabled?: boolean;
    claimToken?: string | null;
    nextRunAt?: Date;
    OR?: ClaimUntilPredicate[];
  };
  data: Partial<ScheduleRow>;
}

interface TaskScheduleRunFindManyArgs {
  where?: {
    scheduleId?: string;
    status?: string;
    taskId?: { not: null };
    task?: { status: string };
  };
  include?: { task?: boolean; schedule?: boolean };
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
  seq = 0;

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
        if (where.enabled !== undefined && row.enabled !== where.enabled) return false;
        if (where.claimToken !== undefined && row.claimToken !== where.claimToken) return false;
        if (where.nextRunAt && row.nextRunAt?.getTime() !== where.nextRunAt.getTime()) return false;
        if (where.OR?.some((part) => part.claimUntil !== undefined)) {
          const cutoff = where.OR.find((part) => part.claimUntil?.lt)?.claimUntil?.lt;
          return cutoff
            ? row.claimUntil === null || row.claimUntil < cutoff
            : row.claimUntil === null;
        }
        return true;
      });
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    },
    deleteMany: async ({ where }: { where: { id: string; ownerUserId: string } }) => {
      const before = this.schedules.length;
      this.schedules = this.schedules.filter(
        (row) => !(row.id === where.id && row.ownerUserId === where.ownerUserId),
      );
      return { count: before - this.schedules.length };
    },
  };

  taskScheduleRun = {
    create: async ({
      data,
    }: {
      data: Pick<RunRow, 'scheduleId' | 'scheduledFor' | 'status'> &
        Partial<Pick<RunRow, 'taskId' | 'error'>>;
    }) => {
      if (
        this.runs.some(
          (run) =>
            run.scheduleId === data.scheduleId &&
            run.scheduledFor.getTime() === data.scheduledFor.getTime(),
        )
      ) {
        throw new Error('unique violation');
      }
      const now = new Date('2026-07-09T00:02:00.000Z');
      const row: RunRow = {
        id: `00000000-0000-4000-b000-${(++this.seq).toString().padStart(12, '0')}`,
        scheduleId: data.scheduleId,
        scheduledFor: data.scheduledFor,
        status: data.status,
        taskId: data.taskId ?? null,
        error: data.error ?? null,
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
      where: { scheduleId: string; task: { status: { in: string[] } } };
    }) => {
      return (
        this.runs.find((run) => {
          if (run.scheduleId !== where.scheduleId) return false;
          const task = run.taskId ? this.tasks.find((row) => row.id === run.taskId) : null;
          return task ? where.task.status.in.includes(task.status) : false;
        }) ?? null
      );
    },
    findMany: async (args: TaskScheduleRunFindManyArgs = {}) => {
      let rows = [...this.runs];
      const where = args.where ?? {};
      if (where.scheduleId) rows = rows.filter((run) => run.scheduleId === where.scheduleId);
      if (where.status) rows = rows.filter((run) => run.status === where.status);
      if (where.taskId?.not === null) rows = rows.filter((run) => run.taskId !== null);
      const taskStatus = where.task?.status;
      if (taskStatus) {
        rows = rows.filter((run) => {
          const task = run.taskId ? this.tasks.find((row) => row.id === run.taskId) : null;
          return task?.status === taskStatus;
        });
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
      .sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())
      .slice(0, 1);
    return { ...row, runs };
  }
}

function buildHarness(options: { createThrows?: boolean } = {}) {
  const prisma = new FakePrisma();
  const normalizeCalls: Array<{ repoId: string; userId: string }> = [];
  const rowCalls: Array<{ repoId: string; userId?: string }> = [];
  const admitCalls: string[] = [];
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
    },
  } as unknown as TasksService;
  return {
    prisma,
    service: new ScheduledTasksService(prisma as unknown as PrismaService, tasks),
    normalizeCalls,
    rowCalls,
    admitCalls,
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
  assert.deepEqual(normalizeCalls, [{ repoId: REPO_ID, userId: USER_A }]);
  assert.equal((await service.list(USER_A)).length, 1);
  assert.equal((await service.list(USER_B)).length, 0);
  await assert.rejects(() => service.get(USER_B, created.id), NotFoundException);
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
  await service.tick(new Date('2026-07-09T00:05:00.000Z'));
  assert.equal(prisma.tasks.length, 0);
  assert.equal(prisma.runs.length, 1);
  assert.equal(prisma.runs[0].status, 'failed');
  assert.match(prisma.runs[0].error ?? '', /runtime not configured/);
});

test('startup recovery admits created pending scheduled tasks once', async () => {
  const { prisma, service, admitCalls } = buildHarness();
  const schedule = addDueSchedule(prisma);
  prisma.tasks.push({
    id: '55555555-5555-4555-8555-000000000001',
    repoId: REPO_ID,
    prompt: 'pending',
    status: 'pending',
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
    status: 'created',
    taskId: prisma.tasks[0].id,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const recovered = await service.recoverPendingAdmissions();
  assert.equal(recovered, 1);
  assert.deepEqual(admitCalls, [prisma.tasks[0].id]);
});
