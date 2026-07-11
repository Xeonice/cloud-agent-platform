import assert from 'node:assert/strict';
import test from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import type { DispatchScheduleRequest } from '@cap/contracts';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
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
