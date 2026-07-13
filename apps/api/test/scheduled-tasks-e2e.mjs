/**
 * Scheduled-task Postgres integration test.
 *
 * Unlike the fast service specs, this uses real Prisma transactions, uniqueness
 * constraints, and the service's actual polling timer. The task admission port is
 * kept narrow so the test proves scheduling without provisioning a sandbox.
 *
 * Prerequisite: DATABASE_URL points to a migrated disposable Postgres database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { PrismaService } from '../dist/prisma/prisma.service.js';
import { ScheduledTasksService } from '../dist/scheduled-tasks/scheduled-tasks.service.js';
import { AuditService } from '../dist/audit/audit.service.js';
import { TasksService } from '../dist/tasks/tasks.service.js';

async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(stepMs);
  }
  return false;
}

function assertDatabaseConfigured() {
  assert.ok(
    process.env.DATABASE_URL,
    'DATABASE_URL must point to a migrated disposable Postgres database',
  );
}

async function createFixture(prisma, name) {
  const user = await prisma.user.create({
    data: {
      name,
      email: `scheduled-task-${randomUUID()}@example.com`,
      allowed: true,
    },
  });
  const repo = await prisma.repo.create({
    data: {
      name: `${name}-${randomUUID()}`,
      gitSource: 'https://example.invalid/scheduled-task-e2e.git',
    },
  });
  return { user, repo };
}

async function cleanupFixture(prisma, fixture) {
  await prisma.repo.delete({ where: { id: fixture.repo.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: fixture.user.id } }).catch(() => undefined);
}

function taskPort(prisma, options = {}) {
  return {
    async normalizeTaskTemplateForSchedule(repoId, body) {
      return {
        ...body,
        repoId,
        runtime: body.runtime ?? 'codex',
        sandboxEnvironmentId: body.sandboxEnvironmentId ?? null,
        deliver: body.deliver ?? 'none',
      };
    },
    async createTaskRow(repoId, body, client, executionMode, userId) {
      const task = await client.task.create({
        data: {
          repoId,
          ownerUserId: userId ?? null,
          prompt: body.prompt,
          branch: body.branch ?? null,
          strategy: body.strategy ?? null,
          skills: body.skills ?? [],
          idleTimeoutMs: body.idleTimeoutMs ?? null,
          deadlineMs: body.deadlineMs ?? null,
          runtime: body.runtime ?? null,
          sandboxEnvironmentId: body.sandboxEnvironmentId ?? null,
          executionMode,
          deliver: body.deliver ?? null,
        },
      });
      if (options.throwAfterTaskCreate) {
        throw new Error(options.throwAfterTaskCreate);
      }
      return task;
    },
    async admitCreatedTask(taskId) {
      options.admissionAttempts?.push(taskId);
      if (options.admitThrows) throw new Error(options.admitThrows);
      await prisma.task.update({ where: { id: taskId }, data: { status: 'queued' } });
    },
  };
}

async function createSchedule(schedules, fixture, prompt) {
  return schedules.create(fixture.user.id, {
    recurrence: { kind: 'daily', time: '23:59', timezone: 'UTC' },
    overlapPolicy: 'enqueue',
    misfirePolicy: 'fire-once',
    taskTemplate: {
      repoId: fixture.repo.id,
      prompt,
      sandboxEnvironmentId: null,
    },
  });
}

async function createSubdaySchedule(schedules, fixture, recurrence, prompt) {
  return schedules.create(fixture.user.id, {
    recurrence,
    overlapPolicy: 'enqueue',
    misfirePolicy: 'fire-once',
    taskTemplate: {
      repoId: fixture.repo.id,
      prompt,
      sandboxEnvironmentId: null,
    },
  });
}

test('canonical sub-day schedules keep unique nominal periods in real Postgres', async () => {
  assertDatabaseConfigured();
  const prisma = new PrismaService();
  const schedules = new ScheduledTasksService(prisma, taskPort(prisma));
  const fixture = await createFixture(prisma, 'scheduled-subday-periods');
  const cases = [
    {
      name: 'hourly',
      recurrence: { kind: 'hourly', minuteOfHour: 15, timezone: 'UTC' },
      cron: '15 * * * *',
    },
    {
      name: 'minute interval',
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 15,
        timezone: 'UTC',
      },
      cron: '*/15 * * * *',
    },
  ];

  try {
    for (const scenario of cases) {
      const created = await createSubdaySchedule(
        schedules,
        fixture,
        scenario.recurrence,
        `${scenario.name} occurrence identity`,
      );
      assert.equal(created.cronExpression, scenario.cron);
      const firstOccurrence = created.nextRunAt;
      assert.ok(firstOccurrence);

      assert.equal(await schedules.tick(firstOccurrence), 1);
      const afterFirst = await prisma.taskSchedule.findUniqueOrThrow({
        where: { id: created.id },
      });
      const secondOccurrence = afterFirst.nextRunAt;
      assert.ok(secondOccurrence && secondOccurrence > firstOccurrence);
      assert.equal(await schedules.tick(secondOccurrence), 1);
      assert.equal(
        await schedules.tick(secondOccurrence),
        0,
        'repeating the same tick must not create the occurrence twice',
      );

      const runs = await prisma.taskScheduleRun.findMany({
        where: { scheduleId: created.id },
        orderBy: { scheduledFor: 'asc' },
      });
      assert.equal(runs.length, 2);
      assert.deepEqual(
        runs.map((run) => run.scheduledFor.toISOString()),
        [firstOccurrence.toISOString(), secondOccurrence.toISOString()],
      );
      assert.deepEqual(
        runs.map((run) => run.periodKey),
        [
          `cron:${firstOccurrence.toISOString()}`,
          `cron:${secondOccurrence.toISOString()}`,
        ],
      );
      assert.equal(new Set(runs.map((run) => run.periodKey)).size, 2);
      assert.ok(runs.every((run) => !run.periodKey?.startsWith('day:')));
      assert.equal(
        await prisma.task.count({
          where: { scheduleRun: { scheduleId: created.id } },
        }),
        2,
      );
      const advanced = await prisma.taskSchedule.findUniqueOrThrow({
        where: { id: created.id },
      });
      assert.ok(advanced.nextRunAt && advanced.nextRunAt > secondOccurrence);
      await schedules.pause(fixture.user.id, created.id);
    }
  } finally {
    await cleanupFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test('manual dispatch consumes one period while a separate schedule proves the real poller', async () => {
  assertDatabaseConfigured();
  const prisma = new PrismaService();
  const admittedTaskIds = [];
  const schedules = new ScheduledTasksService(
    prisma,
    taskPort(prisma, { admissionAttempts: admittedTaskIds }),
  );
  const priorPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  const priorDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  process.env.SCHEDULED_TASKS_POLL_MS = '25';
  delete process.env.SCHEDULED_TASKS_DISABLED;
  const fixture = await createFixture(prisma, 'scheduled-poller');

  try {
    const manual = await createSchedule(
      schedules,
      fixture,
      'manual period integration task',
    );
    const futureOccurrence = manual.nextRunAt;
    assert.ok(futureOccurrence, 'enabled schedule must expose its next occurrence');
    const dispatchedAt = new Date(futureOccurrence.getTime() - 60 * 60_000);
    const observedManual = await schedules.get(
      fixture.user.id,
      manual.id,
      dispatchedAt,
    );
    const manuallyDispatched = await schedules.dispatchNow(
      fixture.user.id,
      manual.id,
      { expectedPeriodKey: observedManual.currentPeriod.key },
      dispatchedAt,
    );
    assert.ok(
      manuallyDispatched.nextRunAt > futureOccurrence,
      'manual dispatch must advance beyond the consumed period',
    );
    assert.equal(manuallyDispatched.currentPeriod.run.triggerSource, 'manual');
    assert.equal(
      manuallyDispatched.currentPeriod.run.triggeredAt.getTime(),
      dispatchedAt.getTime(),
    );
    const manualTaskId = manuallyDispatched.currentPeriod.run.taskId;
    assert.ok(manualTaskId);

    const retried = await schedules.dispatchNow(
      fixture.user.id,
      manual.id,
      { expectedPeriodKey: manuallyDispatched.currentPeriod.key },
      new Date(dispatchedAt.getTime() + 1_000),
    );
    assert.equal(retried.currentPeriod.run.taskId, manualTaskId);
    assert.equal(
      await prisma.taskScheduleRun.count({ where: { scheduleId: manual.id } }),
      1,
    );

    const stale = await createSchedule(
      schedules,
      fixture,
      'overdue pointer period integration task',
    );
    const staleTodayOccurrence = stale.nextRunAt;
    assert.ok(staleTodayOccurrence);
    const staleDispatchAt = new Date(staleTodayOccurrence.getTime() - 60 * 60_000);
    await prisma.taskSchedule.update({
      where: { id: stale.id },
      data: {
        nextRunAt: new Date(staleTodayOccurrence.getTime() - 24 * 60 * 60_000),
      },
    });
    const staleObserved = await schedules.get(
      fixture.user.id,
      stale.id,
      staleDispatchAt,
    );
    const staleDispatched = await schedules.dispatchNow(
      fixture.user.id,
      stale.id,
      { expectedPeriodKey: staleObserved.currentPeriod.key },
      staleDispatchAt,
    );
    assert.ok(
      staleDispatched.nextRunAt > staleTodayOccurrence,
      'manual dispatch must clear an overdue pointer from an earlier day',
    );
    assert.equal(await schedules.tick(staleDispatchAt), 0);
    assert.equal(
      await prisma.taskScheduleRun.count({ where: { scheduleId: stale.id } }),
      1,
    );

    const legacy = await createSchedule(
      schedules,
      fixture,
      'legacy null period integration task',
    );
    const legacyOccurrence = legacy.nextRunAt;
    assert.ok(legacyOccurrence);
    const legacyDispatchedAt = new Date(legacyOccurrence.getTime() - 30 * 60_000);
    await prisma.taskScheduleRun.create({
      data: {
        scheduleId: legacy.id,
        scheduledFor: legacyDispatchedAt,
        periodKey: null,
        status: 'failed',
        error: 'legacy dispatch failure',
      },
    });
    const legacyObserved = await schedules.get(
      fixture.user.id,
      legacy.id,
      legacyDispatchedAt,
    );
    const legacyRetried = await schedules.dispatchNow(
      fixture.user.id,
      legacy.id,
      { expectedPeriodKey: legacyObserved.currentPeriod.key },
      legacyDispatchedAt,
    );
    assert.equal(legacyRetried.currentPeriod.run.status, 'failed');
    assert.equal(
      await prisma.taskScheduleRun.count({ where: { scheduleId: legacy.id } }),
      1,
      'a legacy null period key must still consume its calendar period',
    );

    const automatic = await createSchedule(
      schedules,
      fixture,
      'automatic poller integration task',
    );
    const automaticDueAt = new Date(Date.now() + 1_000);
    await prisma.taskSchedule.update({
      where: { id: automatic.id },
      data: { nextRunAt: automaticDueAt },
    });

    await schedules.onApplicationBootstrap();
    const fired = await waitFor(async () => {
      return (
        (await prisma.taskScheduleRun.count({ where: { scheduleId: automatic.id } })) === 1
      );
    });
    assert.ok(fired, 'the real polling timer creates the occurrence when it becomes due');

    const automaticRun = await prisma.taskScheduleRun.findFirstOrThrow({
      where: { scheduleId: automatic.id },
    });
    assert.equal(automaticRun.status, 'created');
    assert.equal(automaticRun.triggerSource, 'automatic');
    assert.equal(automaticRun.triggeredAt !== null, true);
    assert.equal(automaticRun.periodKey !== null, true);
    assert.equal(admittedTaskIds.length, 3);
    assert.notEqual(manualTaskId, automaticRun.taskId);
  } finally {
    schedules.onModuleDestroy();
    await cleanupFixture(prisma, fixture);
    await prisma.$disconnect();
    if (priorPollMs === undefined) delete process.env.SCHEDULED_TASKS_POLL_MS;
    else process.env.SCHEDULED_TASKS_POLL_MS = priorPollMs;
    if (priorDisabled === undefined) delete process.env.SCHEDULED_TASKS_DISABLED;
    else process.env.SCHEDULED_TASKS_DISABLED = priorDisabled;
  }
});

test('competing schedulers and duplicate manual dispatch persist one occurrence identity', async () => {
  assertDatabaseConfigured();
  const firstPrisma = new PrismaService();
  const secondPrisma = new PrismaService();
  const firstSchedules = new ScheduledTasksService(
    firstPrisma,
    taskPort(firstPrisma),
  );
  const secondSchedules = new ScheduledTasksService(
    secondPrisma,
    taskPort(secondPrisma),
  );
  const fixture = await createFixture(firstPrisma, 'scheduled-race');

  try {
    const automatic = await createSchedule(
      firstSchedules,
      fixture,
      'automatic race',
    );
    const automaticDueAt = new Date(Date.now() - 1_000);
    await firstPrisma.taskSchedule.update({
      where: { id: automatic.id },
      data: { nextRunAt: automaticDueAt },
    });

    const tickAt = new Date();
    const fired = await Promise.all([
      firstSchedules.tick(tickAt),
      secondSchedules.tick(tickAt),
    ]);
    assert.equal(fired[0] + fired[1], 1);
    assert.equal(
      await firstPrisma.taskScheduleRun.count({ where: { scheduleId: automatic.id } }),
      1,
    );
    assert.equal(
      await firstPrisma.task.count({ where: { scheduleRun: { scheduleId: automatic.id } } }),
      1,
    );
    const advanced = await firstPrisma.taskSchedule.findUniqueOrThrow({
      where: { id: automatic.id },
    });
    assert.ok(advanced.nextRunAt && advanced.nextRunAt > tickAt);
    assert.equal(advanced.claimToken, null);
    assert.equal(advanced.claimUntil, null);

    const manual = await createSchedule(firstSchedules, fixture, 'manual race');
    const futureOccurrence = manual.nextRunAt;
    assert.ok(futureOccurrence);
    const dispatchedAt = new Date(futureOccurrence.getTime() - 60 * 60_000);
    const observed = await firstSchedules.get(
      fixture.user.id,
      manual.id,
      dispatchedAt,
    );
    const attempts = await Promise.allSettled([
      firstSchedules.dispatchNow(
        fixture.user.id,
        manual.id,
        { expectedPeriodKey: observed.currentPeriod.key },
        dispatchedAt,
      ),
      secondSchedules.dispatchNow(
        fixture.user.id,
        manual.id,
        { expectedPeriodKey: observed.currentPeriod.key },
        dispatchedAt,
      ),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 2);
    assert.equal(
      await firstPrisma.taskScheduleRun.count({ where: { scheduleId: manual.id } }),
      1,
    );
    assert.equal(
      await firstPrisma.task.count({ where: { scheduleRun: { scheduleId: manual.id } } }),
      1,
    );
    const advancedManual = await firstPrisma.taskSchedule.findUniqueOrThrow({
      where: { id: manual.id },
    });
    assert.ok(advancedManual.nextRunAt > futureOccurrence);

    const manualVsAutomatic = await createSchedule(
      firstSchedules,
      fixture,
      'manual automatic period race',
    );
    const sharedNow = new Date();
    await firstPrisma.taskSchedule.update({
      where: { id: manualVsAutomatic.id },
      data: { nextRunAt: new Date(sharedNow.getTime() - 1_000) },
    });
    const sharedPeriod = await firstSchedules.get(
      fixture.user.id,
      manualVsAutomatic.id,
      sharedNow,
    );
    const [, tickResult] = await Promise.all([
      firstSchedules.dispatchNow(
        fixture.user.id,
        manualVsAutomatic.id,
        { expectedPeriodKey: sharedPeriod.currentPeriod.key },
        sharedNow,
      ),
      secondSchedules.tick(sharedNow),
    ]);
    assert.ok(tickResult === 0 || tickResult === 1);
    assert.equal(
      await firstPrisma.taskScheduleRun.count({
        where: { scheduleId: manualVsAutomatic.id },
      }),
      1,
    );
    assert.equal(
      await firstPrisma.task.count({
        where: { scheduleRun: { scheduleId: manualVsAutomatic.id } },
      }),
      1,
    );
  } finally {
    await cleanupFixture(firstPrisma, fixture);
    await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
  }
});

test('task creation rollback is followed by one atomic failed ledger and schedule advance', async () => {
  assertDatabaseConfigured();
  const prisma = new PrismaService();
  const schedules = new ScheduledTasksService(
    prisma,
    taskPort(prisma, { throwAfterTaskCreate: 'task validation interrupted' }),
  );
  const fixture = await createFixture(prisma, 'scheduled-rollback');

  try {
    const created = await createSchedule(schedules, fixture, 'rollback task');
    const dueAt = new Date(Date.now() - 1_000);
    await prisma.taskSchedule.update({
      where: { id: created.id },
      data: { nextRunAt: dueAt },
    });
    const tickAt = new Date();

    assert.equal(await schedules.tick(tickAt), 1);
    const runs = await prisma.taskScheduleRun.findMany({
      where: { scheduleId: created.id },
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.match(runs[0].error ?? '', /task validation interrupted/);
    assert.equal(runs[0].taskId, null);
    assert.equal(await prisma.task.count({ where: { repoId: fixture.repo.id } }), 0);
    const schedule = await prisma.taskSchedule.findUniqueOrThrow({
      where: { id: created.id },
    });
    assert.ok(schedule.nextRunAt && schedule.nextRunAt > tickAt);
    assert.equal(schedule.claimToken, null);
    assert.equal(schedule.claimUntil, null);
  } finally {
    await cleanupFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test('restart recovers a committed pending task and immediately scans overdue schedules', async () => {
  assertDatabaseConfigured();
  const firstPrisma = new PrismaService();
  const firstAdmissionAttempts = [];
  const firstSchedules = new ScheduledTasksService(
    firstPrisma,
    taskPort(firstPrisma, {
      admissionAttempts: firstAdmissionAttempts,
      admitThrows: 'process stopped before admission',
    }),
  );
  const fixture = await createFixture(firstPrisma, 'scheduled-recovery');
  let secondPrisma;
  let thirdPrisma;
  let secondSchedules;
  let thirdSchedules;
  const priorPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  const priorDisabled = process.env.SCHEDULED_TASKS_DISABLED;

  try {
    const recoverable = await createSchedule(
      firstSchedules,
      fixture,
      'recover pending task',
    );
    const recoverableDueAt = new Date(Date.now() - 1_000);
    await firstPrisma.taskSchedule.update({
      where: { id: recoverable.id },
      data: { nextRunAt: recoverableDueAt },
    });
    assert.equal(await firstSchedules.tick(new Date()), 1);
    assert.equal(firstAdmissionAttempts.length, 1);
    const committedRun = await firstPrisma.taskScheduleRun.findFirstOrThrow({
      where: { scheduleId: recoverable.id },
      include: { task: true },
    });
    assert.equal(committedRun.status, 'created');
    assert.equal(committedRun.task?.status, 'pending');
    assert.equal(committedRun.task?.ownerUserId, fixture.user.id);
    await assert.rejects(
      () => firstSchedules.delete(fixture.user.id, recoverable.id),
      (error) => error?.getStatus?.() === 409,
      'a recoverable pending task must keep its schedule ledger until admission',
    );
    assert.ok(
      await firstPrisma.taskSchedule.findUnique({ where: { id: recoverable.id } }),
    );
    await firstPrisma.taskScheduleRun.update({
      where: { id: committedRun.id },
      data: { admissionClaimUntil: new Date(0) },
    });
    await firstPrisma.$disconnect();

    secondPrisma = new PrismaService();
    thirdPrisma = new PrismaService();
    const recoveredTaskIds = [];
    secondSchedules = new ScheduledTasksService(
      secondPrisma,
      taskPort(secondPrisma, { admissionAttempts: recoveredTaskIds }),
    );
    thirdSchedules = new ScheduledTasksService(
      thirdPrisma,
      taskPort(thirdPrisma, { admissionAttempts: recoveredTaskIds }),
    );
    const concurrentRecovery = await Promise.all([
      secondSchedules.recoverPendingAdmissions(),
      thirdSchedules.recoverPendingAdmissions(),
    ]);
    assert.equal(concurrentRecovery[0] + concurrentRecovery[1], 1);
    assert.deepEqual(recoveredTaskIds, [committedRun.taskId]);
    assert.equal(
      (await secondPrisma.task.findUniqueOrThrow({ where: { id: committedRun.taskId } }))
        .status,
      'queued',
    );
    assert.deepEqual(
      await Promise.all([
        secondSchedules.recoverPendingAdmissions(),
        thirdSchedules.recoverPendingAdmissions(),
      ]),
      [0, 0],
    );
    assert.deepEqual(recoveredTaskIds, [committedRun.taskId]);

    const startupSeedAttempts = [];
    const startupSeedSchedules = new ScheduledTasksService(
      secondPrisma,
      taskPort(secondPrisma, {
        admissionAttempts: startupSeedAttempts,
        admitThrows: 'process stopped before startup recovery',
      }),
    );
    const startupRecoverable = await createSchedule(
      startupSeedSchedules,
      fixture,
      'startup recovers pending task',
    );
    await secondPrisma.taskSchedule.update({
      where: { id: startupRecoverable.id },
      data: { nextRunAt: new Date(Date.now() - 1_000) },
    });
    assert.equal(await startupSeedSchedules.tick(new Date()), 1);
    const startupPendingRun = await secondPrisma.taskScheduleRun.findFirstOrThrow({
      where: { scheduleId: startupRecoverable.id },
      include: { task: true },
    });
    assert.deepEqual(startupSeedAttempts, [startupPendingRun.taskId]);
    assert.equal(startupPendingRun.status, 'created');
    assert.equal(startupPendingRun.task?.status, 'pending');
    await secondPrisma.taskScheduleRun.update({
      where: { id: startupPendingRun.id },
      data: { admissionClaimUntil: new Date(0) },
    });

    const overdue = await createSchedule(secondSchedules, fixture, 'startup due scan');
    await secondPrisma.taskSchedule.update({
      where: { id: overdue.id },
      data: { nextRunAt: new Date(Date.now() - 1_000) },
    });
    process.env.SCHEDULED_TASKS_POLL_MS = '600000';
    delete process.env.SCHEDULED_TASKS_DISABLED;
    await secondSchedules.onApplicationBootstrap();
    assert.equal(
      (
        await secondPrisma.task.findUniqueOrThrow({
          where: { id: startupPendingRun.taskId },
        })
      ).status,
      'queued',
    );
    assert.equal(
      recoveredTaskIds.filter((taskId) => taskId === startupPendingRun.taskId).length,
      1,
      'bootstrap must recover the newly committed pending task exactly once',
    );
    assert.equal(
      await secondPrisma.taskScheduleRun.count({ where: { scheduleId: overdue.id } }),
      1,
    );
    const startupDueRun = await secondPrisma.taskScheduleRun.findFirstOrThrow({
      where: { scheduleId: overdue.id },
      include: { task: true },
    });
    assert.equal(startupDueRun.status, 'created');
    assert.equal(startupDueRun.task?.status, 'queued');
    assert.equal(
      recoveredTaskIds.filter((taskId) => taskId === startupDueRun.taskId).length,
      1,
      'bootstrap must immediately dispatch the overdue occurrence',
    );
  } finally {
    secondSchedules?.onModuleDestroy();
    thirdSchedules?.onModuleDestroy();
    const cleanupPrisma = secondPrisma ?? thirdPrisma ?? new PrismaService();
    await cleanupFixture(cleanupPrisma, fixture);
    await Promise.all(
      [...new Set([firstPrisma, secondPrisma, thirdPrisma, cleanupPrisma])]
        .filter(Boolean)
        .map((client) => client.$disconnect().catch(() => undefined)),
    );
    if (priorPollMs === undefined) delete process.env.SCHEDULED_TASKS_POLL_MS;
    else process.env.SCHEDULED_TASKS_POLL_MS = priorPollMs;
    if (priorDisabled === undefined) delete process.env.SCHEDULED_TASKS_DISABLED;
    else process.env.SCHEDULED_TASKS_DISABLED = priorDisabled;
  }
});

test('concurrent task.created audit retries keep one canonical owner-attributed event', async () => {
  assertDatabaseConfigured();
  const firstPrisma = new PrismaService();
  const secondPrisma = new PrismaService();
  const fixture = await createFixture(firstPrisma, 'scheduled-audit-dedupe');

  try {
    const task = await firstPrisma.task.create({
      data: {
        repoId: fixture.repo.id,
        ownerUserId: fixture.user.id,
        prompt: 'audit dedupe',
      },
    });
    const firstAudit = new AuditService(firstPrisma);
    const secondAudit = new AuditService(secondPrisma);

    await Promise.all([
      firstAudit.recordTaskCreated(task.id, fixture.user.id),
      secondAudit.recordTaskCreated(task.id, fixture.user.id),
    ]);

    const events = await firstPrisma.auditEvent.findMany({
      where: { taskId: task.id, type: 'task.created' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].userId, fixture.user.id);
    assert.equal(events[0].dedupeKey, `task.created:${task.id}`);
  } finally {
    await cleanupFixture(firstPrisma, fixture);
    await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
  }
});

test('real Postgres admission CAS persists one running winner and both edge tokens', async () => {
  assertDatabaseConfigured();
  const firstPrisma = new PrismaService();
  const secondPrisma = new PrismaService();
  const fixture = await createFixture(firstPrisma, 'scheduled-admission-cas');
  const firstTasks = new TasksService(firstPrisma);
  const secondTasks = new TasksService(secondPrisma);
  const firstToken = randomUUID();
  const secondToken = randomUUID();

  try {
    const raced = await firstPrisma.task.create({
      data: {
        repoId: fixture.repo.id,
        ownerUserId: fixture.user.id,
        prompt: 'running admission CAS',
      },
    });
    const results = await Promise.all([
      firstTasks.transitionForAdmission(
        raced.id,
        'running',
        fixture.user.id,
        firstToken,
      ),
      secondTasks.transitionForAdmission(
        raced.id,
        'running',
        fixture.user.id,
        secondToken,
      ),
    ]);
    assert.deepEqual(results.slice().sort(), ['already-transitioned', 'transitioned']);
    const racedRow = await firstPrisma.task.findUniqueOrThrow({
      where: { id: raced.id },
      select: { status: true, runningAdmissionToken: true },
    });
    assert.equal(racedRow.status, 'running');
    assert.ok(
      racedRow.runningAdmissionToken === firstToken ||
        racedRow.runningAdmissionToken === secondToken,
    );

    const promoted = await firstPrisma.task.create({
      data: {
        repoId: fixture.repo.id,
        ownerUserId: fixture.user.id,
        prompt: 'queued then running tokens',
      },
    });
    const queuedToken = randomUUID();
    const runningToken = randomUUID();
    assert.equal(
      await firstTasks.transitionForAdmission(
        promoted.id,
        'queued',
        fixture.user.id,
        queuedToken,
      ),
      'transitioned',
    );
    assert.equal(
      await secondTasks.transitionForAdmission(
        promoted.id,
        'running',
        fixture.user.id,
        runningToken,
      ),
      'transitioned',
    );
    assert.equal(
      await firstTasks.reconcileAdmissionTransition(
        promoted.id,
        'queued',
        queuedToken,
        fixture.user.id,
      ),
      'superseded',
    );
    const promotedRow = await firstPrisma.task.findUniqueOrThrow({
      where: { id: promoted.id },
      select: {
        status: true,
        queuedAdmissionToken: true,
        runningAdmissionToken: true,
      },
    });
    assert.deepEqual(promotedRow, {
      status: 'running',
      queuedAdmissionToken: queuedToken,
      runningAdmissionToken: runningToken,
    });
  } finally {
    await cleanupFixture(firstPrisma, fixture);
    await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
  }
});
