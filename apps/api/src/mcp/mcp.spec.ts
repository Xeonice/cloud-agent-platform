/**
 * Tests for the `/mcp` tools + the enable gate (remote-mcp-server, Track
 * `mcp-endpoint-tools`, task 4.4).
 *
 * Covers the four load-bearing requirements:
 *   1. SCOPE GATES — a `tasks:read`-only mcp principal is DENIED `create_task`
 *      and `stop_task` (an MCP error with 403-semantics) and performs NO state
 *      change; a `tasks:write` token passes; `repos:read`/`tasks:read` gate the
 *      read tools.
 *   2. ONE ADMISSION PATH — the tools dispatch to the SAME service surface the
 *      console uses (the {@link McpToolDeps} delegate), not a fork.
 *   3. IMMEDIATE HANDLE — `create_task` returns the task id + status WITHOUT
 *      waiting for the (here, never-resolving) run to finish.
 *   4. INERT WHEN OFF — with `mcpServerEnabled=false` the controller serves no MCP
 *      traffic (a disabled response) and connects NO transport/server, so no
 *      `mcp_` token drives a usable session there.
 *
 * Runs under `pnpm test` (nest build → node --test dist/**\/*.spec.js): no Nest DI
 * container, no DB. The tools are exercised by capturing the registered callbacks
 * via a fake `McpServer` and invoking them with a synthesized `extra.authInfo`
 * (the shape the SDK threads from `requireBearerAuth`); the gate is exercised by
 * driving `McpController` with a fake Prisma + a fake server factory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  MCP_ADAPTERS,
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
  type ToolRegistrar,
} from './mcp-tools';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.server';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';
import {
  CreateScheduleRequestSchema,
  CreateTaskRequestSchema,
  DispatchScheduleRequestSchema,
  PUBLIC_V1_OPERATIONS,
  PublicV1DeletionAcknowledgementSchema,
  RepoResponseSchema,
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogSchema,
  ScheduleRecurrenceSchema,
  ScheduleResponseSchema,
  ScheduleTaskTemplateCreateSchema,
  SessionHistorySchema,
  TaskResponseSchema,
  UpdateScheduleRequestSchema,
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ScheduleListQuerySchema,
  V1ListTasksResponseSchema,
  V1ListReposResponseSchema,
  type CreateTaskBody,
  type CreateScheduleRequest,
  type McpMappedOperation,
  type McpMappedOperationId,
  type PublicErrorCode,
  type RepoResponse,
  type ScheduleResponse,
  type ScheduleRunResponse,
  type SessionHistory,
  type TaskResponse,
  type UpdateScheduleRequest,
} from '@cap/contracts';
import { MCP_PUBLIC_ERROR_MAP } from '../public-surface/public-error-mappings';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { TaskBranchResolver } from '../forge/task-branch-resolver';
import { ReposService } from '../repos/repos.service';
import {
  TasksService,
  type TaskAcceptanceClient,
} from '../tasks/tasks.service';
import type {
  TaskAdmissionGatePort,
  TaskAdmissionWakePort,
} from '../tasks/task-admission-gate';

// ---------------------------------------------------------------------------
// Fakes: a server that captures (name -> callback), and recording deps.
// ---------------------------------------------------------------------------

type ToolCb = (args: Record<string, unknown>, extra: ToolExtra) => Promise<unknown>;
type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
};

const PUBLIC_ERROR_META_KEY = 'com.cloud-agent-platform/public-error';

function publicErrorEnvelope(result: unknown): {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
} {
  assert.ok(result && typeof result === 'object');
  const toolResult = result as {
    isError?: unknown;
    _meta?: Record<string, unknown>;
  };
  assert.equal(toolResult.isError, true);
  const envelope = toolResult._meta?.[PUBLIC_ERROR_META_KEY];
  assert.ok(envelope && typeof envelope === 'object');
  return envelope as {
    code: PublicErrorCode;
    message: string;
    retryable: boolean;
  };
}

function toolErrorText(result: unknown): string {
  assert.ok(result && typeof result === 'object');
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = (content[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') {
    throw new TypeError('expected MCP text error content');
  }
  return text;
}

async function expectPublicToolError(
  run: () => Promise<unknown>,
  code: PublicErrorCode,
  messagePattern?: RegExp,
): Promise<unknown> {
  const result = await run();
  const envelope = publicErrorEnvelope(result);
  assert.equal(envelope.code, code);
  if (messagePattern) assert.match(envelope.message, messagePattern);
  return result;
}

/**
 * A minimal stand-in for `McpServer.registerTool(name, config, cb)` that captures
 * each tool's callback so a test can invoke it directly with a synthesized
 * `extra`. Tools with an empty `inputSchema` register a `(extra) => ...` callback;
 * tools with args register `(args, extra) => ...`. We normalize both to
 * `(args, extra)` by detecting arity.
 */
function captureServer(): {
  server: { registerTool: (...a: unknown[]) => void };
  tools: Map<string, ToolCb>;
  configs: Map<string, ToolConfig>;
} {
  const tools = new Map<string, ToolCb>();
  const configs = new Map<string, ToolConfig>();
  const server = {
    registerTool(name: unknown, config: unknown, cb: unknown) {
      const fn = cb as (...a: unknown[]) => Promise<unknown>;
      // A zero-arg tool's callback is `(extra)`; an arg tool's is `(args, extra)`.
      const wrapped: ToolCb =
        fn.length <= 1
          ? (_args, extra) => fn(extra)
          : (args, extra) => fn(args, extra);
      tools.set(name as string, wrapped);
      configs.set(name as string, config as ToolConfig);
    },
  };
  return { server, tools, configs };
}

function advertisedInputShape(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') return {};
  const schema = inputSchema as { shape?: unknown };
  return schema.shape && typeof schema.shape === 'object'
    ? (schema.shape as Record<string, unknown>)
    : (inputSchema as Record<string, unknown>);
}

function advertisedObjectShape(inputSchema: unknown): Record<string, unknown> {
  let current = inputSchema as
    | { unwrap?: () => unknown; shape?: unknown }
    | undefined;
  while (current && typeof current.unwrap === 'function') {
    current = current.unwrap() as { unwrap?: () => unknown; shape?: unknown };
  }
  return advertisedInputShape(current);
}

const TASK: TaskResponse = {
  id: '00000000-0000-4000-a000-000000000001',
  repoId: '00000000-0000-4000-b000-0000000000ff',
  prompt: 'hello',
  status: 'pending',
  createdAt: new Date(),
  branch: null,
  strategy: null,
  skills: [],
  idleTimeoutMs: null,
  deadlineMs: null,
  runtime: 'codex',
} as TaskResponse;

const REPO: RepoResponse = {
  id: '00000000-0000-4000-b000-0000000000ff',
  name: 'demo',
  gitSource: 'https://github.com/example/demo',
  createdAt: new Date('2026-07-10T00:00:00.000Z'),
};

const TRANSCRIPT: SessionHistory = {
  status: 'available',
  turns: [],
  meta: { taskId: TASK.id },
  isInterrupted: false,
};

const SCHEDULE_ID = '00000000-0000-4000-a000-000000000002';
const SCHEDULE_RUN_ID = '00000000-0000-4000-a000-000000000003';

const SCHEDULE: ScheduleResponse = {
  id: SCHEDULE_ID,
  ownerUserId: 'local-acct-1',
  repoId: TASK.repoId,
  name: 'daily check',
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
    repoId: TASK.repoId,
    prompt: 'daily check',
    runtime: 'codex',
    sandboxEnvironmentId: null,
    deliver: 'none',
  },
  latestRun: null,
  createdAt: new Date('2026-07-10T00:00:00.000Z'),
  updatedAt: new Date('2026-07-10T00:00:00.000Z'),
};

const SCHEDULE_RUN: ScheduleRunResponse = {
  id: SCHEDULE_RUN_ID,
  scheduleId: SCHEDULE_ID,
  scheduledFor: new Date('2026-07-10T09:00:00.000Z'),
  status: 'created',
  taskId: TASK.id,
  taskStatus: TASK.status,
  error: null,
  createdAt: new Date('2026-07-10T09:00:00.000Z'),
  updatedAt: new Date('2026-07-10T09:00:01.000Z'),
};

type McpToolDepMethod = keyof McpToolDeps;
type McpToolDepCall = {
  [Method in McpToolDepMethod]: {
    readonly method: Method;
    readonly args: Readonly<Parameters<McpToolDeps[Method]>>;
  };
}[McpToolDepMethod];

interface McpAdapterConformanceFixture {
  readonly rawInput: Readonly<Record<string, unknown>>;
  readonly expectedCall: McpToolDepCall;
}

const ADAPTER_OWNER_ID = 'adapter-conformance-owner';
const ADAPTER_CURSOR = 'adapter-conformance-cursor';

const CREATE_TASK_ADAPTER_INPUT = {
  repoId: TASK.repoId,
  prompt: 'exercise every task adapter field',
  branch: 'feature/adapter-conformance',
  strategy: 'preserve canonical arguments',
  skills: ['openspec'],
  deadlineMs: 3_600_000,
  idleTimeoutMs: 900_000,
  runtime: 'codex',
  model: '  provider/model:adapter-preview  ',
  sandboxEnvironmentId: null,
  deliver: 'pr',
} as const;
const {
  repoId: CREATE_TASK_ADAPTER_REPO_ID,
  ...CREATE_TASK_ADAPTER_BODY
} = V1CreateTaskRequestSchema.parse(CREATE_TASK_ADAPTER_INPUT);

const CREATE_SCHEDULE_ADAPTER_INPUT = {
  name: '  adapter schedule  ',
  recurrence: {
    kind: 'hourly',
    minuteOfHour: 17,
    timezone: 'Asia/Shanghai',
  },
  taskTemplate: CREATE_TASK_ADAPTER_INPUT,
  enabled: false,
} as const;

const UPDATE_SCHEDULE_ADAPTER_BODY_INPUT = {
  name: '  renamed by adapter  ',
  recurrence: {
    kind: 'minuteInterval',
    intervalMinutes: 15,
    timezone: 'UTC',
  },
  taskTemplate: CREATE_TASK_ADAPTER_INPUT,
  enabled: true,
  overlapPolicy: 'enqueue',
  misfirePolicy: 'fire-once',
} as const;

/**
 * Behavior fixtures are deliberately exhaustive over the registry's mapped-id
 * union. A newly mapped operation cannot compile without a fixture, and the
 * runtime key comparison below also fails closed if generated/stale JS evades
 * that type check. Expected arguments come from the canonical parsers rather
 * than a copied transport DTO, so this test checks adapter delegation and the
 * exact normalized values delivered to the shared use-case port.
 */
