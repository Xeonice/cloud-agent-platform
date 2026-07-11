import assert from 'node:assert/strict';
import test from 'node:test';

import { startScheduledTasksControlServer } from './control-server.mjs';
import { RecordingSandboxProvider } from './recording-sandbox-provider.mjs';

const createdAt = new Date('2026-07-11T00:00:00.000Z');
const scheduledFor = new Date('2026-07-11T00:01:00.000Z');

test('control server accelerates only nextRunAt and returns sanitized evidence', async () => {
  const schedule = {
    id: 'schedule-1',
    ownerUserId: 'user-1',
    repoId: 'repo-1',
    enabled: true,
    nextRunAt: new Date('2026-07-12T00:00:00.000Z'),
    overlapPolicy: 'enqueue',
    misfirePolicy: 'fire-once',
    claimToken: 'must-not-leak',
    claimUntil: null,
    createdAt,
    updatedAt: createdAt,
    taskTemplate: { prompt: 'must-not-leak' },
  };
  let updateArgs;
  const prisma = {
    taskSchedule: {
      findUnique: async () => schedule,
      findFirst: async () => schedule,
      update: async (args) => {
        updateArgs = args;
        return { ...schedule, nextRunAt: args.data.nextRunAt };
      },
    },
    taskScheduleRun: {
      findMany: async () => [
        {
          id: 'run-1',
          scheduleId: schedule.id,
          scheduledFor,
          status: 'created',
          taskId: 'task-1',
          error: 'Bearer must-not-leak',
          createdAt,
          updatedAt: createdAt,
        },
      ],
    },
    task: {
      findMany: async () => [
        {
          id: 'task-1',
          repoId: 'repo-1',
          status: 'failed',
          runtime: 'codex',
          executionMode: 'interactive-pty',
          createdAt,
          prompt: 'must-not-leak',
          scheduleRun: { scheduleId: schedule.id, scheduledFor },
        },
      ],
    },
    auditEvent: {
      findMany: async () => [
        {
          id: 'audit-1',
          taskId: 'task-1',
          userId: 'user-1',
          type: 'task.failed',
          level: 'error',
          timestamp: createdAt,
          resultCode: null,
          runId: null,
          description: 'must-not-leak',
        },
      ],
    },
  };
  const provider = new RecordingSandboxProvider();
  await assert.rejects(
    provider.provision({ taskId: 'task-1', cloneSpec: { authHeader: 'must-not-leak' } }),
    /deterministic provision rejection/,
  );

  const control = await startScheduledTasksControlServer({ prisma, provider, port: 0 });
  try {
    const base = `http://127.0.0.1:${control.port}`;
    const dueResponse = await fetch(`${base}/control/schedules/${schedule.id}/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(dueResponse.status, 200);
    const due = await dueResponse.json();
    assert.ok(updateArgs.data.nextRunAt instanceof Date);
    assert.ok(updateArgs.data.nextRunAt.getTime() <= Date.now());
    assert.equal(Object.hasOwn(due.schedule, 'claimToken'), false);
    assert.equal(due.schedule.claimed, true);

    const response = await fetch(
      `${base}/control/evidence?scheduleId=${schedule.id}&taskId=task-1`,
    );
    assert.equal(response.status, 200);
    const evidence = await response.json();
    assert.deepEqual(evidence.providerCalls.map(({ operation, taskId, outcome }) => ({
      operation,
      taskId,
      outcome,
    })), [
      { operation: 'provision', taskId: 'task-1', outcome: 'rejected' },
    ]);
    assert.equal(evidence.diagnostics.schedule.id, schedule.id);
    assert.equal(evidence.diagnostics.runs[0].hasError, true);
    assert.deepEqual(evidence.diagnostics.tasks[0].scheduleProvenance, {
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
    });
    assert.equal(evidence.diagnostics.audit[0].type, 'task.failed');
    assert.equal(JSON.stringify(evidence).includes('must-not-leak'), false);
  } finally {
    await control.close();
  }
});

test('control server rejects future dueAt and missing schedules', async () => {
  const prisma = {
    taskSchedule: {
      findUnique: async ({ where }) => (where.id === 'missing' ? null : undefined),
    },
  };
  const control = await startScheduledTasksControlServer({
    prisma,
    provider: new RecordingSandboxProvider(),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${control.port}`;
    const future = await fetch(`${base}/control/schedules/schedule-1/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dueAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    assert.equal(future.status, 400);
    assert.deepEqual(await future.json(), { error: 'invalid_due_at' });

    const missing = await fetch(`${base}/control/schedules/missing/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'schedule_not_found' });
  } finally {
    await control.close();
  }
});
