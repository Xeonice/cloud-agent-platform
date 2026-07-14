import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import { SANDBOX_PROVIDER } from '../sandbox/sandbox-provider.port';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import {
  AUDIT_TIMELINE_READER,
  TRANSCRIPT_STORE,
} from '../tasks/session-history.controller';
import { TasksService } from '../tasks/tasks.service';
import { AuditService } from '../audit/audit.service';
import { IdempotencyService } from './idempotency.service';
import { V1EventsController } from './v1-events.controller';
import { V1ReposController } from './v1-repos.controller';
import { V1SchedulesController } from './v1-schedules.controller';
import { V1TasksController } from './v1-tasks.controller';
import { V1TranscriptController } from './v1-transcript.controller';

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const VALID_REPO_ID = '22222222-2222-4222-8222-222222222222';

const PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: 'account-1',
    githubId: null,
    login: null,
    name: 'Contract Test',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};

@Injectable()
class StubPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().operatorPrincipal = PRINCIPAL;
    return true;
  }
}

let app: INestApplication;
let port = 0;
let businessCalls = 0;
let taskFindCalls = 0;
let auditCalls = 0;
let taskExists = true;
let capturedIdempotencyKey: string | null | undefined;
let capturedDispatchBody: unknown;

const taskResponse = {
  id: VALID_ID,
  repoId: VALID_REPO_ID,
  prompt: 'contract test',
  status: 'pending',
  createdAt: new Date('2026-07-10T00:00:00.000Z'),
  branch: null,
  strategy: null,
  skills: [],
  idleTimeoutMs: null,
  deadlineMs: null,
  runtime: 'codex',
};

const scheduleResponse = {
  id: VALID_ID,
  ownerUserId: 'account-1',
  repoId: VALID_REPO_ID,
  name: 'contract schedule',
  cronExpression: '0 9 * * *',
  timezone: 'UTC',
  recurrence: {
    kind: 'daily',
    time: '09:00',
    timezone: 'UTC',
    label: '每天 09:00',
  },
  enabled: true,
  nextRunAt: new Date('2026-07-11T09:00:00.000Z'),
  overlapPolicy: 'skip',
  misfirePolicy: 'fire-once',
  taskTemplate: {
    repoId: VALID_REPO_ID,
    prompt: 'contract dispatch',
    runtime: 'codex',
    sandboxEnvironmentId: null,
    deliver: 'none',
  },
  latestRun: null,
  createdAt: new Date('2026-07-10T00:00:00.000Z'),
  updatedAt: new Date('2026-07-10T00:00:00.000Z'),
};

before(async () => {
  const tasks = {
    async prepareTaskCreate() {
      businessCalls += 1;
      throw new Error('unexpected preparation in validation test');
    },
    async createTaskRow() {
      businessCalls += 1;
      return taskResponse;
    },
    async admitCreatedTask() {
      businessCalls += 1;
    },
    async findById() {
      businessCalls += 1;
      taskFindCalls += 1;
      if (!taskExists) throw new NotFoundException('Task not found');
      return taskResponse;
    },
    async stop() {
      businessCalls += 1;
      return taskResponse;
    },
  };

  const prisma = {
    task: {
      async findMany() {
        businessCalls += 1;
        return [];
      },
    },
    repo: {
      async findMany() {
        businessCalls += 1;
        return [];
      },
    },
  };

  const repos = {
    async findById() {
      businessCalls += 1;
      return { id: VALID_REPO_ID };
    },
  };

  const scheduleCall = async () => {
    businessCalls += 1;
    return { items: [], nextCursor: null };
  };
  const schedules = {
    listPage: scheduleCall,
    create: scheduleCall,
    get: scheduleCall,
    update: scheduleCall,
    pause: scheduleCall,
    resume: scheduleCall,
    async dispatchNow(
      _ownerUserId: string,
      _id: string,
      body: unknown,
    ) {
      businessCalls += 1;
      capturedDispatchBody = body;
      return scheduleResponse;
    },
    delete: scheduleCall,
    listRunsPage: scheduleCall,
  };

  const idempotency = {
    async lookup(args: {
      key: string | null;
    }): Promise<{
      kind: 'replay';
      requestHash: string;
      task: typeof taskResponse;
    }> {
      businessCalls += 1;
      capturedIdempotencyKey = args.key;
      return { kind: 'replay', requestHash: 'request-hash', task: taskResponse };
    },
  };

  const audit = {
    async queryTask() {
      businessCalls += 1;
      auditCalls += 1;
      return [];
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [
      V1TasksController,
      V1ReposController,
      V1SchedulesController,
      V1TranscriptController,
      V1EventsController,
    ],
    providers: [
      { provide: APP_GUARD, useClass: StubPrincipalGuard },
      { provide: TasksService, useValue: tasks },
      { provide: PrismaService, useValue: prisma },
      { provide: ReposService, useValue: repos },
      { provide: ScheduledTasksService, useValue: schedules },
      { provide: IdempotencyService, useValue: idempotency },
      { provide: AuditService, useValue: audit },
      { provide: SANDBOX_PROVIDER, useValue: {} },
      { provide: TRANSCRIPT_STORE, useValue: {} },
      { provide: AUDIT_TIMELINE_READER, useValue: {} },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number } | null;
  port = address?.port ?? 0;
  assert.ok(port > 0, 'Nest test server must bind an ephemeral port');
});

after(async () => {
  await app?.close();
});

beforeEach(() => {
  businessCalls = 0;
  taskFindCalls = 0;
  auditCalls = 0;
  taskExists = true;
  capturedIdempotencyKey = undefined;
  capturedDispatchBody = undefined;
});

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url(path), init);
  await response.arrayBuffer();
  return response;
}

