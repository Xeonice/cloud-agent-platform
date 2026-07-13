import assert from 'node:assert/strict';
import test from 'node:test';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  type CreateScheduleRequest,
  type DispatchScheduleRequest,
  type UpdateScheduleRequest,
} from '@cap/contracts';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { ScheduledTasksController } from './scheduled-tasks.controller';
import type { ScheduledTasksService } from './scheduled-tasks.service';

const OWNER_USER_ID = 'account-1';
const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const DISPATCH_BODY: DispatchScheduleRequest = {
  expectedPeriodKey: 'day:2026-07-11',
};

const WRITE_PRINCIPAL: OperatorPrincipal = {
  kind: 'api-key',
  user: {
    id: OWNER_USER_ID,
    githubId: null,
    login: null,
    name: 'Schedule Operator',
    avatarUrl: null,
    role: 'member',
    allowed: true,
    mustChangePassword: false,
  },
  scopes: ['tasks:read', 'tasks:write'],
  keyId: 'key-write',
};

const requestWith = (principal: OperatorPrincipal): AuthenticatedRequest =>
  ({ operatorPrincipal: principal }) as AuthenticatedRequest;

const BODY_METADATA = { type: 'body' as const, metatype: Object, data: undefined };

test('create and update forward validated sub-day recurrence bodies', async () => {
  const calls: Array<{ operation: string; cronExpression: string }> = [];
  const expected = { id: SCHEDULE_ID };
  const controller = new ScheduledTasksController({
    async create(_ownerUserId: string, body: { cronExpression: string }) {
      calls.push({ operation: 'create', cronExpression: body.cronExpression });
      return expected;
    },
    async update(
      _ownerUserId: string,
      _id: string,
      body: { cronExpression: string },
    ) {
      calls.push({ operation: 'update', cronExpression: body.cronExpression });
      return expected;
    },
  } as unknown as ScheduledTasksService);
  const createPipe = new ZodValidationPipe(CreateScheduleRequestSchema);
  const updatePipe = new ZodValidationPipe(UpdateScheduleRequestSchema);

  const hourly = createPipe.transform(
    {
      recurrence: {
        kind: 'hourly',
        minuteOfHour: 15,
        timezone: 'Asia/Shanghai',
      },
      taskTemplate: {
        repoId: '22222222-2222-4222-8222-222222222222',
        prompt: 'hourly check',
      },
    },
    BODY_METADATA,
  ) as CreateScheduleRequest;
  const interval = updatePipe.transform(
    {
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 30,
        timezone: 'UTC',
      },
    },
    BODY_METADATA,
  ) as UpdateScheduleRequest;

  await controller.create(hourly, requestWith(WRITE_PRINCIPAL));
  await controller.update(
    SCHEDULE_ID,
    interval,
    requestWith(WRITE_PRINCIPAL),
  );
  assert.deepEqual(calls, [
    { operation: 'create', cronExpression: '15 * * * *' },
    { operation: 'update', cronExpression: '*/30 * * * *' },
  ]);

  for (const invalid of [
    {
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 7,
        timezone: 'UTC',
      },
    },
    {
      recurrence: { kind: 'hourly', minuteOfHour: 15, timezone: 'UTC' },
      cronExpression: '15 * * * *',
    },
  ]) {
    assert.throws(
      () => updatePipe.transform(invalid, BODY_METADATA),
      BadRequestException,
    );
  }
  assert.equal(calls.length, 2);
});

test('dispatch forwards the owner and expected period contract to the service', async () => {
  let captured:
    | {
        ownerUserId: string;
        id: string;
        body: DispatchScheduleRequest;
      }
    | undefined;
  const expected = { id: SCHEDULE_ID };
  const controller = new ScheduledTasksController({
    async dispatchNow(
      ownerUserId: string,
      id: string,
      body: DispatchScheduleRequest,
    ) {
      captured = { ownerUserId, id, body };
      return expected;
    },
  } as unknown as ScheduledTasksService);

  const result = await controller.dispatch(
    SCHEDULE_ID,
    DISPATCH_BODY,
    requestWith(WRITE_PRINCIPAL),
  );

  assert.equal(result, expected);
  assert.deepEqual(captured, {
    ownerUserId: OWNER_USER_ID,
    id: SCHEDULE_ID,
    body: DISPATCH_BODY,
  });
});

test('dispatch rejects a read-only principal before calling the service', async () => {
  let called = false;
  const controller = new ScheduledTasksController({
    async dispatchNow() {
      called = true;
      return { id: SCHEDULE_ID };
    },
  } as unknown as ScheduledTasksService);

  await assert.rejects(
    () =>
      controller.dispatch(
        SCHEDULE_ID,
        DISPATCH_BODY,
        requestWith({
          ...WRITE_PRINCIPAL,
          scopes: ['tasks:read'],
          keyId: 'key-read',
        }),
      ),
    ForbiddenException,
  );
  assert.equal(called, false);
});
