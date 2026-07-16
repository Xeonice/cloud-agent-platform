import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import {
  CreateScheduleRequestSchema,
  CreateTaskRequestSchema,
  RepoResponseSchema,
  ScheduleResponseSchema,
  TaskResponseSchema,
  V1ListReposResponseSchema,
  V1ListTasksResponseSchema,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type PublicErrorCode,
  type RepoResponse,
  type ScheduleResponse,
  type Scope,
  type TaskFailureCode,
  type TaskResponse,
} from '@cap/contracts';
import { firstValueFrom, from } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import {
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
  type ToolRegistrar,
} from '../mcp/mcp-tools';
import type { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import {
  taskResponseFromRecord,
  type TaskResponseRecord,
} from '../tasks/task-response';
import type { PreparedTaskCreate } from '../tasks/prepared-task-create';
import { TasksService } from '../tasks/tasks.service';
import { IdempotencyService } from '../v1/idempotency.service';
import { listRepoPage } from '../v1/public-list-pages';
import { V1ReposController } from '../v1/v1-repos.controller';
import { V1SchedulesController } from '../v1/v1-schedules.controller';
import { V1TasksController } from '../v1/v1-tasks.controller';
import {
  MCP_PUBLIC_ERROR_MAP,
  REST_PUBLIC_ERROR_MAP,
} from './public-error-mappings';
import {
  normalizePublicSurfaceFailure,
  PublicSurfaceError,
} from './public-surface-error';
import {
  PublicV1ContractInterceptor,
  PublicV1OperationGuard,
  publicV1RequestContext,
  type PublicV1Handler,
} from './public-v1-operation';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = 'owner-conformance';
const SECRET_CANARY = 'public-surface-secret-canary';
const CREATED_AT = new Date('2026-07-14T09:00:00.000Z');
const UPDATED_AT = new Date('2026-07-14T09:05:00.000Z');

const PROVISIONING_FAILURES = [
  {
    code: 'provisioning_capacity_exhausted',
    action: 'increase_sandbox_capacity',
  },
  {
    code: 'provisioning_workspace_timeout',
    action: 'retry_task',
  },
  {
    code: 'provisioning_forge_auth_failed',
    action: 'reconnect_forge',
  },
  {
    code: 'provisioning_tls_network_failed',
    action: 'retry_task',
  },
  {
    code: 'provisioning_ref_not_found',
    action: 'verify_repository_ref',
  },
  {
    code: 'provisioning_unknown',
    action: 'retry_task',
  },
] as const satisfies ReadonlyArray<{
  code: TaskFailureCode;
  action: string;
}>;

const OWNER_PRINCIPAL: OperatorPrincipal = {
  kind: 'api-key',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Conformance owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
  scopes: ['tasks:read', 'tasks:write'],
  keyId: 'conformance-key',
};

const ALL_FIELDS_CREATE_INPUT = Object.freeze({
  name: 'all-fields schedule',
  recurrence: Object.freeze({
    kind: 'hourly' as const,
    minuteOfHour: 15,
    timezone: 'Asia/Shanghai',
  }),
  taskTemplate: Object.freeze({
    repoId: REPO_ID,
    prompt: 'exercise every canonical task field',
    branch: 'feature/public-surface-conformance',
    strategy: 'preserve normalized arguments',
    skills: Object.freeze(['openspec']),
    deadlineMs: 3_600_000,
    idleTimeoutMs: 900_000,
    runtime: 'codex' as const,
    model: 'provider/model:v1.2+preview@[region]',
    sandboxEnvironmentId: null,
    deliver: 'pr' as const,
  }),
  enabled: true,
  overlapPolicy: 'skip' as const,
  misfirePolicy: 'fire-once' as const,
});

const CANONICAL_CREATE_INPUT = CreateScheduleRequestSchema.parse(
  ALL_FIELDS_CREATE_INPUT,
);

const SCHEDULE_OUTPUT: ScheduleResponse = ScheduleResponseSchema.parse({
  id: SCHEDULE_ID,
  ownerUserId: OWNER_ID,
  repoId: REPO_ID,
  name: CANONICAL_CREATE_INPUT.name ?? null,
  cronExpression: CANONICAL_CREATE_INPUT.cronExpression,
  timezone: CANONICAL_CREATE_INPUT.timezone,
  recurrence: {
    ...CANONICAL_CREATE_INPUT.recurrence,
    label: '每小时第 15 分钟',
  },
  enabled: CANONICAL_CREATE_INPUT.enabled ?? true,
  nextRunAt: new Date('2026-07-14T10:15:00.000Z'),
  overlapPolicy: CANONICAL_CREATE_INPUT.overlapPolicy,
  misfirePolicy: CANONICAL_CREATE_INPUT.misfirePolicy,
  taskTemplate: CANONICAL_CREATE_INPUT.taskTemplate,
  latestRun: null,
  createdAt: new Date('2026-07-14T09:00:00.000Z'),
  updatedAt: new Date('2026-07-14T09:00:00.000Z'),
});

type ToolCallback = (
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<unknown>;

function captureMcpTools(deps: Partial<McpToolDeps>): Map<string, ToolCallback> {
  const tools = new Map<string, ToolCallback>();
  const server: ToolRegistrar = {
    registerTool(name, _config, callback) {
      const tool = callback as unknown as ToolCallback;
      tools.set(name, tool);
    },
  };
  registerMcpTools(server, deps as McpToolDeps);
  return tools;
}

function ownerExtra(scopes: string[] = ['tasks:write']): ToolExtra {
  return {
    authInfo: {
      token: 'mcp_conformance',
      clientId: 'conformance',
      scopes,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      extra: { userId: OWNER_ID },
    },
  };
}

function fixtureRequest(
  body: unknown,
  principal: OperatorPrincipal = OWNER_PRINCIPAL,
  params: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  headers: Record<string, unknown> = {},
): AuthenticatedRequest {
  return {
    operatorPrincipal: principal,
    params,
    query,
    headers,
    body,
  } as unknown as AuthenticatedRequest;
}

function fixtureContext(
  handler: PublicV1Handler,
  request: AuthenticatedRequest,
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function seedRestBoundary(
  handler: PublicV1Handler,
  request: AuthenticatedRequest,
): ExecutionContext {
  const context = fixtureContext(handler, request);
  assert.equal(new PublicV1OperationGuard().canActivate(context), true);
  return context;
}

async function throughRestOutputBoundary(
  context: ExecutionContext,
  action: () => Promise<unknown>,
): Promise<unknown> {
  return firstValueFrom(
    new PublicV1ContractInterceptor().intercept(context, {
      handle: () => from(action()),
    } as CallHandler),
  );
}

function canonicalJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function principalWithScopes(scopes: Scope[]): OperatorPrincipal {
  return { ...OWNER_PRINCIPAL, scopes };
}

function taskRecord(
  status: TaskResponseRecord['status'],
  failureCode: TaskFailureCode | null = null,
): TaskResponseRecord {
  return {
    id: TASK_ID,
    repoId: REPO_ID,
    prompt: 'exercise the shared task projection',
    status,
    failureCode,
    failureAt: failureCode ? UPDATED_AT : null,
    failureExitCode: null,
    createdAt: CREATED_AT,
    branch: 'master',
    strategy: null,
    skills: ['openspec'],
    idleTimeoutMs: null,
    deadlineMs: 3_600_000,
    runtime: 'codex',
    model: 'gpt-5-codex',
    sandboxEnvironmentId: null,
    executionMode: 'headless-exec',
    deliver: 'none',
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    admissionWork: {
      state: failureCode ? 'failed' : 'accepted',
      stage: failureCode ? 'workspace_transfer' : 'accepted',
      attempt: failureCode ? 1 : 0,
      resolvedBranch: 'master',
      updatedAt: UPDATED_AT,
    },
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  };
}

function unsafeTaskOutput(
  status: TaskResponseRecord['status'],
  failureCode: TaskFailureCode | null = null,
): TaskResponse {
  const persisted = {
    ...taskRecord(status, failureCode),
    leaseOwner: SECRET_CANARY,
    providerEndpoint: `https://${SECRET_CANARY}.invalid`,
    authenticatedCommand: `git clone --token ${SECRET_CANARY}`,
  };
  return taskResponseFromRecord(persisted);
}

function repoRecord(
  id: string,
  defaultBranch: string | null,
): RepoResponse & Record<string, unknown> {
  return {
    id,
    name: defaultBranch === null ? 'legacy-repo' : 'master-repo',
    gitSource: `https://example.invalid/${id}.git`,
    createdAt: CREATED_AT,
    description: null,
    defaultBranch,
    branchCount: null,
    updatedAt: UPDATED_AT,
    githubId: null,
    isDefault: false,
    forge: null,
    credential: SECRET_CANARY,
    providerEndpoint: `https://${SECRET_CANARY}.invalid`,
  };
}

interface McpSuccess {
  readonly structuredContent: unknown;
  readonly content?: Array<{ readonly text?: string }>;
  readonly isError?: boolean;
}

function parseMcpSuccess(result: unknown): {
  structured: unknown;
  text: unknown;
  rawText: string;
} {
  assert.ok(result && typeof result === 'object');
  const success = result as McpSuccess;
  assert.notEqual(success.isError, true);
  const rawText = success.content?.[0]?.text;
  if (typeof rawText !== 'string') {
    throw new TypeError('expected MCP text content');
  }
  return {
    structured: success.structuredContent,
    text: JSON.parse(rawText),
    rawText,
  };
}

function assertNoSecretCanary(...values: unknown[]): void {
  const serialized = JSON.stringify(values);
  assert.equal(serialized.includes(SECRET_CANARY), false);
  for (const field of [
    'leaseOwner',
    'providerEndpoint',
    'authenticatedCommand',
    'credential',
  ]) {
    assert.equal(serialized.includes(field), false, field);
  }
}

function captureSyncFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected a synchronous boundary failure');
}

async function captureAsyncFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail('expected an asynchronous boundary failure');
}

function assertMcpFailureCode(
  result: unknown,
  expected: PublicErrorCode,
): void {
  assert.ok(result && typeof result === 'object');
  const errorResult = result as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    _meta?: Record<string, unknown>;
    structuredContent?: unknown;
  };
  assert.equal(errorResult.isError, true);
  assert.equal(errorResult.structuredContent, undefined);
  const envelope = errorResult._meta?.[
    'com.cloud-agent-platform/public-error'
  ] as { code?: string; message?: string; retryable?: boolean } | undefined;
  assert.equal(envelope?.code, expected);
  assert.equal(envelope?.retryable, MCP_PUBLIC_ERROR_MAP[expected].retryable);
  assert.equal(typeof envelope?.message, 'string');
  assert.ok(
    (errorResult.content?.[0]?.text ?? '').includes(envelope!.message!),
  );
}

