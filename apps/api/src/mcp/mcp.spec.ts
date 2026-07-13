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
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
  type ToolRegistrar,
} from './mcp-tools';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.server';
import { PrismaService } from '../prisma/prisma.service';
import {
  DispatchScheduleRequestSchema,
  PUBLIC_V1_OPERATIONS,
  ScheduleRecurrenceSchema,
  ScheduleResponseSchema,
  SessionHistorySchema,
  TaskResponseSchema,
  V1CreateTaskRequestSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ListTasksResponseSchema,
  V1ListReposResponseSchema,
  type CreateTaskBody,
  type CreateScheduleRequest,
  type RepoResponse,
  type ScheduleResponse,
  type ScheduleRunResponse,
  type SessionHistory,
  type TaskResponse,
  type UpdateScheduleRequest,
} from '@cap/contracts';

// ---------------------------------------------------------------------------
// Fakes: a server that captures (name -> callback), and recording deps.
// ---------------------------------------------------------------------------

type ToolCb = (args: Record<string, unknown>, extra: ToolExtra) => Promise<unknown>;
type ToolConfig = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: unknown;
};

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

/** Recording deps so a test can assert exactly which service method ran. */
function recordingDeps(): { deps: McpToolDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: McpToolDeps = {
    async createTask(repoId, body, userId) {
      calls.push(`createTask:${repoId}:${body.prompt}:${userId ?? '-'}`);
      return TASK;
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

  await assert.rejects(
    () => tools.get('create_task')!({ repoId: TASK.repoId, prompt: 'go' }, readOnly),
    (err: unknown) =>
      err instanceof McpError &&
      /tasks:write required \(403\)/.test((err as McpError).message),
    'create_task without tasks:write is an MCP 403-semantics error',
  );

  await assert.rejects(
    () => tools.get('stop_task')!({ id: 't1' }, readOnly),
    (err: unknown) => err instanceof McpError,
    'stop_task without tasks:write is an MCP 403-semantics error',
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
  await tools.get('stop_task')!({ id: 't1' }, writer);

  assert.deepEqual(calls, [
    `createTask:${TASK.repoId}:go:-`,
    'stopTask:t1:-',
  ]);
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
  await tools.get('stop_task')!({ id: 't1' }, localOwner);

  assert.deepEqual(
    calls,
    [
      `createTask:${TASK.repoId}:go:local-acct-1`,
      'stopTask:t1:local-acct-1',
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
    await assert.rejects(
      () => tools.get(name)!({ id: 'x' }, noScopes),
      (err: unknown) => err instanceof McpError,
      `${name} is denied without its read scope`,
    );
  }

  // list_repos specifically needs repos:read (tasks:read alone is insufficient).
  await assert.rejects(
    () => tools.get('list_repos')!({}, extraWith(['tasks:read'])),
    (err: unknown) => err instanceof McpError,
    'list_repos requires repos:read, not tasks:read',
  );
});

test('the MCP server registers the complete task, repo, and schedule tool surface', () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  assert.deepEqual([...tools.keys()], [
    'create_task',
    'get_task',
    'list_tasks',
    'stop_task',
    'get_transcript',
    'list_repos',
    'get_repo',
    'create_schedule',
    'list_schedules',
    'get_schedule',
    'update_schedule',
    'pause_schedule',
    'resume_schedule',
    'dispatch_schedule',
    'delete_schedule',
    'list_schedule_runs',
  ]);
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
    PUBLIC_V1_OPERATIONS.filter((operation) => 'excluded' in operation.mcp).map(
      (operation) => operation.id,
    ),
    ['tasks.events'],
    'SSE is the only explicit MCP transport exclusion',
  );
});

test('the REST-only task idempotency header is an explicit MCP protocol difference', () => {
  const mappedOperationsWithHeaders = PUBLIC_V1_OPERATIONS.filter(
    (operation) => 'tool' in operation.mcp && operation.headersSchema,
  ).map((operation) => ({
    operation: operation.id,
    headers: Object.keys(operation.headersSchema?.shape ?? {}).sort(),
  }));

  assert.deepEqual(mappedOperationsWithHeaders, [
    { operation: 'tasks.create', headers: ['Idempotency-Key'] },
  ]);
});

test('every MCP tool advertises structured output and create_task reuses the /v1 input shape', () => {
  const { deps } = recordingDeps();
  const { server, configs } = captureServer();
  registerMcpTools(server as never, deps);

  assert.deepEqual(
    Object.keys(configs.get('create_task')?.inputSchema ?? {}).sort(),
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
  assert.deepEqual(
    Object.keys(configs.get('dispatch_schedule')?.inputSchema ?? {}).sort(),
    ['expectedPeriodKey', 'id'],
    'dispatch_schedule advertises the canonical optional period key',
  );
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
    for (const interval of [5, 10, 15, 30]) {
      assert.match(config.description ?? '', new RegExp(`\\b${interval}\\b`));
    }
    const recurrence = config.inputSchema?.recurrence as
      | { parse(value: unknown): unknown }
      | undefined;
    assert.ok(recurrence, `${name} advertises the shared recurrence field`);
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

test('the real MCP SDK advertises and validates structured list output', async () => {
  const { deps } = recordingDeps();
  const server = new McpServer({ name: 'mcp-parity-test', version: '1.0.0' });
  registerMcpTools(server as unknown as ToolRegistrar, deps);
  const client = new Client({ name: 'mcp-parity-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: 'mcp_test',
        clientId: 'settings',
        scopes: ['tasks:read', 'tasks:write'],
        expiresAt: Math.floor(Date.now() / 1000) + 3_600,
        extra: { userId: 'local-acct-1' },
      },
    });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = await client.listTools();
    const listTool = advertised.tools.find((tool) => tool.name === 'list_tasks');
    assert.ok(listTool?.outputSchema, 'tools/list includes the structured output schema');

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
    prisma,
    {} as never,
    {} as never,
    {} as never,
  );

  const page = await factory.listTasks({ limit: 10 });

  assert.equal(page.items[0].failure?.runtime, 'claude-code');
  assert.equal(page.items[0].failure?.code, 'runtime_auth_expired');
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
    await assert.rejects(
      () => tools.get(name)!({ id: SCHEDULE_ID }, readOnly),
      (err: unknown) =>
        err instanceof McpError && /tasks:write required \(403\)/.test(err.message),
    );
  }
  for (const name of ['list_schedules', 'get_schedule', 'list_schedule_runs']) {
    await assert.rejects(
      () => tools.get(name)!({ id: SCHEDULE_ID }, noScopes),
      (err: unknown) =>
        err instanceof McpError && /tasks:read required \(403\)/.test(err.message),
    );
  }
  assert.deepEqual(calls, []);
});

test('every schedule tool requires authInfo.extra.userId before calling the service', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  for (const name of ['list_schedules', 'get_schedule', 'list_schedule_runs']) {
    await assert.rejects(
      () => tools.get(name)!({ id: SCHEDULE_ID }, extraWith(['tasks:read'])),
      (err: unknown) =>
        err instanceof McpError && /account owner \(403\)/.test(err.message),
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
    await assert.rejects(
      () => tools.get(name)!({ id: SCHEDULE_ID }, extraWith(['tasks:write'])),
      (err: unknown) =>
        err instanceof McpError && /account owner \(403\)/.test(err.message),
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
  await assert.rejects(
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
    /Invalid input/,
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

  await assert.rejects(
    () =>
      tools.get('create_schedule')!(
        {
          recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
          cronExpression: '0 9 * * *',
          taskTemplate: { repoId: TASK.repoId, prompt: 'daily check' },
        },
        owner,
      ),
    /Provide recurrence or cronExpression, not both/,
  );
  await assert.rejects(
    () => tools.get('update_schedule')!({ id: SCHEDULE_ID }, owner),
    /At least one schedule field must be provided/,
  );
  await assert.rejects(
    () =>
      tools.get('dispatch_schedule')!(
        { id: SCHEDULE_ID, expectedPeriodKey: '' },
        owner,
      ),
    /Invalid schedule period identity/,
  );
  assert.deepEqual(DispatchScheduleRequestSchema.parse({}), {});
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// 2 + 3. One admission path + immediate handle (task 4.4).
// ---------------------------------------------------------------------------

test('tools dispatch to the same service surface the console uses', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const full = extraWith(['tasks:read', 'tasks:write', 'repos:read']);
  await tools.get('get_task')!({ id: 't1' }, full);
  await tools.get('list_tasks')!({ limit: 20, cursor: 'task-next' }, full);
  await tools.get('get_transcript')!({ id: 't1' }, full);
  await tools.get('list_repos')!({ limit: 30, cursor: 'repo-next' }, full);
  await tools.get('get_repo')!({ id: REPO.id }, full);

  assert.deepEqual(calls, [
    'getTask:t1',
    'listTasks:20:task-next',
    'getTranscript:t1',
    'listRepos:30:repo-next',
    `getRepo:${REPO.id}`,
  ]);
});

test('create_task returns a handle WITHOUT blocking on the run', async () => {
  // A createTask whose underlying run NEVER resolves: the dep returns the handle
  // immediately (the console admission path: persist row + offer to the semaphore,
  // do not await the run). The tool must resolve with the handle regardless.
  let runResolved = false;
  const deps: McpToolDeps = {
    async createTask() {
      // The handle returns now; the (simulated) run would resolve later — we never
      // let it, and assert the tool STILL returns.
      void new Promise<void>((resolve) => {
        setTimeout(() => {
          runResolved = true;
          resolve();
        }, 1_000_000);
      });
      return TASK;
    },
  } as unknown as McpToolDeps;

  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const result = (await tools.get('create_task')!(
    { repoId: TASK.repoId, prompt: 'go' },
    extraWith(['tasks:write']),
  )) as {
    content: Array<{ text: string }>;
    structuredContent: Record<string, unknown>;
  };

  const payload = JSON.parse(result.content[0].text) as {
    id: string;
    status: string;
    task: typeof TASK;
  };
  assert.equal(payload.id, TASK.id, 'returns the task id immediately');
  assert.equal(payload.status, 'pending', 'returns the handle status immediately');
  assert.doesNotThrow(() => TaskResponseSchema.parse(result.structuredContent));
  assert.deepEqual(
    result.structuredContent,
    JSON.parse(JSON.stringify(TASK)),
    'structuredContent matches the canonical /v1 task response',
  );
  assert.deepEqual(
    payload.task,
    JSON.parse(JSON.stringify(TASK)),
    'legacy text keeps the historical wrapper',
  );
  assert.equal(runResolved, false, 'did NOT wait for the run to complete');
});

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

  await assert.rejects(
    () =>
      tools.get('create_task')!(
        { repoId: 'repo-not-a-uuid', prompt: 'go' },
        extraWith(['tasks:write']),
      ),
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
    await assert.rejects(
      () => tools.get(name)!({ limit: 201 }, full),
      /less than or equal to 200/i,
    );
  }
  await assert.rejects(
    () => tools.get('list_schedule_runs')!({ id: SCHEDULE_ID, limit: 201 }, full),
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
