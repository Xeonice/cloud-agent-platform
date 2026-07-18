import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import {
  Injectable,
  RequestMethod,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticsQuery,
} from '@cap/contracts';

import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import type { AuthSessionService } from '../auth/auth-session.service';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { TaskProvisioningDiagnosticsConsoleController } from './task-provisioning-diagnostics-console.controller';
import { TaskProvisioningDiagnosticsConsoleQueryService } from './task-provisioning-diagnostics-console-query.service';
import { TaskProvisioningDiagnosticsModule } from './task-provisioning-diagnostics.module';

const OWNER_ID = '10000000-0000-4000-8000-000000000002';
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

let principal: OperatorPrincipal | undefined = OWNER_PRINCIPAL;
let calls: Array<{
  accountId: string;
  taskId: string;
  query: TaskProvisioningDiagnosticsQuery;
}> = [];
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
  const queryService = {
    async readForSessionAccount(
      accountId: string,
      taskId: string,
      query: TaskProvisioningDiagnosticsQuery,
    ) {
      calls.push({ accountId, taskId, query });
      return RESPONSE;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [TaskProvisioningDiagnosticsConsoleController],
    providers: [
      { provide: APP_GUARD, useClass: MutablePrincipalGuard },
      {
        provide: TaskProvisioningDiagnosticsConsoleQueryService,
        useValue: queryService,
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
});

async function readDiagnostics(
  taskId = TASK_ID,
  suffix = '',
): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/tasks/${taskId}/provisioning-diagnostics${suffix}`,
  );
  return { response, json: await response.json() };
}

test('Console route delegates a session account and canonical default pagination', async () => {
  const { response, json } = await readDiagnostics();

  assert.equal(response.status, 200);
  assert.deepEqual(TaskProvisioningDiagnosticsResponseSchema.parse(json), RESPONSE);
  assert.deepEqual(calls, [
    { accountId: OWNER_ID, taskId: TASK_ID, query: { limit: 50 } },
  ]);
});

test('Console route parses the bounded canonical cursor query', async () => {
  const { response } = await readDiagnostics(
    TASK_ID,
    '?limit=17&cursor=opaque-cursor',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      accountId: OWNER_ID,
      taskId: TASK_ID,
      query: { limit: 17, cursor: 'opaque-cursor' },
    },
  ]);
});

test('controller metadata binds only the Internal Console task route', () => {
  const controllerPath = Reflect.getMetadata(
    PATH_METADATA,
    TaskProvisioningDiagnosticsConsoleController,
  );
  const handler = TaskProvisioningDiagnosticsConsoleController.prototype.read;

  assert.equal(controllerPath, 'tasks');
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, handler),
    ':id/provisioning-diagnostics',
  );
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);

  const controllers =
    (Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      TaskProvisioningDiagnosticsModule,
    ) as unknown[] | undefined) ?? [];
  const exports =
    (Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      TaskProvisioningDiagnosticsModule,
    ) as unknown[] | undefined) ?? [];
  assert.equal(
    controllers.includes(TaskProvisioningDiagnosticsConsoleController),
    true,
  );
  assert.equal(
    exports.includes(TaskProvisioningDiagnosticsConsoleQueryService),
    false,
    'the Console administrator exception remains module-private',
  );
});

test('API key, MCP, and legacy principals receive 403 before the query service', async () => {
  const machinePrincipals: OperatorPrincipal[] = [
    {
      ...OWNER_PRINCIPAL,
      kind: 'api-key',
      keyId: 'diagnostics-key',
      scopes: ['tasks:diagnostics'],
    },
    {
      ...OWNER_PRINCIPAL,
      kind: 'mcp',
      scopes: ['tasks:diagnostics'],
    },
    { kind: 'legacy-token', user: null },
  ];

  for (const machinePrincipal of machinePrincipals) {
    principal = machinePrincipal;
    const { response, json } = await readDiagnostics();
    assert.equal(response.status, 403, machinePrincipal.kind);
    assert.deepEqual(
      json,
      {
        error: 'session_operator_required',
        message:
          'Task provisioning diagnostics require an authenticated Console session.',
      },
      machinePrincipal.kind,
    );
  }
  assert.deepEqual(calls, []);
});

test('a missing principal cannot reach the query service even behind a permissive test guard', async () => {
  principal = undefined;

  const { response } = await readDiagnostics();

  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test('strict UUID, limit, cursor, and unknown-field validation runs before the query service', async () => {
  const invalidUrls = [
    `http://127.0.0.1:${port}/tasks/not-a-uuid/provisioning-diagnostics`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?limit=0`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?limit=201`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?limit=1.5`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?cursor=`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?cursor=${'x'.repeat(2_049)}`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?ownerUserId=attacker`,
    `http://127.0.0.1:${port}/tasks/${TASK_ID}/provisioning-diagnostics?admin=true`,
  ];

  for (const url of invalidUrls) {
    const response = await fetch(url);
    assert.equal(response.status, 400, url);
  }
  assert.deepEqual(calls, []);
});

test('the real AuthGuard does not exempt the Console diagnostics path', async () => {
  const authSession = {
    resolveSession: async () => null,
    resolveApiKey: async () => null,
    resolveMcpToken: async () => null,
    requiresPasswordChange: async () => false,
  } as unknown as AuthSessionService;
  const guard = new AuthGuard(authSession);
  const request = {
    path: `/tasks/${TASK_ID}/provisioning-diagnostics`,
    url: `/tasks/${TASK_ID}/provisioning-diagnostics`,
    headers: {},
  } as unknown as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;

  await assert.rejects(
    () => guard.canActivate(context),
    (error: unknown) => error instanceof UnauthorizedException,
  );
  assert.equal(request.operatorPrincipal, undefined);
});