function passthroughIdempotency(): IdempotencyService {
  return {
    async lookup() {
      return { kind: 'missing' as const, requestHash: 'conformance-hash' };
    },
    async commit(args: {
      create: (client: unknown) => Promise<TaskResponse>;
    }) {
      return {
        task: await args.create({}),
        created: true,
      };
    },
    async waitForWinner() {
      return null;
    },
  } as unknown as IdempotencyService;
}

function replayIdempotency(task: TaskResponse): IdempotencyService {
  return {
    async lookup() {
      return { kind: 'replay' as const, task };
    },
    async commit() {
      throw new Error('an exact replay must not commit');
    },
    async waitForWinner() {
      throw new Error('an exact replay must not wait for a winner');
    },
  } as unknown as IdempotencyService;
}

async function restCreateTask(
  controller: V1TasksController,
  body: Record<string, unknown>,
): Promise<unknown> {
  const request = fixtureRequest(
    body,
    principalWithScopes(['tasks:read', 'tasks:write']),
    {},
    {},
    { 'idempotency-key': 'conformance-create' },
  );
  const context = seedRestBoundary(controller.create, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.create(
      input?.body as never,
      request,
      (input?.headers as { 'Idempotency-Key'?: string } | undefined)?.[
        'Idempotency-Key'
      ],
    ),
  );
}