test('all public list queries reject invalid limits and an empty cursor before services', async () => {
  const endpoints = [
    '/v1/tasks',
    '/v1/repos',
    '/v1/schedules',
    `/v1/schedules/${VALID_ID}/runs`,
  ];
  const invalidQueries = ['limit=201', 'limit=1.5', 'limit=abc', 'cursor='];

  for (const endpoint of endpoints) {
    for (const query of invalidQueries) {
      businessCalls = 0;
      const response = await request(`${endpoint}?${query}`);
      assert.equal(response.status, 400, `${endpoint}?${query}`);
      assert.equal(businessCalls, 0, `${endpoint}?${query} reached a service`);
    }
  }
});

test('every public by-id route rejects a non-UUID before controller services', async () => {
  const invalidId = 'not-a-uuid';
  const routes: Array<{ path: string; init?: RequestInit }> = [
    { path: `/v1/tasks/${invalidId}` },
    { path: `/v1/tasks/${invalidId}/stop`, init: { method: 'POST' } },
    { path: `/v1/tasks/${invalidId}/transcript` },
    { path: `/v1/tasks/${invalidId}/events` },
    { path: `/v1/repos/${invalidId}` },
    { path: `/v1/schedules/${invalidId}` },
    {
      path: `/v1/schedules/${invalidId}`,
      init: {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'updated' }),
      },
    },
    { path: `/v1/schedules/${invalidId}/pause`, init: { method: 'POST' } },
    { path: `/v1/schedules/${invalidId}/resume`, init: { method: 'POST' } },
    { path: `/v1/schedules/${invalidId}/dispatch`, init: { method: 'POST' } },
    { path: `/v1/schedules/${invalidId}`, init: { method: 'DELETE' } },
    { path: `/v1/schedules/${invalidId}/runs` },
  ];

  for (const route of routes) {
    businessCalls = 0;
    const response = await request(route.path, route.init);
    assert.equal(
      response.status,
      400,
      `${route.init?.method ?? 'GET'} ${route.path}`,
    );
    assert.equal(
      businessCalls,
      0,
      `${route.init?.method ?? 'GET'} ${route.path} reached a service`,
    );
  }
});

test('task events verifies existence and returns 404 before opening the SSE stream', async () => {
  taskExists = false;

  const response = await request(`/v1/tasks/${VALID_ID}/events`);

  assert.equal(response.status, 404);
  assert.equal(taskFindCalls, 1, 'task existence is checked exactly once');
  assert.equal(auditCalls, 0, 'the event tail is untouched for an unknown task');
  assert.doesNotMatch(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
    'the 404 is emitted before SSE headers',
  );
});

test('task events rejects a blank Last-Event-ID before task lookup or SSE output', async () => {
  const response = await request(`/v1/tasks/${VALID_ID}/events`, {
    headers: { 'last-event-id': '   ' },
  });

  assert.equal(response.status, 400);
  assert.equal(businessCalls, 0);
  assert.equal(taskFindCalls, 0);
  assert.equal(auditCalls, 0);
  assert.doesNotMatch(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
  );
});

test('task create rejects a blank idempotency key and normalizes a valid key', async () => {
  const body = JSON.stringify({ repoId: VALID_REPO_ID, prompt: 'run once' });
  const blank = await request('/v1/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': '   ',
    },
    body,
  });
  assert.equal(blank.status, 400);
  assert.equal(businessCalls, 0, 'blank key is rejected before idempotency/service');

  const normalized = await request('/v1/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': '  retry-1  ',
    },
    body,
  });
  assert.equal(normalized.status, 201);
  assert.equal(capturedIdempotencyKey, 'retry-1');
});

test('schedule dispatch validates and forwards the optional period key', async () => {
  const invalid = await request(`/v1/schedules/${VALID_ID}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedPeriodKey: '' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(businessCalls, 0, 'invalid period key reached the schedule service');

  const omitted = await request(`/v1/schedules/${VALID_ID}/dispatch`, {
    method: 'POST',
  });
  assert.equal(omitted.status, 200);
  assert.deepEqual(capturedDispatchBody, {});

  const valid = await request(`/v1/schedules/${VALID_ID}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedPeriodKey: 'day:2026-07-11' }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(capturedDispatchBody, {
    expectedPeriodKey: 'day:2026-07-11',
  });
});
