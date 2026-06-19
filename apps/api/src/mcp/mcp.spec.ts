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

import {
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
} from './mcp-tools';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.server';
import { PrismaService } from '../prisma/prisma.service';
import type { TaskResponse, RepoResponse, SessionHistory } from '@cap/contracts';

// ---------------------------------------------------------------------------
// Fakes: a server that captures (name -> callback), and recording deps.
// ---------------------------------------------------------------------------

type ToolCb = (args: Record<string, unknown>, extra: ToolExtra) => Promise<unknown>;

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
} {
  const tools = new Map<string, ToolCb>();
  const server = {
    registerTool(name: unknown, _config: unknown, cb: unknown) {
      const fn = cb as (...a: unknown[]) => Promise<unknown>;
      // A zero-arg tool's callback is `(extra)`; an arg tool's is `(args, extra)`.
      const wrapped: ToolCb =
        fn.length <= 1
          ? (_args, extra) => fn(extra)
          : (args, extra) => fn(args, extra);
      tools.set(name as string, wrapped);
    },
  };
  return { server, tools };
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
} as RepoResponse;

const TRANSCRIPT: SessionHistory = { status: 'expired' } as SessionHistory;

/** Recording deps so a test can assert exactly which service method ran. */
function recordingDeps(): { deps: McpToolDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: McpToolDeps = {
    async createTask(repoId, body, githubId) {
      calls.push(`createTask:${repoId}:${body.prompt}:${githubId ?? '-'}`);
      return TASK;
    },
    async getTask(id) {
      calls.push(`getTask:${id}`);
      return TASK;
    },
    async listTasks() {
      calls.push('listTasks');
      return [TASK];
    },
    async stopTask(id, githubId) {
      calls.push(`stopTask:${id}:${githubId ?? '-'}`);
      return TASK;
    },
    async getTranscript(id) {
      calls.push(`getTranscript:${id}`);
      return TRANSCRIPT;
    },
    async listRepos() {
      calls.push('listRepos');
      return [REPO];
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

// ---------------------------------------------------------------------------
// 1. Scope gates (task 4.4) — a tasks:read-only principal is denied writes.
// ---------------------------------------------------------------------------

test('a tasks:read-only mcp principal is DENIED create_task and stop_task', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const readOnly = extraWith(['tasks:read', 'repos:read']);

  await assert.rejects(
    () => tools.get('create_task')!({ repoId: 'r1', prompt: 'go' }, readOnly),
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
  await tools.get('create_task')!({ repoId: 'r1', prompt: 'go' }, writer);
  await tools.get('stop_task')!({ id: 't1' }, writer);

  assert.deepEqual(calls, ['createTask:r1:go:-', 'stopTask:t1:-']);
});

test('the read tools gate on their read scopes', async () => {
  const { deps } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  // tasks:read gates get_task / list_tasks / get_transcript; repos:read gates list_repos.
  const noScopes = extraWith([]);
  for (const name of ['get_task', 'list_tasks', 'get_transcript', 'list_repos']) {
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

// ---------------------------------------------------------------------------
// 2 + 3. One admission path + immediate handle (task 4.4).
// ---------------------------------------------------------------------------

test('tools dispatch to the same service surface the console uses', async () => {
  const { deps, calls } = recordingDeps();
  const { server, tools } = captureServer();
  registerMcpTools(server as never, deps);

  const full = extraWith(['tasks:read', 'tasks:write', 'repos:read']);
  await tools.get('get_task')!({ id: 't1' }, full);
  await tools.get('list_tasks')!({}, full);
  await tools.get('get_transcript')!({ id: 't1' }, full);
  await tools.get('list_repos')!({}, full);

  assert.deepEqual(calls, [
    'getTask:t1',
    'listTasks',
    'getTranscript:t1',
    'listRepos',
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
    { repoId: 'r1', prompt: 'go' },
    extraWith(['tasks:write']),
  )) as { content: Array<{ text: string }> };

  const payload = JSON.parse(result.content[0].text) as {
    id: string;
    status: string;
  };
  assert.equal(payload.id, TASK.id, 'returns the task id immediately');
  assert.equal(payload.status, 'pending', 'returns the handle status immediately');
  assert.equal(runResolved, false, 'did NOT wait for the run to complete');
});

// ---------------------------------------------------------------------------
// 4. Inert when the toggle is off (task 4.3 / 4.4).
// ---------------------------------------------------------------------------

function fakeRes(): {
  res: import('express').Response;
  state: { status?: number; body?: unknown; ended: boolean };
} {
  const state: { status?: number; body?: unknown; ended: boolean } = {
    ended: false,
  };
  const res = {
    status(code: number) {
      state.status = code;
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
    getServer() {
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

test('with no SystemSettings row the /mcp endpoint defaults to INERT (off)', async () => {
  const factory = {
    getServer() {
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

  await controller.handleGet(
    { body: undefined } as never,
    res,
  );

  assert.equal(state.status, 503, 'default-off: a missing row reads as disabled');
});
