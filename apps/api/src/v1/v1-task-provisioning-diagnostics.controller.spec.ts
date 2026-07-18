import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import {
  Injectable,
  RequestMethod,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticsQuery,
} from '@cap/contracts';

import type { OperatorPrincipal } from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import {
  PublicV1ContractInterceptor,
  PublicV1OperationGuard,
  publicV1OperationForHandler,
} from '../public-surface/public-v1-operation';
import { PublicSurfaceError } from '../public-surface/public-surface-error';
import { TaskProvisioningDiagnosticsPublicQueryService } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-public-query.service';
import { V1TaskProvisioningDiagnosticsController } from './v1-task-provisioning-diagnostics.controller';

const OWNER_ID = '10000000-0000-4000-8000-000000000002';
const ADMIN_ID = '10000000-0000-4000-8000-000000000003';
const TASK_ID = '10000000-0000-4000-8000-000000000001';

const OWNER_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};
const ADMIN_PRINCIPAL: OperatorPrincipal = {
  ...OWNER_PRINCIPAL,
  user: {
    ...OWNER_PRINCIPAL.user!,
    id: ADMIN_ID,
    role: 'admin',
  },
};
const RESPONSE = TaskProvisioningDiagnosticsResponseSchema.parse({
  schemaVersion: 1,
  taskId: TASK_ID,
  coverage: 'unavailable',
  admissionState: null,
  attempts: [],
  events: [],
  compaction: null,
  nextCursor: null,
});

let principal: OperatorPrincipal = OWNER_PRINCIPAL;
let calls: Array<{
  ownerUserId: string;
  taskId: string;
  query: TaskProvisioningDiagnosticsQuery;
}> = [];
let facadeFailure: unknown;
let app: INestApplication;
let port = 0;

@Injectable()
class MutablePrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<AuthenticatedRequest>().operatorPrincipal =
      principal;
    return true;
  }
}

before(async () => {
  const facade = {
    async readForOwner(
      ownerUserId: string,
      taskId: string,
      query: TaskProvisioningDiagnosticsQuery,
    ) {
      calls.push({ ownerUserId, taskId, query });
      if (facadeFailure !== undefined) throw facadeFailure;
      return RESPONSE;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [V1TaskProvisioningDiagnosticsController],
    providers: [
      { provide: APP_GUARD, useClass: MutablePrincipalGuard },
      PublicV1OperationGuard,
      PublicV1ContractInterceptor,
      {
        provide: TaskProvisioningDiagnosticsPublicQueryService,
        useValue: facade,
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number } | null;
  port = address?.port ?? 0;
  assert.ok(port > 0);
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  principal = OWNER_PRINCIPAL;
  calls = [];
  facadeFailure = undefined;
});

async function readDiagnostics(
  suffix = '',
): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/tasks/${TASK_ID}/provisioning-diagnostics${suffix}`,
  );
  return { response, json: await response.json() };
}

test('V1 diagnostics derives owner and canonical pagination only from the boundary', async () => {
  const { response, json } = await readDiagnostics(
    '?limit=2&cursor=opaque-cursor',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(TaskProvisioningDiagnosticsResponseSchema.parse(json), RESPONSE);
  assert.deepEqual(calls, [
    {
      ownerUserId: OWNER_ID,
      taskId: TASK_ID,
      query: { limit: 2, cursor: 'opaque-cursor' },
    },
  ]);
});

test('controller metadata binds the exact registry operation and route path', () => {
  const handler = V1TaskProvisioningDiagnosticsController.prototype.read;
  const operation = publicV1OperationForHandler(handler);

  assert.equal(operation?.id, 'tasks.provisioningDiagnostics');
  assert.equal(operation?.path, '/v1/tasks/{id}/provisioning-diagnostics');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/provisioning-diagnostics');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});

test('Public V1 gives administrators no cross-owner bypass flag or identity', async () => {
  principal = ADMIN_PRINCIPAL;
  const { response } = await readDiagnostics();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      ownerUserId: ADMIN_ID,
      taskId: TASK_ID,
      query: { limit: 50 },
    },
  ]);
});

test('missing scope and identity-less legacy owner fail before the facade', async () => {
  principal = {
    ...OWNER_PRINCIPAL,
    kind: 'api-key',
    keyId: 'read-only-key',
    scopes: ['tasks:read'],
  };
  let result = await readDiagnostics();
  assert.equal(result.response.status, 403);
  assert.deepEqual(calls, []);

  principal = { kind: 'legacy-token', user: null };
  result = await readDiagnostics();
  assert.equal(result.response.status, 403);
  assert.deepEqual(result.json, {
    code: 'owner_required',
    message:
      'Task provisioning diagnostics require an authenticated account owner.',
    retryable: false,
  });
  assert.deepEqual(calls, []);
});

test('client-supplied owner/admin fields are rejected before the facade', async () => {
  principal = ADMIN_PRINCIPAL;
  for (const suffix of ['?ownerUserId=attacker', '?admin=true']) {
    const { response } = await readDiagnostics(suffix);
    assert.equal(response.status, 400, suffix);
  }
  assert.deepEqual(calls, []);
});

test('strict UUID, limit, and cursor parsing rejects malformed input before the facade', async () => {
  const invalidUrls = [
    `http://127.0.0.1:${port}/v1/tasks/not-a-uuid/provisioning-diagnostics`,
    `http://127.0.0.1:${port}/v1/tasks/${TASK_ID}/provisioning-diagnostics?limit=0`,
    `http://127.0.0.1:${port}/v1/tasks/${TASK_ID}/provisioning-diagnostics?limit=201`,
    `http://127.0.0.1:${port}/v1/tasks/${TASK_ID}/provisioning-diagnostics?limit=1.5`,
    `http://127.0.0.1:${port}/v1/tasks/${TASK_ID}/provisioning-diagnostics?cursor=`,
  ];

  for (const url of invalidUrls) {
    const response = await fetch(url);
    assert.equal(response.status, 400, url);
  }
  assert.deepEqual(calls, []);
});

test('the operation projects the capability-specific retryable 503 body', async () => {
  facadeFailure = new PublicSurfaceError({
    code: 'task_provisioning_diagnostics_unavailable',
  });
  const { response, json } = await readDiagnostics();

  assert.equal(response.status, 503);
  assert.deepEqual(json, {
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  });
  assert.equal(calls.length, 1);
});
