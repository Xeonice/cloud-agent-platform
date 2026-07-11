import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
const SCHEDULED_FOR = new Date('2026-07-09T09:00:00.000Z');

function taskRow(scheduleRun: { scheduleId: string; scheduledFor: Date } | null) {
  return {
    id: TASK_ID,
    repoId: REPO_ID,
    prompt: 'scheduled work',
    status: 'pending',
    createdAt: new Date('2026-07-09T08:59:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    sandboxEnvironmentId: null,
    executionMode: 'headless-exec',
    deliver: 'none',
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun,
  };
}

function buildService(scheduleRun: { scheduleId: string; scheduledFor: Date } | null) {
  let row = taskRow(scheduleRun);
  const prisma = {
    task: {
      findUnique: async () => row,
      updateMany: async ({
        where,
        data,
      }: {
        where: { status: string };
        data: { status: string };
      }) => {
        if (row.status !== where.status) return { count: 0 };
        row = { ...row, status: data.status };
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  return new TasksService(prisma);
}

test('scheduled task read includes nullable schedule provenance', async () => {
  const service = buildService({
    scheduleId: SCHEDULE_ID,
    scheduledFor: SCHEDULED_FOR,
  });
  const response = await service.findById(TASK_ID);
  assert.deepEqual(response.scheduleProvenance, {
    scheduleId: SCHEDULE_ID,
    scheduledFor: SCHEDULED_FOR,
  });
  assert.equal(response.status, 'pending');
});

test('direct task read returns null schedule provenance', async () => {
  const service = buildService(null);
  const response = await service.findById(TASK_ID);
  assert.equal(response.scheduleProvenance, null);
});

test('schedule provenance does not gate normal lifecycle transitions', async () => {
  const service = buildService({
    scheduleId: SCHEDULE_ID,
    scheduledFor: SCHEDULED_FOR,
  });
  const response = await service.transition(TASK_ID, 'running');
  assert.equal(response.status, 'running');
  assert.deepEqual(response.scheduleProvenance, {
    scheduleId: SCHEDULE_ID,
    scheduledFor: SCHEDULED_FOR,
  });
});