const MCP_ADAPTER_CONFORMANCE_FIXTURES = {
  'tasks.create': {
    rawInput: CREATE_TASK_ADAPTER_INPUT,
    expectedCall: {
      method: 'createTask',
      args: [
        CREATE_TASK_ADAPTER_REPO_ID,
        CREATE_TASK_ADAPTER_BODY,
        ADAPTER_OWNER_ID,
      ],
    },
  },
  'runtimeModels.query': {
    rawInput: { runtime: 'codex', sandboxEnvironmentId: null },
    expectedCall: {
      method: 'queryRuntimeModels',
      args: [
        ADAPTER_OWNER_ID,
        RuntimeModelCatalogQuerySchema.parse({
          runtime: 'codex',
          sandboxEnvironmentId: null,
        }),
      ],
    },
  },
  'tasks.list': {
    rawInput: { limit: '17', cursor: ADAPTER_CURSOR },
    expectedCall: {
      method: 'listTasks',
      args: [V1ListQuerySchema.parse({ limit: '17', cursor: ADAPTER_CURSOR })],
    },
  },
  'tasks.get': {
    rawInput: { id: TASK.id },
    expectedCall: { method: 'getTask', args: [TASK.id] },
  },
  'tasks.stop': {
    rawInput: { id: TASK.id },
    expectedCall: {
      method: 'stopTask',
      args: [TASK.id, ADAPTER_OWNER_ID],
    },
  },
  'tasks.transcript': {
    rawInput: { id: TASK.id },
    expectedCall: { method: 'getTranscript', args: [TASK.id] },
  },
  'repos.list': {
    rawInput: { limit: '23', cursor: ADAPTER_CURSOR },
    expectedCall: {
      method: 'listRepos',
      args: [V1ListQuerySchema.parse({ limit: '23', cursor: ADAPTER_CURSOR })],
    },
  },
  'repos.get': {
    rawInput: { id: REPO.id },
    expectedCall: { method: 'getRepo', args: [REPO.id] },
  },
  'schedules.list': {
    rawInput: { limit: '19', cursor: ADAPTER_CURSOR },
    expectedCall: {
      method: 'listSchedules',
      args: [
        ADAPTER_OWNER_ID,
        V1ScheduleListQuerySchema.parse({
          limit: '19',
          cursor: ADAPTER_CURSOR,
        }),
      ],
    },
  },
  'schedules.create': {
    rawInput: CREATE_SCHEDULE_ADAPTER_INPUT,
    expectedCall: {
      method: 'createSchedule',
      args: [
        ADAPTER_OWNER_ID,
        CreateScheduleRequestSchema.parse(CREATE_SCHEDULE_ADAPTER_INPUT),
      ],
    },
  },
  'schedules.get': {
    rawInput: { id: SCHEDULE_ID },
    expectedCall: {
      method: 'getSchedule',
      args: [ADAPTER_OWNER_ID, SCHEDULE_ID],
    },
  },
  'schedules.update': {
    rawInput: { id: SCHEDULE_ID, ...UPDATE_SCHEDULE_ADAPTER_BODY_INPUT },
    expectedCall: {
      method: 'updateSchedule',
      args: [
        ADAPTER_OWNER_ID,
        SCHEDULE_ID,
        UpdateScheduleRequestSchema.parse(UPDATE_SCHEDULE_ADAPTER_BODY_INPUT),
      ],
    },
  },
  'schedules.pause': {
    rawInput: { id: SCHEDULE_ID },
    expectedCall: {
      method: 'pauseSchedule',
      args: [ADAPTER_OWNER_ID, SCHEDULE_ID],
    },
  },
  'schedules.resume': {
    rawInput: { id: SCHEDULE_ID },
    expectedCall: {
      method: 'resumeSchedule',
      args: [ADAPTER_OWNER_ID, SCHEDULE_ID],
    },
  },
  'schedules.dispatch': {
    rawInput: {
      id: SCHEDULE_ID,
      expectedPeriodKey: 'day:2026-07-14',
    },
    expectedCall: {
      method: 'dispatchSchedule',
      args: [
        ADAPTER_OWNER_ID,
        SCHEDULE_ID,
        DispatchScheduleRequestSchema.parse({
          expectedPeriodKey: 'day:2026-07-14',
        }),
      ],
    },
  },
  'schedules.delete': {
    rawInput: { id: SCHEDULE_ID },
    expectedCall: {
      method: 'deleteSchedule',
      args: [ADAPTER_OWNER_ID, SCHEDULE_ID],
    },
  },
  'schedules.runs': {
    rawInput: {
      id: SCHEDULE_ID,
      limit: '29',
      cursor: ADAPTER_CURSOR,
    },
    expectedCall: {
      method: 'listScheduleRuns',
      args: [
        ADAPTER_OWNER_ID,
        SCHEDULE_ID,
        V1ScheduleListQuerySchema.parse({
          limit: '29',
          cursor: ADAPTER_CURSOR,
        }),
      ],
    },
  },
} as const satisfies Record<
  McpMappedOperationId,
  McpAdapterConformanceFixture
>;

function recordExactDepCalls(delegate: McpToolDeps): {
  readonly deps: McpToolDeps;
  readonly calls: McpToolDepCall[];
} {
  const calls: McpToolDepCall[] = [];
  const deps = new Proxy(delegate, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        calls.push({ method: property, args } as unknown as McpToolDepCall);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { deps, calls };
}

/** Recording deps so a test can assert exactly which service method ran. */
function recordingDeps(): { deps: McpToolDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: McpToolDeps = {
    async createTask(repoId, body, userId) {
      calls.push(`createTask:${repoId}:${body.prompt}:${userId ?? '-'}`);
      return TASK;
    },
    async queryRuntimeModels(ownerUserId, query) {
      calls.push(`queryRuntimeModels:${ownerUserId}:${query.runtime}`);
      return {
        runtime: query.runtime,
        effectiveEnvironment: {
          kind: 'deployment-default',
          id: null,
          name: 'Deployment default',
          provider: 'test-provider',
          fingerprint: 'test-fingerprint',
        },
        cliVersion: 'test-cli',
        source:
          query.runtime === 'codex'
            ? 'codex-app-server'
            : 'versioned-cli-capabilities',
        completeness: query.runtime === 'codex' ? 'complete' : 'supported-subset',
        revision: 'sha256:test-revision',
        defaultModel: null,
        models: [],
      };
    },
    async getTask(id) {
      calls.push(`getTask:${id}`);
      return TASK;
    },
    async listTasks(query) {
      calls.push(`listTasks:${query.limit}:${query.cursor ?? '-'}`);
      return { items: [TASK], nextCursor: null };
    },
    async stopTask(id, userId) {
      calls.push(`stopTask:${id}:${userId ?? '-'}`);
      return TASK;
    },
    async getTranscript(id) {
      calls.push(`getTranscript:${id}`);
      return TRANSCRIPT;
    },
    async listRepos(query) {
      calls.push(`listRepos:${query.limit}:${query.cursor ?? '-'}`);
      return { items: [REPO], nextCursor: null };
    },
    async getRepo(id) {
      calls.push(`getRepo:${id}`);
      return REPO;
    },
    async createSchedule(ownerUserId, body) {
      calls.push(
        `createSchedule:${ownerUserId}:${body.taskTemplate.repoId}:${body.taskTemplate.prompt}`,
      );
      return SCHEDULE;
    },
    async listSchedules(ownerUserId, query) {
      calls.push(
        `listSchedules:${ownerUserId}:${query.limit}:${query.cursor ?? '-'}`,
      );
      return { items: [SCHEDULE], nextCursor: null };
    },
    async getSchedule(ownerUserId, id) {
      calls.push(`getSchedule:${ownerUserId}:${id}`);
      return SCHEDULE;
    },
    async updateSchedule(ownerUserId, id, body) {
      calls.push(`updateSchedule:${ownerUserId}:${id}:${body.name ?? '-'}`);
      return SCHEDULE;
    },
    async pauseSchedule(ownerUserId, id) {
      calls.push(`pauseSchedule:${ownerUserId}:${id}`);
      return { ...SCHEDULE, enabled: false, nextRunAt: null };
    },
    async resumeSchedule(ownerUserId, id) {
      calls.push(`resumeSchedule:${ownerUserId}:${id}`);
      return SCHEDULE;
    },
    async dispatchSchedule(ownerUserId, id, body) {
      calls.push(
        `dispatchSchedule:${ownerUserId}:${id}:${body.expectedPeriodKey ?? '-'}`,
      );
      return SCHEDULE;
    },
    async deleteSchedule(ownerUserId, id) {
      calls.push(`deleteSchedule:${ownerUserId}:${id}`);
    },
    async listScheduleRuns(ownerUserId, id, query) {
      calls.push(
        `listScheduleRuns:${ownerUserId}:${id}:${query.limit}:${query.cursor ?? '-'}`,
      );
      return { items: [SCHEDULE_RUN], nextCursor: null };
    },
  };
  return { deps, calls };
}

const extraWith = (scopes: string[]): ToolExtra => ({
  authInfo: {
    token: 'mcp_xxx',
    clientId: 'settings',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  },
});

const extraWithOwner = (scopes: string[], userId = 'local-acct-1'): ToolExtra => ({
  authInfo: {
    token: 'mcp_owner',
    clientId: 'settings',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { userId },
  },
});

// ---------------------------------------------------------------------------
// 1. Scope gates (task 4.4) — a tasks:read-only principal is denied writes.
// ---------------------------------------------------------------------------

test('a tasks:read-only mcp principal is DENIED create_task and stop_task', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const readOnly = extraWith(['tasks:read', 'repos:read']);

  await expectPublicToolError(
    () => tools.get('create_task')!({ repoId: TASK.repoId, prompt: 'go' }, readOnly),
    'insufficient_scope',
    /tasks:write required \(403\)/,
  );

  await expectPublicToolError(
    () => tools.get('stop_task')!({ id: 't1' }, readOnly),
    'insufficient_scope',
  );

  assert.equal(
    calls.length,
    0,
    'no service method ran — the scope gate rejects BEFORE acting (no state change)',
  );
});

test('a tasks:write token passes create_task and stop_task', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const writer = extraWith(['tasks:read', 'tasks:write']);
  await tools.get('create_task')!({ repoId: TASK.repoId, prompt: 'go' }, writer);
  await tools.get('stop_task')!({ id: TASK.id }, writer);

  assert.deepEqual(calls, [
    `createTask:${TASK.repoId}:go:-`,
    `stopTask:${TASK.id}:-`,
  ]);
});

test('runtime-model inventory requires write scope and an authenticated token owner', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const inventory = tools.get('list_runtime_models')!;

  await expectPublicToolError(
    () => inventory({ runtime: 'codex' }, extraWith(['tasks:read'])),
    'insufficient_scope',
  );
  await expectPublicToolError(
    () => inventory({ runtime: 'codex' }, extraWith(['tasks:write'])),
    'owner_required',
  );
  assert.deepEqual(calls, []);
});

test('runtime-model inventory preserves null and UUID environment intent with the token owner', async () => {
  const { deps, calls } = recordingDeps();
  const seen: unknown[] = [];
  const original = deps.queryRuntimeModels;
  deps.queryRuntimeModels = async (ownerUserId, query) => {
    seen.push({ ownerUserId, query });
    return original(ownerUserId, query);
  };
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const inventory = tools.get('list_runtime_models')!;
  const owner = extraWithOwner(['tasks:write'], 'owner-models');

  await inventory(
    { runtime: 'codex', sandboxEnvironmentId: null },
    owner,
  );
  await inventory(
    {
      runtime: 'claude-code',
      sandboxEnvironmentId: '00000000-0000-4000-a000-000000000321',
    },
    owner,
  );

  assert.deepEqual(seen, [
    {
      ownerUserId: 'owner-models',
      query: { runtime: 'codex', sandboxEnvironmentId: null },
    },
    {
      ownerUserId: 'owner-models',
      query: {
        runtime: 'claude-code',
        sandboxEnvironmentId: '00000000-0000-4000-a000-000000000321',
      },
    },
  ]);
  assert.equal(
    calls.filter((call) => call.startsWith('queryRuntimeModels:')).length,
    2,
  );
});

