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

async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(stepMs);
  }
  return false;
}

test('manual dispatch keeps the future occurrence and the poller later creates it', async () => {
  assert.ok(
    process.env.DATABASE_URL,
    'DATABASE_URL must point to a migrated disposable Postgres database',
  );
  const prisma = new PrismaService();
  const admittedTaskIds = [];
  const priorPollMs = process.env.SCHEDULED_TASKS_POLL_MS;
  const priorDisabled = process.env.SCHEDULED_TASKS_DISABLED;
  process.env.SCHEDULED_TASKS_POLL_MS = '25';
  delete process.env.SCHEDULED_TASKS_DISABLED;

  const user = await prisma.user.create({
    data: {
      name: 'scheduled-task-e2e',
      email: `scheduled-task-${randomUUID()}@example.com`,
      allowed: true,
    },
  });
  const repo = await prisma.repo.create({
    data: {
      name: `scheduled-task-${randomUUID()}`,
      gitSource: 'https://example.invalid/scheduled-task-e2e.git',
    },
  });

  const tasks = {
    async normalizeTaskTemplateForSchedule(repoId, body) {
      return {
        ...body,
        repoId,
        runtime: body.runtime ?? 'codex',
        sandboxEnvironmentId: body.sandboxEnvironmentId ?? null,
        deliver: body.deliver ?? 'none',
      };
    },
    async createTaskRow(repoId, body, client, executionMode) {
      return client.task.create({
        data: {
          repoId,
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
    },
    async admitCreatedTask(taskId) {
      admittedTaskIds.push(taskId);
      await prisma.task.update({ where: { id: taskId }, data: { status: 'queued' } });
    },
  };
  const schedules = new ScheduledTasksService(prisma, tasks);

  try {
    const created = await schedules.create(user.id, {
      recurrence: { kind: 'daily', time: '23:59', timezone: 'UTC' },
      overlapPolicy: 'enqueue',
      misfirePolicy: 'fire-once',
      taskTemplate: {
        repoId: repo.id,
        prompt: 'scheduled integration task',
        sandboxEnvironmentId: null,
      },
    });

    const futureOccurrence = new Date(Date.now() + 1_000);
    await prisma.taskSchedule.update({
      where: { id: created.id },
      data: { nextRunAt: futureOccurrence },
    });

    const dispatchedAt = new Date();
    const manuallyDispatched = await schedules.dispatchNow(
      user.id,
      created.id,
      dispatchedAt,
    );
    assert.equal(
      manuallyDispatched.nextRunAt?.getTime(),
      futureOccurrence.getTime(),
      'manual dispatch must not consume a future scheduled occurrence',
    );

    await schedules.onApplicationBootstrap();
    const fired = await waitFor(async () => {
      return (await prisma.taskScheduleRun.count({ where: { scheduleId: created.id } })) === 2;
    });
    assert.ok(fired, 'the real polling timer creates the occurrence when it becomes due');

    const runs = await prisma.taskScheduleRun.findMany({
      where: { scheduleId: created.id },
      orderBy: { scheduledFor: 'asc' },
    });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].scheduledFor.getTime(), dispatchedAt.getTime());
    assert.equal(runs[1].scheduledFor.getTime(), futureOccurrence.getTime());
    assert.equal(runs[0].status, 'created');
    assert.equal(runs[1].status, 'created');
    assert.equal(admittedTaskIds.length, 2);
    assert.notEqual(runs[0].taskId, runs[1].taskId);
  } finally {
    schedules.onModuleDestroy();
    await prisma.repo.delete({ where: { id: repo.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
    if (priorPollMs === undefined) delete process.env.SCHEDULED_TASKS_POLL_MS;
    else process.env.SCHEDULED_TASKS_POLL_MS = priorPollMs;
    if (priorDisabled === undefined) delete process.env.SCHEDULED_TASKS_DISABLED;
    else process.env.SCHEDULED_TASKS_DISABLED = priorDisabled;
  }
});