async function restListTasks(
  controller: V1TasksController,
): Promise<unknown> {
  const request = fixtureRequest(
    undefined,
    principalWithScopes(['tasks:read']),
    {},
    { limit: '10' },
  );
  const context = seedRestBoundary(controller.list, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.list(input?.query as never, request),
  );
}

async function restGetTask(
  controller: V1TasksController,
): Promise<unknown> {
  const request = fixtureRequest(
    undefined,
    principalWithScopes(['tasks:read']),
    { id: TASK_ID },
  );
  const context = seedRestBoundary(controller.findById, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.findById(
      (input?.params as { id: string }).id,
      request,
    ),
  );
}

async function restStopTask(
  controller: V1TasksController,
): Promise<unknown> {
  const request = fixtureRequest(
    undefined,
    principalWithScopes(['tasks:write']),
    { id: TASK_ID },
  );
  const context = seedRestBoundary(controller.stop, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.stop((input?.params as { id: string }).id, request),
  );
}

async function restListRepos(
  controller: V1ReposController,
): Promise<unknown> {
  const request = fixtureRequest(
    undefined,
    principalWithScopes(['repos:read']),
    {},
    { limit: '10' },
  );
  const context = seedRestBoundary(controller.list, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.list(input?.query as never, request),
  );
}