test('MCP boundary failures use stable codes, stay safe, and reject writes before delegation', async () => {
  const base = recordingDeps();
  let createCalls = 0;
  const deps: McpToolDeps = {
    ...base.deps,
    async createTask(repoId, body, userId) {
      createCalls += 1;
      return base.deps.createTask(repoId, body, userId);
    },
    async getTask() {
      throw new NotFoundException('Task not found');
    },
  };
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const scopeResult = await tools.get('create_task')!(
    { repoId: TASK.repoId, prompt: 'denied' },
    extraWith(['tasks:read']),
  );
  const scope = publicErrorEnvelope(scopeResult);
  assert.deepEqual(scope, {
    code: 'insufficient_scope',
    message: 'Insufficient scope: tasks:write required (403)',
    retryable: false,
  });
  assert.match(
    toolErrorText(scopeResult),
    new RegExp(String(MCP_PUBLIC_ERROR_MAP.insufficient_scope.jsonRpcCode)),
  );
  assert.equal(createCalls, 0);

  const validationResult = await tools.get('create_task')!(
    { repoId: 'not-a-uuid', prompt: 'invalid' },
    extraWith(['tasks:write']),
  );
  const validation = publicErrorEnvelope(validationResult);
  assert.equal(validation.code, 'validation_failed');
  assert.equal(validation.retryable, false);
  assert.match(validation.message, /uuid/iu);
  assert.match(toolErrorText(validationResult), /uuid/iu);
  assert.equal(createCalls, 0);

  const ownerResult = await tools.get('create_schedule')!(
    {
      recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      taskTemplate: { repoId: TASK.repoId, prompt: 'owner required' },
    },
    extraWith(['tasks:write']),
  );
  assert.deepEqual(publicErrorEnvelope(ownerResult), {
    code: 'owner_required',
    message: 'Schedule tools require an authenticated account owner (403)',
    retryable: false,
  });
  assert.equal(
    base.calls.some((call) => call.startsWith('createSchedule:')),
    false,
  );

  const notFoundResult = await tools.get('get_task')!(
    { id: TASK.id },
    extraWith(['tasks:read']),
  );
  assert.deepEqual(publicErrorEnvelope(notFoundResult), {
    code: 'not_found',
    message: 'Task not found',
    retryable: false,
  });
  assert.equal(toolErrorText(notFoundResult), 'Task not found');

  deps.createTask = async () => {
    throw new ServiceUnavailableException({
      reason: 'runtime not configured',
      runtime: 'claude-code',
      message: 'runtime "claude-code" is not configured',
    });
  };
  const unavailableResult = await tools.get('create_task')!(
    { repoId: TASK.repoId, prompt: 'runtime readiness' },
    extraWith(['tasks:write']),
  );
  assert.deepEqual(publicErrorEnvelope(unavailableResult), {
    code: 'temporarily_unavailable',
    message: 'runtime "claude-code" is not configured',
    retryable: true,
  });
  assert.equal(
    toolErrorText(unavailableResult),
    'runtime "claude-code" is not configured',
  );

  deps.getTask = async () => {
    throw new Error('Authorization: Bearer super-secret-provider-token');
  };
  await assert.rejects(
    () =>
      tools.get('get_task')!({ id: TASK.id }, extraWith(['tasks:read'])),
    (unsafe: unknown) => {
      assert.ok(unsafe instanceof McpError);
      assert.equal(unsafe.code, ErrorCode.InternalError);
      assert.doesNotMatch(unsafe.message, /secret|bearer|provider-token/iu);
      assert.equal(unsafe.data, undefined);
      return true;
    },
  );
});

test('create_task/stop_task thread the token owner ACCOUNT id (local account attribution)', async () => {
  // fix-local-account-task-attribution: the MCP attribution extractor resolves the
  // token owner's account primary key (`extra.authInfo.extra.userId`, set for BOTH
  // local and GitHub accounts) and threads it into the service, so a local-account
  // token's task is owner-attributed and its stored Codex credential resolves.
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  // Mirror mcp.server.ts#userIdFromExtra: read the account id from authInfo.extra.
  const userIdOf = (extra: ToolExtra): string | undefined => {
    const raw = (extra.authInfo?.extra as { userId?: unknown } | undefined)?.userId;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  };
  registerMcpTools(server as never, deps, userIdOf);

  const localOwner: ToolExtra = {
    authInfo: {
      token: 'mcp_local',
      clientId: 'settings',
      scopes: ['tasks:read', 'tasks:write'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // A LOCAL account's MCP token: numeric githubId is null, account id is set.
      extra: { userId: 'local-acct-1', githubId: null },
    },
  } as unknown as ToolExtra;

  await tools.get('create_task')!(
    { repoId: TASK.repoId, prompt: 'go' },
    localOwner,
  );
  await tools.get('stop_task')!({ id: TASK.id }, localOwner);

  assert.deepEqual(
    calls,
    [
      `createTask:${TASK.repoId}:go:local-acct-1`,
      `stopTask:${TASK.id}:local-acct-1`,
    ],
    'the local account id is threaded into create/stop (not collapsed to undefined)',
  );
});

test('the read tools gate on their read scopes', async () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  // tasks:read gates task reads; repos:read gates both repo reads.
  const noScopes = extraWith([]);
  for (const name of [
    'get_task',
    'list_tasks',
    'get_transcript',
    'list_repos',
    'get_repo',
  ]) {
    await expectPublicToolError(
      () => tools.get(name)!({ id: 'x' }, noScopes),
      'insufficient_scope',
    );
  }

  // list_repos specifically needs repos:read (tasks:read alone is insufficient).
  await expectPublicToolError(
    () => tools.get('list_repos')!({}, extraWith(['tasks:read'])),
    'insufficient_scope',
  );
});

test('the MCP server registers the complete task, repo, and schedule tool surface', () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  assert.deepEqual(
    [...tools.keys()],
    PUBLIC_V1_OPERATIONS.flatMap((operation) =>
      'tool' in operation.mcp ? [operation.mcp.tool] : [],
    ),
  );
});

test('the MCP tool inventory stays in parity with the canonical public /v1 manifest', () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const manifestTools = PUBLIC_V1_OPERATIONS.flatMap((operation) =>
    'tool' in operation.mcp ? [operation.mcp.tool] : [],
  ).sort();
  assert.deepEqual([...tools.keys()].sort(), manifestTools);
  assert.deepEqual(
    Object.keys(MCP_ADAPTERS).sort(),
    PUBLIC_V1_OPERATIONS.flatMap((operation) =>
      'tool' in operation.mcp ? [operation.id] : [],
    ).sort(),
  );
  assert.deepEqual(
    PUBLIC_V1_OPERATIONS.filter((operation) => 'excluded' in operation.mcp).map(
      (operation) => operation.id,
    ),
    ['tasks.events'],
    'SSE is the only explicit MCP transport exclusion',
  );
});

function isMcpMappedOperation(
  operation: (typeof PUBLIC_V1_OPERATIONS)[number],
): operation is McpMappedOperation {
  return 'tool' in operation.mcp;
}

test('every mapped MCP adapter delegates once to its declared use-case method with canonical arguments', async (t) => {
  const operations = PUBLIC_V1_OPERATIONS.filter(isMcpMappedOperation);
  assert.deepEqual(
    Object.keys(MCP_ADAPTER_CONFORMANCE_FIXTURES).sort(),
    operations.map((operation) => operation.id).sort(),
    'every mapped operation has exactly one behavior conformance fixture',
  );

  for (const operation of operations) {
    await t.test(operation.id, async () => {
      const fixture = MCP_ADAPTER_CONFORMANCE_FIXTURES[operation.id];
      const recorded = recordExactDepCalls(recordingDeps().deps);
      const { server, tools } = captureServer();
      registerMcpTools(server as never, recorded.deps);

      const result = (await tools.get(operation.mcp.tool)!(
        fixture.rawInput,
        extraWithOwner(
          ['tasks:read', 'tasks:write', 'repos:read'],
          ADAPTER_OWNER_ID,
        ),
      )) as {
        readonly isError?: boolean;
        readonly structuredContent?: unknown;
      };

      assert.notEqual(result.isError, true, `${operation.id} returned an error`);
      assert.notEqual(
        result.structuredContent,
        undefined,
        `${operation.id} returned no structured content`,
      );
      assert.deepEqual(
        recorded.calls,
        [fixture.expectedCall],
        `${operation.id} must delegate once with its canonical arguments`,
      );
    });
  }
});

function projectedInputFields(operation: McpMappedOperation): string[] {
  return operation.mcp.inputProjection.sources.flatMap((source) => {
    const pair =
      source === 'params' && 'params' in operation.input
        ? operation.input.params
        : source === 'query' && 'query' in operation.input
          ? operation.input.query
          : source === 'body' && 'body' in operation.input
            ? operation.input.body
            : undefined;
    assert.ok(pair, `${operation.id} has its declared ${source} wire pair`);
    return Object.keys(pair.wire.shape);
  });
}

function registryOutputSchema(
  operation: McpMappedOperation,
): z.ZodTypeAny {
  const projection = operation.mcp.outputProjection;
  if (projection !== 'canonical') return projection.schema;
  assert.ok(
    operation.responseSchema,
    `${operation.id} has a canonical MCP response schema`,
  );
  return operation.responseSchema;
}

function assertRelaxedObjectUnionOutputSchema(
  operation: McpMappedOperation,
  advertised: unknown,
): void {
  const canonical = registryOutputSchema(operation) as z.ZodTypeAny & {
    options?: readonly z.AnyZodObject[];
  };
  assert.ok(
    Array.isArray(canonical.options) && canonical.options.length > 0,
    `${operation.id} relaxation is backed by a canonical object union`,
  );
  assert.ok(
    advertised instanceof z.ZodObject,
    `${operation.id} advertises the SDK-required root object`,
  );

  const options = canonical.options;
  const expectedFields = [
    ...new Set(options.flatMap((option) => Object.keys(option.shape))),
  ].sort();
  const advertisedShape = advertised.shape;
  assert.deepEqual(
    Object.keys(advertisedShape).sort(),
    expectedFields,
    `${operation.id} derives every relaxed output field from its canonical union`,
  );

  for (const fieldName of expectedFields) {
    const variants = options.flatMap((option) => {
      const field = option.shape[fieldName] as z.ZodTypeAny | undefined;
      return field ? [field] : [];
    });
    const uniqueVariants = [...new Set(variants)];
    const isConditionallyPresent = variants.length !== options.length;
    const advertisedField = advertisedShape[fieldName] as z.ZodTypeAny;
    assert.ok(
      advertisedField,
      `${operation.id} advertises canonical union field ${fieldName}`,
    );
    const optionalField = advertisedField as z.ZodTypeAny & {
      _def?: { typeName?: unknown };
      unwrap?: () => z.ZodTypeAny;
    };
    const isAdvertisedOptional =
      optionalField._def?.typeName === 'ZodOptional';
    if (isConditionallyPresent) {
      assert.ok(
        isAdvertisedOptional,
        `${operation.id}.${fieldName} is optional only because a canonical variant omits it`,
      );
    } else {
      assert.equal(
        isAdvertisedOptional,
        false,
        `${operation.id}.${fieldName} remains required across every canonical variant`,
      );
    }
    const advertisedBase =
      isAdvertisedOptional && typeof optionalField.unwrap === 'function'
        ? optionalField.unwrap()
        : advertisedField;
    if (uniqueVariants.length === 1) {
      assert.equal(
        advertisedBase,
        uniqueVariants[0],
        `${operation.id}.${fieldName} reuses its canonical field schema`,
      );
      continue;
    }
    const advertisedUnion = advertisedBase as z.ZodTypeAny & {
      _def?: { typeName?: unknown };
      options?: readonly z.ZodTypeAny[];
    };
    assert.equal(
      advertisedUnion._def?.typeName,
      'ZodUnion',
      `${operation.id}.${fieldName} advertises the exact canonical field variants`,
    );
    assert.deepEqual(
      advertisedUnion.options,
      uniqueVariants,
      `${operation.id}.${fieldName} contains no invented field variant`,
    );
  }
}

function assertRegistryDrivenMcpOutputSchema(
  operation: McpMappedOperation,
  advertised: unknown,
): void {
  const relaxations = operation.mcp.differences.filter(
    (difference) => difference.kind === 'mcp-output-schema-relaxation',
  );
  if (relaxations.length === 0) {
    if (advertised !== registryOutputSchema(operation)) {
      throw new Error(
        `${operation.id} does not advertise its exact registry output schema`,
      );
    }
    return;
  }
  assert.equal(
    relaxations.length,
    1,
    `${operation.id} has exactly one output schema relaxation decision`,
  );
  assertRelaxedObjectUnionOutputSchema(operation, advertised);
}

