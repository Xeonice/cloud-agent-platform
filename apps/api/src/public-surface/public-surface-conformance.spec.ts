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
  ScheduleResponseSchema,
  type CreateScheduleRequest,
  type PublicErrorCode,
  type ScheduleResponse,
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
import { V1SchedulesController } from '../v1/v1-schedules.controller';
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
const OWNER_ID = 'owner-conformance';

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
): AuthenticatedRequest {
  return {
    operatorPrincipal: principal,
    params,
    query: {},
    headers: {},
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