async function restGetRepo(
  controller: V1ReposController,
  id: string,
): Promise<unknown> {
  const request = fixtureRequest(
    undefined,
    principalWithScopes(['repos:read']),
    { id },
  );
  const context = seedRestBoundary(controller.findById, request);
  const input = publicV1RequestContext(request)?.input;
  return throughRestOutputBoundary(context, () =>
    controller.findById((input?.params as { id: string }).id, request),
  );
}

test('initial accepted task has identical secret-free REST and MCP projections', async () => {
  const unsafeTask = unsafeTaskOutput('pending');
  let restAccepts = 0;
  let restWakes = 0;
  const tasks = {
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      executionMode: 'headless-exec',
      userId?: string,
    ): Promise<PreparedTaskCreate> {
      return {
        repoId,
        ownerUserId: userId ?? null,
        body,
        runtime: body.runtime ?? 'codex',
        executionMode,
        sandboxEnvironmentId: null,
        model: null,
        executionEnvironmentSnapshot: null,
        admissionMode: 'durable-v2',
        resolvedBranch: 'master',
        resourceSnapshot: Object.freeze({}),
        workspaceMaterializationDeadlineMs: 900_000,
      } as PreparedTaskCreate;
    },
    async acceptPreparedTask() {
      restAccepts += 1;
      return unsafeTask;
    },
    async admitCreatedTask() {
      restWakes += 1;
    },
  } as unknown as TasksService;
  const controller = new V1TasksController(
    tasks,
    {} as PrismaService,
    passthroughIdempotency(),
  );
  const createBody = {
    repoId: REPO_ID,
    prompt: 'return the committed handle first',
  };
  const rest = await restCreateTask(controller, createBody);

  let mcpCreates = 0;
  const tools = captureMcpTools({
    async createTask() {
      mcpCreates += 1;
      return unsafeTask;
    },
  });
  const mcp = parseMcpSuccess(
    await tools.get('create_task')!(
      createBody,
      ownerExtra(['tasks:write']),
    ),
  );
  const canonical = TaskResponseSchema.parse(unsafeTask);
  const canonicalWire = canonicalJson(canonical);

  assert.deepEqual(canonicalJson(TaskResponseSchema.parse(rest)), canonicalWire);
  assert.deepEqual(mcp.structured, canonicalWire);
  assert.deepEqual(mcp.text, {
    id: canonical.id,
    status: canonical.status,
    task: canonicalWire,
  });
  assert.deepEqual(canonical.provisioning, {
    state: 'accepted',
    stage: 'accepted',
    attempt: 0,
    resolvedBranch: 'master',
    updatedAt: UPDATED_AT,
  });
  assert.deepEqual(
    { restAccepts, restWakes, mcpCreates },
    { restAccepts: 1, restWakes: 1, mcpCreates: 1 },
  );
  assertNoSecretCanary(rest, mcp.structured, mcp.text);
});