function assertRegistryDrivenMcpMetadata(
  configs: ReadonlyMap<string, ToolConfig>,
): void {
  for (const operation of PUBLIC_V1_OPERATIONS) {
    if (!isMcpMappedOperation(operation)) continue;
    const config = configs.get(operation.mcp.tool);
    assert.ok(config, `${operation.id} is registered by its registry tool name`);
    assert.equal(config.title, operation.summary);
    const description =
      'description' in operation.mcp &&
      typeof operation.mcp.description === 'string'
        ? operation.mcp.description
        : operation.description;
    assert.equal(
      config.description,
      `${description} Requires the ${operation.scope} scope.`,
    );
    assert.deepEqual(config.annotations, {
      readOnlyHint: !operation.destructive,
      destructiveHint: operation.destructive,
      openWorldHint: false,
    });

    const projectedFields = projectedInputFields(operation);
    assert.deepEqual(
      Object.keys(advertisedInputShape(config.inputSchema)).sort(),
      projectedFields.sort(),
      `${operation.id} advertises the registry-owned wire fields`,
    );
    assertRegistryDrivenMcpOutputSchema(operation, config.outputSchema);
  }
}

test('registry metadata drives every MCP name, schema, description, policy annotation, and output', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  assertRegistryDrivenMcpMetadata(configs);
});

test('the MCP parity assertion rejects a projected schema field stripping mutation', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  const operation = PUBLIC_V1_OPERATIONS.filter(isMcpMappedOperation).find(
    (entry) => projectedInputFields(entry).length > 0,
  );
  assert.ok(operation, 'the registry contains a mapped operation with input');
  const config = configs.get(operation.mcp.tool);
  assert.ok(config, `${operation.id} has captured MCP metadata`);
  const advertisedShape = advertisedInputShape(config.inputSchema);
  const fieldToStrip = projectedInputFields(operation)[0];
  assert.ok(fieldToStrip, `${operation.id} has a projected field to mutate`);
  const strippedShape = { ...advertisedShape };
  delete strippedShape[fieldToStrip];

  const mutated = new Map(configs);
  mutated.set(operation.mcp.tool, {
    ...config,
    inputSchema: { shape: strippedShape },
  });
  assert.throws(
    () => assertRegistryDrivenMcpMetadata(mutated),
    new RegExp(`${operation.id} advertises the registry-owned wire fields`, 'u'),
  );
});

test('every mapped MCP output schema rejects removal and addition mutations in both directions', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  for (const operation of PUBLIC_V1_OPERATIONS.filter(isMcpMappedOperation)) {
    const config = configs.get(operation.mcp.tool);
    assert.ok(config?.outputSchema, `${operation.id} has captured output metadata`);
    const advertisedShape = advertisedInputShape(config.outputSchema);
    const fieldToRemove = Object.keys(advertisedShape)[0];
    assert.ok(fieldToRemove, `${operation.id} has an output field to mutate`);

    const removedShape = { ...advertisedShape };
    delete removedShape[fieldToRemove];
    assert.throws(
      () =>
        assertRegistryDrivenMcpOutputSchema(
          operation,
          z.object(removedShape as z.ZodRawShape),
        ),
      `${operation.id} rejects an advertised output field removal`,
    );

    assert.throws(
      () =>
        assertRegistryDrivenMcpOutputSchema(
          operation,
          z.object({
            ...(advertisedShape as z.ZodRawShape),
            __undeclaredOutputField: z.unknown().optional(),
          }),
        ),
      `${operation.id} rejects an undeclared advertised output field`,
    );
  }
});

test('the declared transcript output relaxation is derived exactly while runtime output stays canonical', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  const operation = PUBLIC_V1_OPERATIONS.find(
    (entry): entry is McpMappedOperation =>
      entry.id === 'tasks.transcript' && isMcpMappedOperation(entry),
  );
  assert.ok(operation);
  const advertised = configs.get(operation.mcp.tool)?.outputSchema;
  assertRegistryDrivenMcpOutputSchema(operation, advertised);
  assert.ok(advertised instanceof z.ZodObject);

  for (const canonicalVariant of [
    TRANSCRIPT,
    { status: 'empty', reason: 'no-rollout' },
    { status: 'expired' },
  ]) {
    assert.doesNotThrow(() => SessionHistorySchema.parse(canonicalVariant));
    assert.doesNotThrow(() => advertised.parse(canonicalVariant));
  }

  const incompleteAvailablePayload = { status: 'available' };
  assert.throws(() => SessionHistorySchema.parse(incompleteAvailablePayload));
  assert.doesNotThrow(
    () => advertised.parse(incompleteAvailablePayload),
    'the sole advertised relaxation is the SDK-forced loss of variant-specific required fields',
  );
});

