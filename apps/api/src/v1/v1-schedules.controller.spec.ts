import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  type ScheduleResponse,
} from '@cap/contracts';
import type {
  ScheduleRunResponse,
  V1ListScheduleRunsResponse,
  V1ListSchedulesResponse,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { V1SchedulesController } from './v1-schedules.controller';

const USER_A = 'acct-a';
const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';

const WRITE_KEY: OperatorPrincipal = {
  kind: 'api-key',
  user: {
    id: USER_A,
    githubId: null,
    login: null,
    name: 'Bot',
    avatarUrl: null,
    role: 'member',
    allowed: true,
    mustChangePassword: false,
  },
  scopes: ['tasks:read', 'tasks:write'],
  keyId: 'key-write',
};

const READ_ONLY_KEY: OperatorPrincipal = {
  ...WRITE_KEY,
  scopes: ['tasks:read'],
  keyId: 'key-read',
};

const LEGACY: OperatorPrincipal = {
  kind: 'legacy-token',
  user: null,
};

const reqWith = (principal: OperatorPrincipal): AuthenticatedRequest =>
  ({ operatorPrincipal: principal }) as AuthenticatedRequest;

function scheduleResponse(): ScheduleResponse {
  return {
    id: SCHEDULE_ID,
    ownerUserId: USER_A,
    repoId: REPO_ID,
    name: 'daily',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    recurrence: {
      kind: 'daily',
      time: '09:00',
      timezone: 'UTC',
      label: '每天 09:00',
    },
    enabled: true,
    nextRunAt: new Date('2026-07-10T09:00:00.000Z'),
    overlapPolicy: 'skip',
    misfirePolicy: 'fire-once',
    taskTemplate: {
      repoId: REPO_ID,
      prompt: 'daily',
      runtime: 'codex',
      sandboxEnvironmentId: null,
      deliver: 'none',
    },
    latestRun: null,
    createdAt: new Date('2026-07-09T00:00:00.000Z'),
    updatedAt: new Date('2026-07-09T00:00:00.000Z'),
  };
}

function runResponse(): ScheduleRunResponse {
  return {
    id: RUN_ID,
    scheduleId: SCHEDULE_ID,
    scheduledFor: new Date('2026-07-09T09:00:00.000Z'),
    status: 'skipped',
    taskId: null,
    error: 'overlap: prior scheduled task still active',
    createdAt: new Date('2026-07-09T09:00:00.000Z'),
    updatedAt: new Date('2026-07-09T09:00:00.000Z'),
  };
}

test('read-only key cannot create a schedule', async () => {
  let created = false;
  const controller = new V1SchedulesController({
    async create() {
      created = true;
      return scheduleResponse();
    },
  } as unknown as ScheduledTasksService);

  await assert.rejects(
    () =>
      controller.create(
        {
          cronExpression: '0 9 * * *',
          timezone: 'UTC',
          overlapPolicy: 'skip',
          misfirePolicy: 'fire-once',
          taskTemplate: { repoId: REPO_ID, prompt: 'daily' },
        },
        reqWith(READ_ONLY_KEY),
      ),
    ForbiddenException,
  );
  assert.equal(created, false);
});

test('ownerless principal reaches create as ownerless so service returns shared 400 shape', async () => {
  const controller = new V1SchedulesController({
    async create(ownerUserId: string | undefined) {
      assert.equal(ownerUserId, undefined);
      throw new BadRequestException({
        error: 'schedule_owner_required',
        message: 'Schedules require an authenticated account owner.',
      });
    },
  } as unknown as ScheduledTasksService);

  await assert.rejects(
    () =>
      controller.create(
        {
          cronExpression: '0 9 * * *',
          timezone: 'UTC',
          overlapPolicy: 'skip',
          misfirePolicy: 'fire-once',
          taskTemplate: { repoId: REPO_ID, prompt: 'daily' },
        },
        reqWith(LEGACY),
      ),
    (err: unknown) =>
      err instanceof BadRequestException &&
      (err.getResponse() as { error?: string }).error === 'schedule_owner_required',
  );
});

test('write key can create with a recurrence-first payload', async () => {
  const seen: Array<{ ownerUserId: string | undefined; cronExpression: string }> = [];
  const controller = new V1SchedulesController({
    async create(ownerUserId: string | undefined, body: { cronExpression: string }) {
      seen.push({ ownerUserId, cronExpression: body.cronExpression });
      return scheduleResponse();
    },
  } as unknown as ScheduledTasksService);

  const result = await controller.create(
    CreateScheduleRequestSchema.parse({
      recurrence: {
        kind: 'weekdays',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
      overlapPolicy: 'skip',
      misfirePolicy: 'fire-once',
      taskTemplate: { repoId: REPO_ID, prompt: 'weekday check' },
    }),
    reqWith(WRITE_KEY),
  );

  assert.equal(result.id, SCHEDULE_ID);
  assert.deepEqual(seen, [{ ownerUserId: USER_A, cronExpression: '30 9 * * 1-5' }]);
});

test('list is owner-scoped and forwards pagination', async () => {
  const seen: Array<{ ownerUserId: string; limit: number; cursor?: string }> = [];
  const controller = new V1SchedulesController({
    async listPage(ownerUserId: string, args: { limit: number; cursor?: string }) {
      seen.push({ ownerUserId, ...args });
      return {
        items: [scheduleResponse()],
        nextCursor: 'next',
      } satisfies V1ListSchedulesResponse;
    },
  } as unknown as ScheduledTasksService);

  const result = await controller.list(
    { limit: 25, cursor: 'cursor' },
    reqWith(WRITE_KEY),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, 'next');
  assert.deepEqual(seen, [{ ownerUserId: USER_A, limit: 25, cursor: 'cursor' }]);
});

test('mutating routes pass the principal account id', async () => {
  const calls: string[] = [];
  const controller = new V1SchedulesController({
    async update(ownerUserId: string) {
      calls.push(`update:${ownerUserId}`);
      return scheduleResponse();
    },
    async pause(ownerUserId: string) {
      calls.push(`pause:${ownerUserId}`);
      return scheduleResponse();
    },
    async resume(ownerUserId: string) {
      calls.push(`resume:${ownerUserId}`);
      return scheduleResponse();
    },
    async dispatchNow(ownerUserId: string) {
      calls.push(`dispatch:${ownerUserId}`);
      return scheduleResponse();
    },
    async delete(ownerUserId: string) {
      calls.push(`delete:${ownerUserId}`);
    },
  } as unknown as ScheduledTasksService);

  await controller.update(
    SCHEDULE_ID,
    { name: 'renamed' },
    reqWith(WRITE_KEY),
  );
  await controller.pause(SCHEDULE_ID, reqWith(WRITE_KEY));
  await controller.resume(SCHEDULE_ID, reqWith(WRITE_KEY));
  await controller.dispatch(SCHEDULE_ID, reqWith(WRITE_KEY));
  await controller.delete(SCHEDULE_ID, reqWith(WRITE_KEY));
  assert.deepEqual(calls, [
    `update:${USER_A}`,
    `pause:${USER_A}`,
    `resume:${USER_A}`,
    `dispatch:${USER_A}`,
    `delete:${USER_A}`,
  ]);
});

test('run listing returns paginated skipped/failed rows without task links', async () => {
  const controller = new V1SchedulesController({
    async listRunsPage(
      ownerUserId: string,
      scheduleId: string,
      args: { limit: number; cursor?: string },
    ) {
      assert.equal(ownerUserId, USER_A);
      assert.equal(scheduleId, SCHEDULE_ID);
      assert.deepEqual(args, { limit: 10, cursor: undefined });
      return {
        items: [runResponse(), { ...runResponse(), id: TASK_ID, status: 'failed', error: 'repo not found' }],
        nextCursor: null,
      } satisfies V1ListScheduleRunsResponse;
    },
  } as unknown as ScheduledTasksService);

  const result = await controller.listRuns(
    SCHEDULE_ID,
    { limit: 10 },
    reqWith(WRITE_KEY),
  );
  assert.equal(result.items[0].status, 'skipped');
  assert.equal(result.items[0].taskId, null);
  assert.equal(result.items[1].status, 'failed');
  assert.equal(result.items[1].error, 'repo not found');
});