test('all provisioning failures round-trip through task create/list/get/stop on REST and MCP', async () => {
  for (const fixture of PROVISIONING_FAILURES) {
    const unsafeTask = unsafeTaskOutput('failed', fixture.code);
    const rawRecord = {
      ...taskRecord('failed', fixture.code),
      leaseOwner: SECRET_CANARY,
      providerEndpoint: `https://${SECRET_CANARY}.invalid`,
      authenticatedCommand: `git -c token=${SECRET_CANARY} fetch`,
    };
    let currentPreparations = 0;
    let currentAdmissions = 0;
    const tasks = {
      async prepareTaskCreate() {
        currentPreparations += 1;
        throw new Error('an exact replay must not prepare current provisioning');
      },
      async acceptPreparedTask() {
        throw new Error('an exact replay must not accept another task');
      },
      async admitCreatedTask() {
        currentAdmissions += 1;
        throw new Error('an exact replay must not wake admission');
      },
      async findById() {
        return unsafeTask;
      },
      async stop() {
        return unsafeTask;
      },
    } as unknown as TasksService;
    const prisma = {
      task: {
        async findMany() {
          return [rawRecord];
        },
      },
    } as unknown as PrismaService;
    const controller = new V1TasksController(
      tasks,
      prisma,
      replayIdempotency(unsafeTask),
    );
    const restCreate = await restCreateTask(controller, {
      repoId: REPO_ID,
      prompt: 'exact replay after terminal provisioning',
    });
    const restList = await restListTasks(controller);
    const restGet = await restGetTask(controller);
    const restStop = await restStopTask(controller);

    const tools = captureMcpTools({
      async createTask() {
        return unsafeTask;
      },
      async listTasks() {
        return { items: [unsafeTask], nextCursor: null };
      },
      async getTask() {
        return unsafeTask;
      },
      async stopTask() {
        return unsafeTask;
      },
    });
    const mcpCreate = parseMcpSuccess(
      await tools.get('create_task')!(
        { repoId: REPO_ID, prompt: 'terminal replay' },
        ownerExtra(['tasks:write']),
      ),
    );
    const mcpList = parseMcpSuccess(
      await tools.get('list_tasks')!({ limit: 10 }, ownerExtra(['tasks:read'])),
    );
    const mcpGet = parseMcpSuccess(
      await tools.get('get_task')!({ id: TASK_ID }, ownerExtra(['tasks:read'])),
    );
    const mcpStop = parseMcpSuccess(
      await tools.get('stop_task')!({ id: TASK_ID }, ownerExtra(['tasks:write'])),
    );

    const expected = TaskResponseSchema.parse(unsafeTask);
    assert.equal(expected.failure?.code, fixture.code);
    assert.equal(expected.failure?.action, fixture.action);
    const expectedWire = canonicalJson(expected);
    for (const restOutput of [restCreate, restGet, restStop]) {
      assert.deepEqual(
        canonicalJson(TaskResponseSchema.parse(restOutput)),
        expectedWire,
        fixture.code,
      );
    }
    assert.deepEqual(
      canonicalJson(V1ListTasksResponseSchema.parse(restList)),
      { items: [expectedWire], nextCursor: null },
      fixture.code,
    );
    assert.deepEqual(mcpCreate.structured, expectedWire, fixture.code);
    assert.deepEqual(mcpGet.structured, expectedWire, fixture.code);
    assert.deepEqual(mcpStop.structured, expectedWire, fixture.code);
    assert.deepEqual(mcpList.structured, {
      items: [expectedWire],
      nextCursor: null,
    });
    assert.deepEqual(mcpCreate.text, {
      id: expected.id,
      status: expected.status,
      task: expectedWire,
    });
    assert.deepEqual(mcpGet.text, expectedWire);
    assert.deepEqual(mcpStop.text, expectedWire);
    assert.deepEqual(mcpList.text, mcpList.structured);
    assert.deepEqual(
      { currentPreparations, currentAdmissions },
      { currentPreparations: 0, currentAdmissions: 0 },
      fixture.code,
    );
    assertNoSecretCanary(
      restCreate,
      restList,
      restGet,
      restStop,
      mcpCreate.structured,
      mcpCreate.text,
      mcpList.structured,
      mcpList.text,
      mcpGet.structured,
      mcpGet.text,
      mcpStop.structured,
      mcpStop.text,
    );
  }
});