test('the official SDK still cannot advertise the canonical transcript union directly', async () => {
  const server = new McpServer({
    name: 'mcp-canonical-union-probe',
    version: '1.0.0',
  });
  (server as unknown as ToolRegistrar).registerTool(
    'canonical_union_probe',
    { outputSchema: SessionHistorySchema },
    async () => ({ content: [{ type: 'text', text: 'unused' }] }),
  );
  const client = new Client({
    name: 'mcp-canonical-union-probe-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    const probe = advertised.tools.find(
      (tool) => tool.name === 'canonical_union_probe',
    );
    assert.ok(probe);
    assert.equal(
      probe.outputSchema,
      undefined,
      'remove the declared relaxation when the SDK can expose a root object union',
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('the REST-only task idempotency header is an explicit MCP protocol difference', () => {
  const mappedOperationsWithHeaders = PUBLIC_V1_OPERATIONS.filter(
    (operation) => 'tool' in operation.mcp && 'headers' in operation.input,
  ).map((operation) => ({
    operation: operation.id,
    headers: Object.keys(
      'headers' in operation.input ? operation.input.headers.wire.shape : {},
    ).sort(),
  }));

  assert.deepEqual(mappedOperationsWithHeaders, [
    { operation: 'tasks.create', headers: ['Idempotency-Key'] },
  ]);
});

test('create_task advertises MCP polling and never claims the REST header is accepted', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  const description = configs.get('create_task')?.description;
  assert.match(description ?? '', /Poll get_task/u);
  assert.match(description ?? '', /REST-only/u);
  assert.match(description ?? '', /not mapped to a tool argument/u);
  assert.doesNotMatch(description ?? '', /Accepts an optional/u);
});

test('every MCP tool advertises structured output and create_task reuses the /v1 input shape', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  assert.deepEqual(
    Object.keys(
      advertisedInputShape(configs.get('create_task')?.inputSchema),
    ).sort(),
    Object.keys(V1CreateTaskRequestSchema.shape).sort(),
  );
  for (const [name, config] of configs) {
    assert.ok(config.outputSchema, `${name} advertises outputSchema`);
  }
  assert.equal(
    configs.get('create_task')?.outputSchema,
    TaskResponseSchema,
    'create_task structured output uses the canonical /v1 task response schema',
  );
  assert.equal(
    configs.get('list_runtime_models')?.inputSchema,
    RuntimeModelCatalogQuerySchema,
    'runtime-model inventory uses the complete strict canonical input schema',
  );
  assert.equal(
    configs.get('list_runtime_models')?.outputSchema,
    RuntimeModelCatalogSchema,
  );
});

test('generated task-create field parity covers Console, V1, MCP callbacks, and schedule templates', async () => {
  const canonicalFields = Object.keys(CreateTaskRequestSchema.shape).sort();
  const fieldsWithoutRepoId = (shape: Record<string, unknown>): string[] =>
    Object.keys(shape)
      .filter((field) => field !== 'repoId')
      .sort();
  assert.deepEqual(
    fieldsWithoutRepoId(V1CreateTaskRequestSchema.shape),
    canonicalFields,
    'Public V1 differs from the Console REST body only by repoId',
  );
  assert.deepEqual(
    fieldsWithoutRepoId(ScheduleTaskTemplateCreateSchema.shape),
    canonicalFields,
    'the canonical schedule write template inherits every task field',
  );

  const captured: Array<{ surface: string; body: unknown }> = [];
  const base = recordingDeps();
  const deps: McpToolDeps = {
    ...base.deps,
    async createTask(_repoId, body) {
      captured.push({ surface: 'create_task', body });
      return TASK;
    },
    async createSchedule(_ownerUserId, body) {
      captured.push({ surface: 'create_schedule', body: body.taskTemplate });
      return SCHEDULE;
    },
    async updateSchedule(_ownerUserId, _id, body) {
      captured.push({ surface: 'update_schedule', body: body.taskTemplate });
      return SCHEDULE;
    },
  };
  const { server, tools, configs } = captureServer();
  registerMcpTools(server as never, deps);

  assert.deepEqual(
    fieldsWithoutRepoId(
      advertisedInputShape(configs.get('create_task')?.inputSchema),
    ),
    canonicalFields,
    'MCP create_task advertises every canonical task field',
  );
  for (const name of ['create_schedule', 'update_schedule']) {
    const taskTemplate = advertisedInputShape(
      configs.get(name)?.inputSchema,
    ).taskTemplate;
    assert.deepEqual(
      fieldsWithoutRepoId(advertisedObjectShape(taskTemplate)),
      canonicalFields,
      `MCP ${name} advertises every canonical task field`,
    );
  }

  const canonicalBody = {
    prompt: 'all canonical task fields',
    branch: 'feature/schema-parity',
    strategy: 'preserve every field',
    skills: ['openspec'],
    deadlineMs: 3_600_000,
    idleTimeoutMs: 900_000,
    runtime: 'claude-code' as const,
    model: 'provider/model:v1.2+preview@[region]/family_name;$,=',
    sandboxEnvironmentId: null,
    deliver: 'pr' as const,
  };
  assert.deepEqual(
    Object.keys(canonicalBody).sort(),
    canonicalFields,
    'the callback fixture intentionally exercises every canonical field',
  );
  const template = { repoId: TASK.repoId, ...canonicalBody };
  const owner = extraWithOwner(['tasks:write'], 'schema-parity-owner');
  await tools.get('create_task')!(template, owner);
  await tools.get('create_schedule')!(
    {
      recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      taskTemplate: template,
    },
    owner,
  );
  await tools.get('update_schedule')!(
    { id: SCHEDULE_ID, taskTemplate: template },
    owner,
  );

  assert.deepEqual(captured, [
    { surface: 'create_task', body: canonicalBody },
    { surface: 'create_schedule', body: template },
    { surface: 'update_schedule', body: template },
  ]);
});

test('schedule tool metadata inherits the shared sub-day recurrence contract', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  for (const name of ['create_schedule', 'update_schedule']) {
    const config = configs.get(name);
    assert.ok(config);
    assert.match(config.description ?? '', /hourly/);
    assert.match(config.description ?? '', /minuteInterval/);
    const recurrence = advertisedInputShape(config.inputSchema).recurrence as
      | { parse(value: unknown): unknown }
      | undefined;
    assert.ok(recurrence, `${name} advertises the shared recurrence field`);
    for (const interval of [5, 10, 15, 30]) {
      assert.doesNotThrow(() =>
        recurrence.parse({
          kind: 'minuteInterval',
          intervalMinutes: interval,
          timezone: 'UTC',
        }),
      );
    }
    assert.doesNotThrow(() =>
      recurrence.parse({
        kind: 'hourly',
        minuteOfHour: 15,
        timezone: 'Asia/Shanghai',
      }),
    );
    assert.doesNotThrow(() =>
      recurrence.parse({
        kind: 'minuteInterval',
        intervalMinutes: 30,
        timezone: 'UTC',
      }),
    );
    assert.throws(() =>
      recurrence.parse({
        kind: 'minuteInterval',
        intervalMinutes: 7,
        timezone: 'UTC',
      }),
    );
    assert.equal(config.outputSchema, ScheduleResponseSchema);
  }

  assert.doesNotThrow(() =>
    ScheduleRecurrenceSchema.parse({
      kind: 'hourly',
      minuteOfHour: 59,
      timezone: 'UTC',
    }),
  );
});

test('schedule tools advertise and preserve an exact model selector on create and update', async () => {
  const selector =
    'provider/model:v1.2+preview@[region]/family_name;$,=';
  const captured: Array<{
    operation: 'create' | 'update';
    ownerUserId: string;
    model: string | undefined;
  }> = [];
  const base = recordingDeps();
  const deps: McpToolDeps = {
    ...base.deps,
    async createSchedule(ownerUserId, body) {
      captured.push({
        operation: 'create',
        ownerUserId,
        model: body.taskTemplate.model,
      });
      return SCHEDULE;
    },
    async updateSchedule(ownerUserId, _id, body) {
      captured.push({
        operation: 'update',
        ownerUserId,
        model: body.taskTemplate?.model,
      });
      return SCHEDULE;
    },
  };
  const { server, tools, configs } = captureServer();
  registerMcpTools(server as never, deps);
  const taskTemplate = {
    repoId: TASK.repoId,
    prompt: 'model-aware schedule',
    runtime: 'codex',
    sandboxEnvironmentId: null,
    model: selector,
  };

  for (const name of ['create_schedule', 'update_schedule']) {
    const templateSchema = advertisedInputShape(
      configs.get(name)?.inputSchema,
    ).taskTemplate as { parse(value: unknown): { model?: string } } | undefined;
    assert.ok(templateSchema, `${name} advertises taskTemplate`);
    assert.equal(templateSchema.parse(taskTemplate).model, selector);
  }

  const owner = extraWithOwner(['tasks:write'], 'owner-model-schedule');
  await tools.get('create_schedule')!(
    {
      recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      taskTemplate,
    },
    owner,
  );
  await tools.get('update_schedule')!(
    { id: SCHEDULE_ID, taskTemplate },
    owner,
  );

  assert.deepEqual(captured, [
    {
      operation: 'create',
      ownerUserId: 'owner-model-schedule',
      model: selector,
    },
    {
      operation: 'update',
      ownerUserId: 'owner-model-schedule',
      model: selector,
    },
  ]);
});

test('the production MCP factory advertises exactly the registry tool set', async () => {
  const factory = new McpServerFactory(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const server = factory.createServer();
  const client = new Client({ name: 'mcp-factory-parity-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    assert.deepEqual(
      advertised.tools.map((tool) => tool.name),
      PUBLIC_V1_OPERATIONS.flatMap((operation) =>
        'tool' in operation.mcp ? [operation.mcp.tool] : [],
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

async function sdkAdvertisedOutputSchemas(
  configs: ReadonlyMap<string, ToolConfig>,
): Promise<ReadonlyMap<string, unknown>> {
  const server = new McpServer({
    name: 'mcp-output-schema-reference',
    version: '1.0.0',
  });
  const registrar = server as unknown as ToolRegistrar;
  for (const operation of PUBLIC_V1_OPERATIONS.filter(isMcpMappedOperation)) {
    const outputSchema = configs.get(operation.mcp.tool)?.outputSchema;
    assert.ok(outputSchema, `${operation.id} has an exact captured output schema`);
    registrar.registerTool(
      operation.mcp.tool,
      { outputSchema: outputSchema as z.ZodTypeAny },
      async () => ({ content: [{ type: 'text', text: 'unused' }] }),
    );
  }

  const client = new Client({
    name: 'mcp-output-schema-reference-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    return new Map(
      advertised.tools.map((tool) => [tool.name, tool.outputSchema] as const),
    );
  } finally {
    await client.close();
    await server.close();
  }
}

test('the real MCP SDK advertises and validates structured list output', async () => {
  const { deps, calls } = recordingDeps();
  const captured = captureServer();
  registerMcpTools(captured.server as never, deps);
  assertRegistryDrivenMcpMetadata(captured.configs);
  const expectedOutputSchemas = await sdkAdvertisedOutputSchemas(
    captured.configs,
  );
  const server = new McpServer({ name: 'mcp-parity-test', version: '1.0.0' });
  registerMcpTools(server as unknown as ToolRegistrar, deps);
  const client = new Client({ name: 'mcp-parity-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  let grantedScopes = ['tasks:read', 'tasks:write'];
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: 'mcp_test',
        clientId: 'settings',
        scopes: grantedScopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        extra: { userId: 'local-acct-1' },
      },
    });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    const mappedOperations = PUBLIC_V1_OPERATIONS.flatMap((operation) =>
      'tool' in operation.mcp
        ? [
            {
              id: operation.id,
              tool: operation.mcp.tool,
              summary: operation.summary,
              destructive: operation.destructive,
            },
          ]
        : [],
    );
    assert.deepEqual(
      advertised.tools.map((tool) => tool.name),
      mappedOperations.map((operation) => operation.tool),
    );
    for (const operation of mappedOperations) {
      const tool = advertised.tools.find(
        (candidate) => candidate.name === operation.tool,
      );
      assert.equal(tool?.title, operation.summary);
      assert.equal(tool?.annotations?.readOnlyHint, !operation.destructive);
      assert.equal(
        tool?.annotations?.destructiveHint,
        operation.destructive,
      );
      assert.deepEqual(
        tool?.outputSchema,
        expectedOutputSchemas.get(operation.tool),
        `${operation.id} tools/list output schema exactly matches its registry-derived SDK projection`,
      );
    }
    const listTool = advertised.tools.find((tool) => tool.name === 'list_tasks');
    assert.ok(listTool?.outputSchema, 'tools/list includes the structured output schema');
    const runtimeModelsTool = advertised.tools.find(
      (tool) => tool.name === 'list_runtime_models',
    );
    assert.deepEqual(
      Object.keys(runtimeModelsTool?.inputSchema.properties ?? {}).sort(),
      Object.keys(RuntimeModelCatalogQuerySchema.shape).sort(),
    );
    assert.equal(runtimeModelsTool?.inputSchema.additionalProperties, false);

    grantedScopes = ['tasks:read'];
    const scopeFailure = await client.callTool({
      name: 'create_task',
      arguments: { repoId: TASK.repoId, prompt: 'scope wire check' },
    });
    assert.deepEqual(publicErrorEnvelope(scopeFailure), {
      code: 'insufficient_scope',
      message: 'Insufficient scope: tasks:write required (403)',
      retryable: false,
    });
    assert.match(
      toolErrorText(scopeFailure),
      new RegExp(String(MCP_PUBLIC_ERROR_MAP.insufficient_scope.jsonRpcCode)),
    );
    grantedScopes = ['tasks:read', 'tasks:write'];

    const catalogCallsBeforeInvalid = calls.filter((call) =>
      call.startsWith('queryRuntimeModels:'),
    ).length;
    const invalidOwner = await client.callTool({
      name: 'list_runtime_models',
      arguments: { runtime: 'codex', ownerUserId: 'attacker' },
    });
    assert.equal(invalidOwner.isError, true);
    assert.match(
      (invalidOwner.content as Array<{ text?: string }>)[0]?.text ?? '',
      /invalid|unrecognized|ownerUserId/i,
    );
    assert.equal(
      calls.filter((call) => call.startsWith('queryRuntimeModels:')).length,
      catalogCallsBeforeInvalid,
      'SDK rejects a client-supplied owner before catalog discovery',
    );

    const catalog = await client.callTool({
      name: 'list_runtime_models',
      arguments: { runtime: 'codex', sandboxEnvironmentId: null },
    });
    assert.doesNotThrow(() =>
      RuntimeModelCatalogSchema.parse(catalog.structuredContent),
    );
    assert.ok(
      calls.includes('queryRuntimeModels:local-acct-1:codex'),
      'catalog delegation always uses the authenticated token owner',
    );

    const result = await client.callTool({
      name: 'list_tasks',
      arguments: { limit: 1 },
    });
    assert.doesNotThrow(() =>
      V1ListTasksResponseSchema.parse(result.structuredContent),
    );
    const content = result.content as Array<{ type?: unknown }>;
    assert.equal(content[0]?.type, 'text', 'legacy text content is preserved');

    const transcript = await client.callTool({
      name: 'get_transcript',
      arguments: { id: TASK.id },
    });
    assert.doesNotThrow(() =>
      SessionHistorySchema.parse(transcript.structuredContent),
    );

    const created = await client.callTool({
      name: 'create_task',
      arguments: { repoId: TASK.repoId, prompt: 'go' },
    });
    assert.doesNotThrow(() =>
      TaskResponseSchema.parse(created.structuredContent),
    );
    const legacyText = JSON.parse(
      (created.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { id: string; status: string; task: typeof TASK };
    assert.equal(legacyText.id, TASK.id);
    assert.equal(legacyText.status, TASK.status);
    assert.deepEqual(legacyText.task, JSON.parse(JSON.stringify(TASK)));

    const deleted = await client.callTool({
      name: 'delete_schedule',
      arguments: { id: SCHEDULE_ID },
    });
    assert.deepEqual(
      PublicV1DeletionAcknowledgementSchema.parse(deleted.structuredContent),
      { id: SCHEDULE_ID, deleted: true },
    );
    assert.deepEqual(
      JSON.parse(
        (deleted.content as Array<{ type: string; text: string }>)[0]!.text,
      ),
      { id: SCHEDULE_ID, deleted: true },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('the real MCP wire preserves canonical structured runtime-model errors', async () => {
  const { deps } = recordingDeps();
  const domainError = {
    code: 'runtime_model_catalog_unavailable' as const,
    message: 'The effective runtime model catalog is temporarily unavailable.',
    retryable: true as const,
    context: {
      runtime: 'codex' as const,
      sandboxEnvironmentId: null,
    },
    capacity: {
      scope: 'owner' as const,
      retryAfterMs: 2_000,
    },
  };
  deps.queryRuntimeModels = async () => {
    throw new RuntimeModelPreflightError(domainError);
  };
  deps.resumeSchedule = async () => {
    throw new RuntimeModelPreflightError(domainError);
  };

  const server = new McpServer({ name: 'mcp-model-error-test', version: '1.0.0' });
  registerMcpTools(server as unknown as ToolRegistrar, deps);
  const client = new Client({ name: 'mcp-model-error-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: 'mcp_test',
        clientId: 'settings',
        scopes: ['tasks:write'],
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        extra: { userId: 'local-acct-1' },
      },
    });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    for (const call of [
      {
        name: 'list_runtime_models',
        arguments: { runtime: 'codex' },
      },
      {
        name: 'resume_schedule',
        arguments: { id: SCHEDULE_ID },
      },
    ] as const) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(
        result._meta?.['com.cloud-agent-platform/public-error'],
        domainError,
      );
      const text = (
        result.content as Array<{ type: string; text?: string }>
      )[0]?.text;
      assert.deepEqual(JSON.parse(text ?? '{}'), domainError);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('the real MCP schedule wire maps both model-domain errors on create and update', async () => {
  const { deps } = recordingDeps();
  const errorFor = (model: string) => {
    const catalogUnavailable = model === 'fixture/catalog-unavailable';
    const context = {
      runtime: 'codex' as const,
      sandboxEnvironmentId: null,
      model,
    };
    if (catalogUnavailable) {
      return {
        code: 'runtime_model_catalog_unavailable' as const,
        message:
          'The effective runtime model catalog is temporarily unavailable.',
        retryable: true as const,
        context,
      };
    }
    return {
      code: 'runtime_model_not_available' as const,
      message: 'The requested runtime model is not available.',
      retryable: false as const,
      context,
    };
  };
  deps.createSchedule = async (_ownerUserId, body) => {
    throw new RuntimeModelPreflightError(
      errorFor(body.taskTemplate.model ?? ''),
    );
  };
  deps.updateSchedule = async (_ownerUserId, _id, body) => {
    throw new RuntimeModelPreflightError(
      errorFor(body.taskTemplate?.model ?? ''),
    );
  };

  const server = new McpServer({
    name: 'mcp-schedule-model-error-test',
    version: '1.0.0',
  });
  registerMcpTools(server as unknown as ToolRegistrar, deps);
  const client = new Client({
    name: 'mcp-schedule-model-error-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: 'mcp_test',
        clientId: 'settings',
        scopes: ['tasks:write'],
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        extra: { userId: 'local-acct-1' },
      },
    });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    for (const name of ['create_schedule', 'update_schedule'] as const) {
      for (const model of [
        'fixture/not-available',
        'fixture/catalog-unavailable',
      ]) {
        const taskTemplate = {
          repoId: TASK.repoId,
          prompt: 'model-aware schedule',
          model,
        };
        const expected = errorFor(model);
        const result = await client.callTool({
          name,
          arguments:
            name === 'create_schedule'
              ? {
                  recurrence: {
                    kind: 'daily',
                    time: '09:00',
                    timezone: 'UTC',
                  },
                  taskTemplate,
                }
              : { id: SCHEDULE_ID, taskTemplate },
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.deepEqual(
          result._meta?.['com.cloud-agent-platform/public-error'],
          expected,
        );
        const text = (
          result.content as Array<{ type: string; text?: string }>
        )[0]?.text;
        assert.deepEqual(JSON.parse(text ?? '{}'), expected);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('McpServerFactory list_tasks uses the canonical persisted failure projection', async () => {
  const failureAt = new Date('2026-07-12T12:32:31.000Z');
  const prisma = {
    task: {
      async findMany() {
        return [
          {
            ...TASK,
            status: 'failed',
            runtime: 'claude-code',
            executionMode: null,
            deliver: null,
            failureCode: 'runtime_auth_expired',
            failureAt,
            failureExitCode: 1,
          },
        ];
      },
    },
  } as unknown as PrismaService;
  const factory = new McpServerFactory(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma,
    {} as never,
    {} as never,
    {} as never,
  );

  const page = await factory.listTasks({ limit: 10 });

  const failure = page.items[0].failure;
  assert.equal(failure?.code, 'runtime_auth_expired');
  assert.ok(failure && 'runtime' in failure);
  assert.equal(failure.runtime, 'claude-code');
  assert.equal(page.items[0].executionMode, 'interactive-pty');
  assert.equal(page.items[0].deliver, 'none');
  assert.equal(page.items[0].sandboxProvider, null);
});

test('schedule tools reject missing scopes before calling the schedule service', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const readOnly = extraWithOwner(['tasks:read']);
  const noScopes = extraWithOwner([]);
  for (const name of [
    'create_schedule',
    'update_schedule',
    'pause_schedule',
    'resume_schedule',
    'dispatch_schedule',
    'delete_schedule',
  ]) {
    await expectPublicToolError(
      () => tools.get(name)!({ id: SCHEDULE_ID }, readOnly),
      'insufficient_scope',
      /tasks:write required \(403\)/,
    );
  }
  for (const name of ['list_schedules', 'get_schedule', 'list_schedule_runs']) {
    await expectPublicToolError(
      () => tools.get(name)!({ id: SCHEDULE_ID }, noScopes),
      'insufficient_scope',
      /tasks:read required \(403\)/,
    );
  }
  assert.deepEqual(calls, []);
});

test('every schedule tool requires authInfo.extra.userId before calling the service', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  for (const name of ['list_schedules', 'get_schedule', 'list_schedule_runs']) {
    await expectPublicToolError(
      () => tools.get(name)!({ id: SCHEDULE_ID }, extraWith(['tasks:read'])),
      'owner_required',
      /account owner \(403\)/,
    );
  }
  for (const name of [
    'create_schedule',
    'update_schedule',
    'pause_schedule',
    'resume_schedule',
    'dispatch_schedule',
    'delete_schedule',
  ]) {
    await expectPublicToolError(
      () => tools.get(name)!({ id: SCHEDULE_ID }, extraWith(['tasks:write'])),
      'owner_required',
      /account owner \(403\)/,
    );
  }
  assert.deepEqual(calls, []);
});

test('schedule tools pass the token owner and delegate to ScheduledTasksService methods', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const owner = extraWithOwner(['tasks:read', 'tasks:write']);

  await tools.get('create_schedule')!(
    {
      recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      taskTemplate: { repoId: TASK.repoId, prompt: 'daily check' },
    },
    owner,
  );
  await tools.get('list_schedules')!({ limit: 25, cursor: 'schedule-next' }, owner);
  await tools.get('get_schedule')!({ id: SCHEDULE_ID }, owner);
  await tools.get('update_schedule')!(
    { id: SCHEDULE_ID, name: 'renamed' },
    owner,
  );
  await tools.get('pause_schedule')!({ id: SCHEDULE_ID }, owner);
  await tools.get('resume_schedule')!({ id: SCHEDULE_ID }, owner);
  await tools.get('dispatch_schedule')!(
    { id: SCHEDULE_ID, expectedPeriodKey: 'day:2026-07-11' },
    owner,
  );
  await tools.get('delete_schedule')!({ id: SCHEDULE_ID }, owner);
  await tools.get('list_schedule_runs')!(
    { id: SCHEDULE_ID, limit: 10, cursor: 'run-next' },
    owner,
  );

  assert.deepEqual(calls, [
    `createSchedule:local-acct-1:${TASK.repoId}:daily check`,
    'listSchedules:local-acct-1:25:schedule-next',
    `getSchedule:local-acct-1:${SCHEDULE_ID}`,
    `updateSchedule:local-acct-1:${SCHEDULE_ID}:renamed`,
    `pauseSchedule:local-acct-1:${SCHEDULE_ID}`,
    `resumeSchedule:local-acct-1:${SCHEDULE_ID}`,
    `dispatchSchedule:local-acct-1:${SCHEDULE_ID}:day:2026-07-11`,
    `deleteSchedule:local-acct-1:${SCHEDULE_ID}`,
    `listScheduleRuns:local-acct-1:${SCHEDULE_ID}:10:run-next`,
  ]);
});

test('dispatch_schedule returns persisted retrying and terminal model outcomes as normal structured results', async () => {
  const { deps } = recordingDeps();
  const scheduledFor = new Date('2026-07-10T09:00:00.000Z');
  const retryAt = new Date('2026-07-10T09:00:05.000Z');
  const outcomes: ScheduleResponse[] = [
    {
      ...SCHEDULE,
      latestRun: {
        id: SCHEDULE_RUN_ID,
        scheduledFor,
        status: 'retrying',
        taskId: null,
        error: 'Runtime model catalog is temporarily unavailable.',
        errorCode: 'runtime_model_catalog_unavailable',
        retryAt,
        retryAttempt: 1,
      },
    },
    {
      ...SCHEDULE,
      latestRun: {
        id: SCHEDULE_RUN_ID,
        scheduledFor,
        status: 'failed',
        taskId: null,
        error: 'The requested runtime model is not available.',
        errorCode: 'runtime_model_not_available',
        retryAt: null,
        retryAttempt: null,
      },
    },
  ];
  deps.dispatchSchedule = async () => outcomes.shift()!;
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const owner = extraWithOwner(['tasks:write']);

  const retryResult = (await tools.get('dispatch_schedule')!(
    { id: SCHEDULE_ID },
    owner,
  )) as {
    structuredContent: Record<string, unknown>;
    content: Array<{ text: string }>;
  };
  const failedResult = (await tools.get('dispatch_schedule')!(
    { id: SCHEDULE_ID },
    owner,
  )) as {
    structuredContent: Record<string, unknown>;
    content: Array<{ text: string }>;
  };

  const retrySchedule = ScheduleResponseSchema.parse(
    retryResult.structuredContent,
  );
  const failedSchedule = ScheduleResponseSchema.parse(
    failedResult.structuredContent,
  );
  assert.equal(retrySchedule.latestRun?.status, 'retrying');
  assert.equal(retrySchedule.latestRun?.retryAttempt, 1);
  assert.equal(failedSchedule.latestRun?.status, 'failed');
  assert.equal(
    failedSchedule.latestRun?.errorCode,
    'runtime_model_not_available',
  );
  assert.deepEqual(
    JSON.parse(retryResult.content[0]!.text),
    retryResult.structuredContent,
  );
  assert.deepEqual(
    JSON.parse(failedResult.content[0]!.text),
    failedResult.structuredContent,
  );
});

test('schedule tools round-trip sub-day descriptors and preserve cron compatibility', async () => {
  const hourlySchedule: ScheduleResponse = {
    ...SCHEDULE,
    name: 'hourly check',
    cronExpression: '15 * * * *',
    timezone: 'Asia/Shanghai',
    recurrence: {
      kind: 'hourly',
      minuteOfHour: 15,
      timezone: 'Asia/Shanghai',
      label: '每小时第 15 分钟',
    },
  };
  const intervalSchedule: ScheduleResponse = {
    ...SCHEDULE,
    name: 'interval check',
    cronExpression: '*/15 * * * *',
    recurrence: {
      kind: 'minuteInterval',
      intervalMinutes: 15,
      timezone: 'UTC',
      label: '每 15 分钟',
    },
  };
  const customSchedule: ScheduleResponse = {
    ...SCHEDULE,
    name: 'compatibility cron',
    cronExpression: '7,37 * * * *',
    recurrence: {
      kind: 'custom',
      timezone: 'UTC',
      label: '自定义重复',
    },
  };
  const base = recordingDeps();
  const delegated: string[] = [];
  let current = hourlySchedule;
  const deps: McpToolDeps = {
    ...base.deps,
    async createSchedule(
      ownerUserId: string,
      body: CreateScheduleRequest,
    ) {
      delegated.push(
        `create:${ownerUserId}:${body.recurrence?.kind ?? 'cron'}:${body.cronExpression}`,
      );
      current = body.recurrence?.kind === 'hourly'
        ? hourlySchedule
        : customSchedule;
      return current;
    },
    async updateSchedule(
      ownerUserId: string,
      id: string,
      body: UpdateScheduleRequest,
    ) {
      delegated.push(
        `update:${ownerUserId}:${id}:${body.recurrence?.kind ?? 'cron'}:${body.cronExpression ?? '-'}`,
      );
      current = intervalSchedule;
      return current;
    },
    async getSchedule(ownerUserId: string, id: string) {
      delegated.push(`get:${ownerUserId}:${id}`);
      return current;
    },
    async listSchedules(ownerUserId, query) {
      delegated.push(`list:${ownerUserId}:${query.limit}`);
      return { items: [current], nextCursor: null };
    },
  };
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const owner = extraWithOwner(['tasks:read', 'tasks:write']);
  const structured = async (name: string, args: Record<string, unknown>) => {
    const result = (await tools.get(name)!(args, owner)) as {
      structuredContent: Record<string, unknown>;
    };
    return result.structuredContent;
  };

  const created = ScheduleResponseSchema.parse(
    await structured('create_schedule', {
      recurrence: {
        kind: 'hourly',
        minuteOfHour: 15,
        timezone: 'Asia/Shanghai',
      },
      taskTemplate: { repoId: TASK.repoId, prompt: 'hourly check' },
    }),
  );
  assert.equal(created.recurrence.kind, 'hourly');

  const updated = ScheduleResponseSchema.parse(
    await structured('update_schedule', {
      id: SCHEDULE_ID,
      recurrence: {
        kind: 'minuteInterval',
        intervalMinutes: 15,
        timezone: 'UTC',
      },
    }),
  );
  assert.equal(updated.recurrence.kind, 'minuteInterval');
  const fetched = ScheduleResponseSchema.parse(
    await structured('get_schedule', { id: SCHEDULE_ID }),
  );
  assert.equal(fetched.recurrence.kind, 'minuteInterval');
  const listed = V1ListSchedulesResponseSchema.parse(
    await structured('list_schedules', { limit: 10 }),
  );
  assert.equal(listed.items[0]?.recurrence.kind, 'minuteInterval');

  const beforeInvalid = delegated.length;
  await expectPublicToolError(
    () =>
      tools.get('update_schedule')!(
        {
          id: SCHEDULE_ID,
          recurrence: {
            kind: 'minuteInterval',
            intervalMinutes: 7,
            timezone: 'UTC',
          },
        },
        owner,
      ),
    'validation_failed',
    /Validation failed/iu,
  );
  assert.equal(delegated.length, beforeInvalid);

  const compatibility = ScheduleResponseSchema.parse(
    await structured('create_schedule', {
      cronExpression: '7,37 * * * *',
      timezone: 'UTC',
      taskTemplate: { repoId: TASK.repoId, prompt: 'compatibility cron' },
    }),
  );
  assert.equal(compatibility.recurrence.kind, 'custom');
  assert.deepEqual(delegated, [
    'create:local-acct-1:hourly:15 * * * *',
    `update:local-acct-1:${SCHEDULE_ID}:minuteInterval:*/15 * * * *`,
    `get:local-acct-1:${SCHEDULE_ID}`,
    'list:local-acct-1:10',
    'create:local-acct-1:cron:7,37 * * * *',
  ]);
});

test('schedule tools reuse contract cross-field validation before delegation', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const owner = extraWithOwner(['tasks:write']);

  await expectPublicToolError(
    () =>
      tools.get('create_schedule')!(
        {
          recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
          cronExpression: '0 9 * * *',
          taskTemplate: { repoId: TASK.repoId, prompt: 'daily check' },
        },
        owner,
      ),
    'validation_failed',
    /Provide recurrence or cronExpression, not both/,
  );
  await expectPublicToolError(
    () => tools.get('update_schedule')!({ id: SCHEDULE_ID }, owner),
    'validation_failed',
    /At least one schedule field must be provided/,
  );
  await expectPublicToolError(
    () =>
      tools.get('dispatch_schedule')!(
        { id: SCHEDULE_ID, expectedPeriodKey: '' },
        owner,
      ),
    'validation_failed',
    /Invalid schedule period identity/,
  );
  assert.deepEqual(DispatchScheduleRequestSchema.parse({}), {});
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// 2 + 3. One admission path + immediate handle (task 4.4).
// ---------------------------------------------------------------------------

interface McpDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function mcpDeferred<T>(): McpDeferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const MCP_DURABLE_CREATED_AT = new Date('2026-07-16T00:00:00.000Z');

interface McpDurableState {
  tasks: Map<string, Record<string, unknown>>;
  works: Map<string, Record<string, unknown>>;
  audits: Map<string, Record<string, unknown>>;
  idempotencyKeys: Map<string, Record<string, unknown>>;
}

/**
 * Minimal transaction-aware persistence boundary for the real MCP create path.
 * A transaction publishes Task + admission work + audit together; the root
 * readers return the same relation projection consumed by TasksService and the
 * shared V1/MCP page helpers.
 */
class McpDurableCreateDatabase {
  private readonly state: McpDurableState = {
    tasks: new Map(),
    works: new Map(),
    audits: new Map(),
    idempotencyKeys: new Map(),
  };
  private idempotencyOperations = 0;

  private readonly repo = {
    id: TASK.repoId,
    name: 'durable-mcp-repo',
    gitSource: 'https://gitee.example/acme/repo.git',
    createdAt: MCP_DURABLE_CREATED_AT,
    description: null,
    defaultBranch: 'master',
    branchCount: null,
    updatedAt: MCP_DURABLE_CREATED_AT,
    githubId: null,
    isDefault: false,
    forge: 'gitee',
  };

  readonly prisma = {
    repo: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === this.repo.id ? { ...this.repo } : null,
      findMany: async () => [{ ...this.repo }],
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.readTask(where.id),
      findMany: async () =>
        [...this.state.tasks.keys()]
          .map((id) => this.readTask(id))
          .filter((row): row is Record<string, unknown> => row !== null),
    },
    taskAdmissionWork: {
      findUnique: async ({ where }: { where: { taskId: string } }) =>
        this.state.works.get(where.taskId) ?? null,
    },
    idempotencyKey: {
      findUnique: async () => {
        this.idempotencyOperations += 1;
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        this.idempotencyOperations += 1;
        const key = `${String(data.scopeUserId)}\u0000${String(data.key)}`;
        this.state.idempotencyKeys.set(key, { ...data });
        return data;
      },
      deleteMany: async () => {
        this.idempotencyOperations += 1;
        return { count: 0 };
      },
    },
    $transaction: async <T>(
      operation: (client: TaskAcceptanceClient) => Promise<T>,
    ): Promise<T> => {
      const staged: McpDurableState = {
        tasks: new Map(this.state.tasks),
        works: new Map(this.state.works),
        audits: new Map(this.state.audits),
        idempotencyKeys: new Map(this.state.idempotencyKeys),
      };
      const result = await operation(this.transactionClient(staged));
      this.publish(staged);
      return result;
    },
  } as unknown as PrismaService;

  get counts() {
    return {
      tasks: this.state.tasks.size,
      works: this.state.works.size,
      audits: this.state.audits.size,
      idempotencyKeys: this.state.idempotencyKeys.size,
      idempotencyOperations: this.idempotencyOperations,
    } as const;
  }

  private readTask(id: string): Record<string, unknown> | null {
    const task = this.state.tasks.get(id);
    if (!task) return null;
    const work = this.state.works.get(id);
    return {
      ...task,
      admissionWork: work
        ? {
            state: work.state,
            stage: work.stage,
            attempt: work.attempt,
            resolvedBranch: work.resolvedBranch,
            updatedAt: work.updatedAt,
          }
        : null,
      sandboxRuns: [],
      sandboxEnvironment: null,
      scheduleRun: null,
    };
  }

  private transactionClient(state: McpDurableState): TaskAcceptanceClient {
    return {
      task: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (state.tasks.has(TASK.id)) {
            throw Object.assign(new Error('duplicate task'), { code: 'P2002' });
          }
          const row = {
            id: TASK.id,
            ...data,
            status: 'pending',
            lifecycleVersion: 0,
            failureCode: null,
            failureAt: null,
            failureExitCode: null,
            createdAt: MCP_DURABLE_CREATED_AT,
            branch: data.branch ?? null,
            strategy: data.strategy ?? null,
            skills: data.skills ?? [],
            idleTimeoutMs: data.idleTimeoutMs ?? null,
            deadlineMs: data.deadlineMs ?? null,
            runtime: data.runtime ?? null,
            model: data.model ?? null,
            sandboxEnvironmentId: data.sandboxEnvironmentId ?? null,
            executionMode: data.executionMode ?? null,
            deliver: data.deliver ?? null,
            deliverStatus: null,
            branchPushed: null,
            commitSha: null,
            changeRequestUrl: null,
            changeRequestNumber: null,
          };
          state.tasks.set(TASK.id, row);
          return row as never;
        },
      } as never,
      taskAdmissionWork: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const taskId = String(data.taskId);
          if (state.works.has(taskId)) {
            throw Object.assign(new Error('duplicate admission work'), {
              code: 'P2002',
            });
          }
          const row = {
            ...data,
            taskId,
            state: 'accepted',
            stage: 'accepted',
            attempt: 0,
            updatedAt: MCP_DURABLE_CREATED_AT,
          };
          state.works.set(taskId, row);
          return row as never;
        },
      } as never,
      auditEvent: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          const key = String(create.dedupeKey);
          const existing = state.audits.get(key);
          if (existing) return existing as never;
          state.audits.set(key, { ...create });
          return create as never;
        },
      } as never,
    };
  }

  private publish(source: McpDurableState): void {
    for (const [target, next] of [
      [this.state.tasks, source.tasks],
      [this.state.works, source.works],
      [this.state.audits, source.audits],
      [this.state.idempotencyKeys, source.idempotencyKeys],
    ] as const) {
      target.clear();
      for (const [key, value] of next) target.set(key, value);
    }
  }
}

test('tools dispatch to the same service surface the console uses', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const full = extraWith(['tasks:read', 'tasks:write', 'repos:read']);
  await tools.get('get_task')!({ id: TASK.id }, full);
  await tools.get('list_tasks')!({ limit: 20, cursor: 'task-next' }, full);
  await tools.get('get_transcript')!({ id: TASK.id }, full);
  await tools.get('list_repos')!({ limit: 30, cursor: 'repo-next' }, full);
  await tools.get('get_repo')!({ id: REPO.id }, full);

  assert.deepEqual(calls, [
    `getTask:${TASK.id}`,
    'listTasks:20:task-next',
    `getTranscript:${TASK.id}`,
    'listRepos:30:repo-next',
    `getRepo:${REPO.id}`,
  ]);
});

test(
  'the production MCP factory returns canonical durable projections before provisioning completes',
  { timeout: 10_000 },
  async () => {
    const database = new McpDurableCreateDatabase();
    const provisionEntered = mcpDeferred<void>();
    const releaseProvision = mcpDeferred<void>();
    const providerOperations: Promise<void>[] = [];
    let providerCalls = 0;
    let providerCompletions = 0;
    let wakeCalls = 0;

    const provider: Pick<SandboxProvider, 'provision'> = {
      async provision(context) {
        providerCalls += 1;
        assert.equal(context.taskId, TASK.id);
        assert.equal(context.executionMode, 'headless-exec');
        provisionEntered.resolve();
        await releaseProvision.promise;
        return {
          taskId: context.taskId,
          baseUrl: 'http://sandbox.test/task',
          wsUrl: 'ws://sandbox.test/task/ws',
        };
      },
    };
    const wake: TaskAdmissionWakePort = {
      wake(taskId) {
        wakeCalls += 1;
        const operation = provider
          .provision({
            taskId,
            modelIntent: { kind: 'runtime-default' },
            runtimeId: 'codex',
            executionMode: 'headless-exec',
            environment: null,
            resources: Object.freeze({ diskSizeGb: 12 }),
            workspace: null,
            cloneSpec: null,
          })
          .then(() => {
            providerCompletions += 1;
          });
        providerOperations.push(operation);
      },
    };
    const gate: TaskAdmissionGatePort = { isEnabled: () => true };
    const environments = {
      async resolveTaskAdmission() {
        return Object.freeze({
          environment: null,
          providerId: 'boxlite',
          providerFamily: 'boxlite' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({ diskSizeGb: 12 }),
            workspaceMaterializationDeadlineMs: 900_000,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService;
    const branches = {
      async prepareForCreate() {
        return {
          repositoryUrl: 'https://gitee.example/acme/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          source: 'repo-default-branch' as const,
        };
      },
    } as unknown as TaskBranchResolver;
    const tasks = new TasksService(
      database.prisma,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      environments,
      undefined,
      undefined,
      gate,
      branches,
      wake,
    );
    let prepareCalls = 0;
    let acceptanceCalls = 0;
    const prepareTaskCreate = tasks.prepareTaskCreate.bind(tasks);
    tasks.prepareTaskCreate = async (
      ...args: Parameters<TasksService['prepareTaskCreate']>
    ) => {
      prepareCalls += 1;
      return prepareTaskCreate(...args);
    };
    const acceptPreparedTask = tasks.acceptPreparedTask.bind(tasks);
    tasks.acceptPreparedTask = async (
      ...args: Parameters<TasksService['acceptPreparedTask']>
    ) => {
      acceptanceCalls += 1;
      return acceptPreparedTask(...args);
    };

    const repos = new ReposService(
      database.prisma,
      {} as never,
      {} as never,
      {} as never,
    );
    const factory = new McpServerFactory(
      tasks,
      repos,
      {} as never,
      {} as never,
      {} as never,
      database.prisma,
      {} as never,
      {} as never,
      provider as SandboxProvider,
    );
    const server = factory.createServer();
    const client = new Client({
      name: 'mcp-durable-create-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          token: 'mcp_durable_create',
          clientId: 'settings',
          scopes: ['tasks:read', 'tasks:write', 'repos:read'],
          expiresAt: Math.floor(Date.now() / 1000) + 3_600,
          extra: { userId: 'local-acct-1' },
        },
      });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const createResultPromise = client.callTool({
        name: 'create_task',
        arguments: {
          repoId: TASK.repoId,
          prompt: 'go',
          sandboxEnvironmentId: null,
        },
      });

      const admissionSignal = await Promise.race([
        provisionEntered.promise.then(() => ({ entered: true as const })),
        createResultPromise.then((result) => ({
          entered: false as const,
          result,
        })),
      ]);
      assert.equal(
        admissionSignal.entered,
        true,
        `create_task returned before durable provisioning was woken: ${JSON.stringify(
          'result' in admissionSignal ? admissionSignal.result : null,
        )}`,
      );
      const created = await createResultPromise;
      const canonical = TaskResponseSchema.parse(created.structuredContent);
      const canonicalJson = JSON.parse(
        JSON.stringify(canonical),
      ) as Record<string, unknown>;
      const text = JSON.parse(
        (created.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { id: string; status: string; task: Record<string, unknown> };

      assert.deepEqual(
        created.structuredContent,
        canonicalJson,
        'structuredContent contains exactly the canonical secret-free task projection',
      );
      assert.deepEqual(text, {
        id: canonical.id,
        status: canonical.status,
        task: canonicalJson,
      });
      assert.equal(canonical.executionMode, 'headless-exec');
      assert.deepEqual(canonical.provisioning, {
        state: 'accepted',
        stage: 'accepted',
        attempt: 0,
        resolvedBranch: 'master',
        updatedAt: MCP_DURABLE_CREATED_AT,
      });
      assert.equal(
        providerCompletions,
        0,
        'the tool resolves while the controllable provider barrier is held',
      );
      assert.deepEqual(database.counts, {
        tasks: 1,
        works: 1,
        audits: 1,
        idempotencyKeys: 0,
        idempotencyOperations: 0,
      });
      assert.deepEqual(
        { prepareCalls, acceptanceCalls, wakeCalls, providerCalls },
        {
          prepareCalls: 1,
          acceptanceCalls: 1,
          wakeCalls: 1,
          providerCalls: 1,
        },
      );

      const taskRead = await client.callTool({
        name: 'get_task',
        arguments: { id: canonical.id },
      });
      assert.deepEqual(
        TaskResponseSchema.parse(taskRead.structuredContent),
        canonical,
        'get_task preserves the canonical create projection',
      );
      const taskPage = await client.callTool({
        name: 'list_tasks',
        arguments: { limit: 10 },
      });
      assert.deepEqual(
        V1ListTasksResponseSchema.parse(taskPage.structuredContent).items,
        [canonical],
        'list_tasks uses the matching shared task projection',
      );

      const repoRead = await client.callTool({
        name: 'get_repo',
        arguments: { id: TASK.repoId },
      });
      const canonicalRepo = RepoResponseSchema.parse(repoRead.structuredContent);
      assert.equal(canonicalRepo.defaultBranch, 'master');
      const repoPage = await client.callTool({
        name: 'list_repos',
        arguments: { limit: 10 },
      });
      assert.deepEqual(
        V1ListReposResponseSchema.parse(repoPage.structuredContent).items,
        [canonicalRepo],
        'list_repos and get_repo preserve the same verified branch projection',
      );
    } finally {
      releaseProvision.resolve();
      await Promise.all(providerOperations);
      await client.close();
      await server.close();
    }
  },
);

test('create_task rejects a non-UUID repo id through the shared /v1 schema', async () => {
  let called = false;
  const deps = {
    async createTask() {
      called = true;
      return TASK;
    },
  } as unknown as McpToolDeps;
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  await expectPublicToolError(
    () =>
      tools.get('create_task')!(
        { repoId: 'repo-not-a-uuid', prompt: 'go' },
        extraWith(['tasks:write']),
      ),
    'validation_failed',
    /uuid/i,
  );
  assert.equal(called, false);
});

test('create_task reuses the full /v1 body and forwards every execution field', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const deps: McpToolDeps = {
    async createTask(_repoId: string, body: CreateTaskBody) {
      capturedBody = body as unknown as Record<string, unknown>;
      return TASK;
    },
  } as unknown as McpToolDeps;
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  await tools.get('create_task')!(
    {
      repoId: TASK.repoId,
      prompt: 'go',
      branch: 'main',
      strategy: 'careful',
      skills: ['openspec'],
      deadlineMs: 120_000,
      idleTimeoutMs: 60_000,
      runtime: 'codex',
      model: 'provider:model-v1',
      sandboxEnvironmentId: '00000000-0000-4000-a000-000000000099',
      deliver: 'pr',
    },
    extraWith(['tasks:write']),
  );
  assert.deepEqual(capturedBody, {
    prompt: 'go',
    branch: 'main',
    strategy: 'careful',
    skills: ['openspec'],
    deadlineMs: 120_000,
    idleTimeoutMs: 60_000,
    runtime: 'codex',
    model: 'provider:model-v1',
    sandboxEnvironmentId: '00000000-0000-4000-a000-000000000099',
    deliver: 'pr',
  });
});

test('list tools enforce the /v1 limit bound and return paginated structured envelopes', async () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);
  const full = extraWithOwner(['tasks:read', 'repos:read']);

  for (const name of ['list_tasks', 'list_repos', 'list_schedules']) {
    await expectPublicToolError(
      () => tools.get(name)!({ limit: 201 }, full),
      'validation_failed',
      /less than or equal to 200/i,
    );
  }
  await expectPublicToolError(
    () => tools.get('list_schedule_runs')!({ id: SCHEDULE_ID, limit: 201 }, full),
    'validation_failed',
    /less than or equal to 200/i,
  );

  const taskResult = (await tools.get('list_tasks')!({ limit: 200 }, full)) as {
    structuredContent: Record<string, unknown>;
  };
  const repoResult = (await tools.get('list_repos')!({ limit: 200 }, full)) as {
    structuredContent: Record<string, unknown>;
  };
  const scheduleResult = (await tools.get('list_schedules')!(
    { limit: 200 },
    full,
  )) as { structuredContent: Record<string, unknown> };
  const runResult = (await tools.get('list_schedule_runs')!(
    { id: SCHEDULE_ID, limit: 200 },
    full,
  )) as { structuredContent: Record<string, unknown> };

  assert.doesNotThrow(() =>
    V1ListTasksResponseSchema.parse(taskResult.structuredContent),
  );
  assert.doesNotThrow(() =>
    V1ListReposResponseSchema.parse(repoResult.structuredContent),
  );
  assert.doesNotThrow(() =>
    V1ListSchedulesResponseSchema.parse(scheduleResult.structuredContent),
  );
  assert.doesNotThrow(() =>
    V1ListScheduleRunsResponseSchema.parse(runResult.structuredContent),
  );
});

// ---------------------------------------------------------------------------
// 4. Inert when the toggle is off (task 4.3 / 4.4).
// ---------------------------------------------------------------------------

function fakeRes(): {
  res: import('express').Response;
  state: {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
    ended: boolean;
  };
} {
  const state: {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
    ended: boolean;
  } = { headers: {}, ended: false };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    set(field: string, value: string) {
      state.headers[field] = value;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      state.ended = true;
      return this;
    },
    on() {
      return this;
    },
  } as unknown as import('express').Response;
  return { res, state };
}

test('with mcpServerEnabled=false the /mcp endpoint is INERT (no transport)', async () => {
  let serverTouched = false;
  const factory = {
    createServer() {
      serverTouched = true;
      throw new Error('server must not be connected when the toggle is off');
    },
  } as unknown as McpServerFactory;

  const prisma = {
    systemSettings: {
      async findUnique() {
        return { mcpServerEnabled: false };
      },
    },
  } as unknown as PrismaService;

  const controller = new McpController(factory, prisma);
  const { res, state } = fakeRes();

  await controller.handlePost(
    { body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } } as never,
    res,
  );

  assert.equal(serverTouched, false, 'no MCP server/transport is connected when off');
  assert.equal(state.status, 503, 'a clear disabled response');
  assert.equal(
    (state.body as { error?: { message?: string } }).error?.message,
    'MCP server is disabled',
  );
});

test('with no SystemSettings row the POST /mcp endpoint defaults to INERT (off)', async () => {
  const factory = {
    createServer() {
      throw new Error('must not connect when the row is absent (default off)');
    },
  } as unknown as McpServerFactory;

  const prisma = {
    systemSettings: {
      async findUnique() {
        return null; // no singleton row yet
      },
    },
  } as unknown as PrismaService;

  const controller = new McpController(factory, prisma);
  const { res, state } = fakeRes();

  await controller.handlePost(
    { body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } } as never,
    res,
  );

  assert.equal(state.status, 503, 'default-off: a missing row reads as disabled');
});

// ---------------------------------------------------------------------------
// 5. Stateless method handling (fix-mcp-stateless-get-405): GET/DELETE → 405,
//    independent of the enable toggle. The stateless endpoint serves POST only;
//    routing GET to the transport opens an empty SSE stream that hangs and breaks
//    a real MCP client's handshake. 405 is a method-layer verdict — it connects
//    NO transport, does NOT read the toggle, and returns synchronously.
// ---------------------------------------------------------------------------

test('GET /mcp returns 405 without opening a transport or reading the toggle', () => {
  let serverTouched = false;
  const factory = {
    createServer() {
      serverTouched = true;
      throw new Error('GET must not connect a transport');
    },
  } as unknown as McpServerFactory;
  const prisma = {
    systemSettings: {
      async findUnique() {
        throw new Error('GET 405 must not consult the enable toggle');
      },
    },
  } as unknown as PrismaService;

  const controller = new McpController(factory, prisma);
  const { res, state } = fakeRes();

  controller.handleGet(res);

  assert.equal(serverTouched, false, 'GET opens no transport');
  assert.equal(state.status, 405, 'GET is 405 Method Not Allowed');
  assert.equal(state.headers['Allow'], 'POST', 'advertises Allow: POST');
  assert.equal(state.ended, true, 'responds synchronously (no hang)');
  const body = state.body as {
    jsonrpc?: string;
    error?: { message?: string };
    id?: unknown;
  };
  assert.equal(body.jsonrpc, '2.0', 'JSON-RPC error envelope');
  assert.equal(body.id, null);
  assert.match(String(body.error?.message), /POST only/);
});

test('DELETE /mcp returns 405 (same method-layer verdict as GET)', () => {
  let serverTouched = false;
  const factory = {
    createServer() {
      serverTouched = true;
      throw new Error('DELETE must not connect a transport');
    },
  } as unknown as McpServerFactory;
  const prisma = {
    systemSettings: {
      async findUnique() {
        throw new Error('DELETE 405 must not consult the enable toggle');
      },
    },
  } as unknown as PrismaService;

  const controller = new McpController(factory, prisma);
  const { res, state } = fakeRes();

  controller.handleDelete(res);

  assert.equal(serverTouched, false, 'DELETE opens no transport');
  assert.equal(state.status, 405, 'DELETE is 405 Method Not Allowed');
  assert.equal(state.headers['Allow'], 'POST', 'advertises Allow: POST');
  assert.equal(state.ended, true, 'responds synchronously (no hang)');
});