test('repo master and legacy null projections match across REST and MCP without secret fields', async () => {
  const legacyRepoId = '44444444-4444-4444-8444-444444444444';
  const repos = [
    repoRecord(REPO_ID, 'master'),
    repoRecord(legacyRepoId, null),
  ];
  const prisma = {
    repo: {
      async findMany() {
        return repos;
      },
      async findUnique({ where }: { where: { id: string } }) {
        return repos.find((repo) => repo.id === where.id) ?? null;
      },
    },
  } as unknown as PrismaService;
  const reposService = new ReposService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
  );
  const controller = new V1ReposController(reposService, prisma);
  const restList = await restListRepos(controller);
  const restMaster = await restGetRepo(controller, REPO_ID);
  const restLegacy = await restGetRepo(controller, legacyRepoId);

  const tools = captureMcpTools({
    async listRepos(query) {
      return listRepoPage(prisma, query);
    },
    async getRepo(id: string) {
      return reposService.findById(id);
    },
  });
  const mcpList = parseMcpSuccess(
    await tools.get('list_repos')!({ limit: 10 }, ownerExtra(['repos:read'])),
  );
  const mcpMaster = parseMcpSuccess(
    await tools.get('get_repo')!({ id: REPO_ID }, ownerExtra(['repos:read'])),
  );
  const mcpLegacy = parseMcpSuccess(
    await tools.get('get_repo')!(
      { id: legacyRepoId },
      ownerExtra(['repos:read']),
    ),
  );

  const expectedRepos = repos.map((repo) =>
    canonicalJson(RepoResponseSchema.parse(repo)),
  );
  assert.deepEqual(
    canonicalJson(V1ListReposResponseSchema.parse(restList)),
    { items: expectedRepos, nextCursor: null },
  );
  assert.deepEqual(canonicalJson(RepoResponseSchema.parse(restMaster)), expectedRepos[0]);
  assert.deepEqual(canonicalJson(RepoResponseSchema.parse(restLegacy)), expectedRepos[1]);
  assert.deepEqual(mcpList.structured, { items: expectedRepos, nextCursor: null });
  assert.deepEqual(mcpList.text, mcpList.structured);
  assert.deepEqual(mcpMaster.structured, expectedRepos[0]);
  assert.deepEqual(mcpMaster.text, expectedRepos[0]);
  assert.deepEqual(mcpLegacy.structured, expectedRepos[1]);
  assert.deepEqual(mcpLegacy.text, expectedRepos[1]);
  assert.equal((expectedRepos[0] as { defaultBranch: string }).defaultBranch, 'master');
  assert.equal((expectedRepos[1] as { defaultBranch: null }).defaultBranch, null);
  assertNoSecretCanary(
    restList,
    restMaster,
    restLegacy,
    mcpList.structured,
    mcpList.text,
    mcpMaster.structured,
    mcpMaster.text,
    mcpLegacy.structured,
    mcpLegacy.text,
  );
});

test('the six affected operations deny insufficient scopes on REST and MCP before delegation', async () => {
  let dependencyCalls = 0;
  const deniedTask = async () => {
    dependencyCalls += 1;
    return unsafeTaskOutput('pending');
  };
  const deniedRepo = async () => {
    dependencyCalls += 1;
    return RepoResponseSchema.parse(repoRecord(REPO_ID, 'master'));
  };
  const taskController = new V1TasksController(
    {} as TasksService,
    {} as PrismaService,
    {} as IdempotencyService,
  );
  const repoController = new V1ReposController(
    {} as ReposService,
    {} as PrismaService,
  );
  const tools = captureMcpTools({
    createTask: deniedTask,
    listTasks: async () => {
      dependencyCalls += 1;
      return { items: [], nextCursor: null };
    },
    getTask: deniedTask,
    stopTask: deniedTask,
    listRepos: async () => {
      dependencyCalls += 1;
      return { items: [], nextCursor: null };
    },
    getRepo: deniedRepo,
  });
  const fixtures: ReadonlyArray<{
    readonly name: string;
    readonly handler: PublicV1Handler;
    readonly request: AuthenticatedRequest;
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly extra: ToolExtra;
  }> = [
    {
      name: 'tasks.create',
      handler: taskController.create,
      request: fixtureRequest(
        { repoId: REPO_ID, prompt: 'denied create' },
        principalWithScopes(['tasks:read']),
      ),
      tool: 'create_task',
      input: { repoId: REPO_ID, prompt: 'denied create' },
      extra: ownerExtra(['tasks:read']),
    },
    {
      name: 'tasks.list',
      handler: taskController.list,
      request: fixtureRequest(undefined, principalWithScopes([]), {}, { limit: '10' }),
      tool: 'list_tasks',
      input: { limit: 10 },
      extra: ownerExtra([]),
    },
    {
      name: 'tasks.get',
      handler: taskController.findById,
      request: fixtureRequest(undefined, principalWithScopes([]), { id: TASK_ID }),
      tool: 'get_task',
      input: { id: TASK_ID },
      extra: ownerExtra([]),
    },
    {
      name: 'tasks.stop',
      handler: taskController.stop,
      request: fixtureRequest(
        undefined,
        principalWithScopes(['tasks:read']),
        { id: TASK_ID },
      ),
      tool: 'stop_task',
      input: { id: TASK_ID },
      extra: ownerExtra(['tasks:read']),
    },
    {
      name: 'repos.list',
      handler: repoController.list,
      request: fixtureRequest(undefined, principalWithScopes([]), {}, { limit: '10' }),
      tool: 'list_repos',
      input: { limit: 10 },
      extra: ownerExtra([]),
    },
    {
      name: 'repos.get',
      handler: repoController.findById,
      request: fixtureRequest(undefined, principalWithScopes([]), { id: REPO_ID }),
      tool: 'get_repo',
      input: { id: REPO_ID },
      extra: ownerExtra([]),
    },
  ];

  for (const fixture of fixtures) {
    const restFailure = captureSyncFailure(() =>
      new PublicV1OperationGuard().canActivate(
        fixtureContext(fixture.handler, fixture.request),
      ),
    );
    assert.ok(restFailure instanceof HttpException, fixture.name);
    assert.equal(
      normalizePublicSurfaceFailure(restFailure).code,
      'insufficient_scope',
      fixture.name,
    );
    const mcpFailure = await tools.get(fixture.tool)!(
      fixture.input,
      fixture.extra,
    );
    assertMcpFailureCode(mcpFailure, 'insufficient_scope');
  }
  assert.equal(dependencyCalls, 0);
});

test('shared all-fields fixture reaches the same schedule use case and canonical output through REST and MCP', async () => {
  const calls: Array<{
    ownerUserId: string;
    body: CreateScheduleRequest;
  }> = [];
  const create: McpToolDeps['createSchedule'] = async (ownerUserId, body) => {
    calls.push({ ownerUserId, body });
    return SCHEDULE_OUTPUT;
  };
  const controller = new V1SchedulesController({ create } as ScheduledTasksService);
  const request = fixtureRequest(ALL_FIELDS_CREATE_INPUT);
  const context = seedRestBoundary(controller.create, request);
  const parsedBody = publicV1RequestContext(request)?.input
    .body as CreateScheduleRequest;
  const restOutput = await throughRestOutputBoundary(context, () =>
    controller.create(parsedBody, request),
  );

  const tools = captureMcpTools({ createSchedule: create });
  const mcpOutput = (await tools.get('create_schedule')!(
    ALL_FIELDS_CREATE_INPUT,
    ownerExtra(),
  )) as { structuredContent: unknown };

  assert.deepEqual(calls, [
    { ownerUserId: OWNER_ID, body: CANONICAL_CREATE_INPUT },
    { ownerUserId: OWNER_ID, body: CANONICAL_CREATE_INPUT },
  ]);
  assert.deepEqual(
    Object.keys(ALL_FIELDS_CREATE_INPUT.taskTemplate).sort(),
    ['repoId', ...Object.keys(CreateTaskRequestSchema.shape)].sort(),
    'the shared task template fixture covers every canonical task field',
  );
  assert.deepEqual(
    canonicalJson(ScheduleResponseSchema.parse(restOutput)),
    canonicalJson(ScheduleResponseSchema.parse(mcpOutput.structuredContent)),
  );
});

test('shared validation, scope, and owner fixtures reject both boundaries before the write use case', async () => {
  let createCalls = 0;
  const create: McpToolDeps['createSchedule'] = async () => {
    createCalls += 1;
    return SCHEDULE_OUTPUT;
  };
  const controller = new V1SchedulesController({ create } as ScheduledTasksService);
  const tools = captureMcpTools({ createSchedule: create });
  const ownerlessPrincipal: OperatorPrincipal = {
    kind: 'legacy-token',
    user: null,
  };
  const ownerlessExtra = ownerExtra();
  if (ownerlessExtra.authInfo?.extra) {
    delete (ownerlessExtra.authInfo.extra as { userId?: string }).userId;
  }

  const fixtures: ReadonlyArray<{
    name: string;
    code: PublicErrorCode;
    restRequest: AuthenticatedRequest;
    mcpInput: Record<string, unknown>;
    mcpExtra: ToolExtra;
  }> = [
    {
      name: 'scope',
      code: 'insufficient_scope',
      restRequest: fixtureRequest(ALL_FIELDS_CREATE_INPUT, {
        ...OWNER_PRINCIPAL,
        scopes: ['tasks:read'],
      }),
      mcpInput: ALL_FIELDS_CREATE_INPUT,
      mcpExtra: ownerExtra(['tasks:read']),
    },
    {
      name: 'validation',
      code: 'validation_failed',
      restRequest: fixtureRequest({
        ...ALL_FIELDS_CREATE_INPUT,
        taskTemplate: {
          ...ALL_FIELDS_CREATE_INPUT.taskTemplate,
          prompt: '',
        },
      }),
      mcpInput: {
        ...ALL_FIELDS_CREATE_INPUT,
        taskTemplate: {
          ...ALL_FIELDS_CREATE_INPUT.taskTemplate,
          prompt: '',
        },
      },
      mcpExtra: ownerExtra(),
    },
    {
      name: 'owner',
      code: 'owner_required',
      restRequest: fixtureRequest(
        ALL_FIELDS_CREATE_INPUT,
        ownerlessPrincipal,
      ),
      mcpInput: ALL_FIELDS_CREATE_INPUT,
      mcpExtra: ownerlessExtra,
    },
  ];

  for (const fixture of fixtures) {
    const restFailure = captureSyncFailure(() =>
      new PublicV1OperationGuard().canActivate(
        fixtureContext(controller.create, fixture.restRequest),
      ),
    );
    assert.ok(restFailure instanceof HttpException, fixture.name);
    const normalizedRest = normalizePublicSurfaceFailure(
      restFailure,
      fixture.code === 'owner_required'
        ? { code: 'owner_required' }
        : undefined,
    );
    assert.equal(normalizedRest.code, fixture.code, fixture.name);

    const mcpFailure = await tools.get('create_schedule')!(
      fixture.mcpInput,
      fixture.mcpExtra,
    );
    assertMcpFailureCode(mcpFailure, fixture.code);
    assert.equal(
      REST_PUBLIC_ERROR_MAP[fixture.code].retryable,
      MCP_PUBLIC_ERROR_MAP[fixture.code].retryable,
      fixture.name,
    );
  }

  assert.equal(createCalls, 0, 'no rejected write reached the shared use case');
});

test('the same public domain failure preserves canonical arguments and stable semantics across REST and MCP', async () => {
  const calls: Array<{
    ownerUserId: string;
    id: string;
    body: { expectedPeriodKey?: string };
  }> = [];
  const dispatch: McpToolDeps['dispatchSchedule'] = async (
    ownerUserId,
    id,
    body,
  ) => {
    calls.push({ ownerUserId, id, body });
    throw new PublicSurfaceError({
      code: 'conflict',
      message: 'The selected schedule period was already consumed.',
    });
  };
  const controller = new V1SchedulesController({
    dispatchNow: dispatch,
  } as ScheduledTasksService);
  const dispatchInput = { expectedPeriodKey: 'day:2026-07-14' };
  const request = fixtureRequest(dispatchInput, OWNER_PRINCIPAL, {
    id: SCHEDULE_ID,
  });
  const context = seedRestBoundary(controller.dispatch, request);
  const parsed = publicV1RequestContext(request)?.input;
  const restFailure = await captureAsyncFailure(() =>
    throughRestOutputBoundary(context, () =>
      controller.dispatch(
        (parsed?.params as { id: string }).id,
        parsed?.body as { expectedPeriodKey?: string },
        request,
      ),
    ),
  );
  assert.ok(restFailure instanceof HttpException);
  assert.equal(normalizePublicSurfaceFailure(restFailure).code, 'conflict');

  const tools = captureMcpTools({ dispatchSchedule: dispatch });
  const mcpFailure = await tools.get('dispatch_schedule')!(
    { id: SCHEDULE_ID, ...dispatchInput },
    ownerExtra(),
  );
  assertMcpFailureCode(mcpFailure, 'conflict');
  assert.deepEqual(calls, [
    { ownerUserId: OWNER_ID, id: SCHEDULE_ID, body: dispatchInput },
    { ownerUserId: OWNER_ID, id: SCHEDULE_ID, body: dispatchInput },
  ]);
  assert.equal(
    REST_PUBLIC_ERROR_MAP.conflict.retryable,
    MCP_PUBLIC_ERROR_MAP.conflict.retryable,
  );
});
