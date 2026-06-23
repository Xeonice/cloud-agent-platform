/**
 * MCP tool definitions (remote-mcp-server, Track `mcp-endpoint-tools`, task 4.2).
 *
 * The SIX tools the `/mcp` server advertises, each delegating to the EXISTING
 * console services (one admission path, design D4) with a per-tool scope gate:
 *
 *   - `create_task`    (`tasks:write`) — returns a handle (id + status) IMMEDIATELY,
 *                                        never blocks for the run (D4 / spec).
 *   - `get_task`       (`tasks:read`)  — fetch one task by id.
 *   - `list_tasks`     (`tasks:read`)  — list the shared pool.
 *   - `stop_task`      (`tasks:write`) — operator stop (terminal `cancelled`).
 *   - `get_transcript` (`tasks:read`)  — the DURABLE session-history read.
 *   - `list_repos`     (`repos:read`)  — the repo read surface.
 *
 * SCOPE GATING. Every `/mcp` request is first validated by the SDK
 * `requireBearerAuth` → `resolveMcpToken` (registered in `main.ts`, Track 7), which
 * attaches the resolved {@link import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo}
 * (carrying the token's granted `scopes`) onto the request. The SDK threads that
 * `AuthInfo` into each tool callback as `extra.authInfo`, so a tool reads the
 * SAME scopes the resolved `mcp` principal carries and enforces its required scope
 * BEFORE acting. A missing scope yields an MCP error with 403-semantics
 * ({@link scopeError}) and performs NO state change — the parallel of the REST
 * controllers' `403 insufficient scope` (distinct from the 401 a missing bearer
 * gets at the transport boundary).
 *
 * NO FORK. The tools call the same {@link McpToolDeps} surface the console/`/v1`
 * use; there is no standalone provisioning path (no `start_sandbox`), and the raw
 * PTY/WebSocket terminal stream is NEVER exposed via a tool — only durable,
 * already-archived transcript text is read.
 *
 * This module is PURE registration logic: it takes an `McpServer` and a narrow
 * `McpToolDeps` port, so the verify-phase tests drive the tool callbacks directly
 * (fake deps + a synthesized `extra`) with no Nest DI container and no DB.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import type { Scope } from '@cap/contracts';
import type {
  CreateTaskBody,
  RepoResponse,
  SessionHistory,
  TaskResponse,
} from '@cap/contracts';

/**
 * The NARROW slice of `McpServer.registerTool` the tools use. Declared as a local
 * structural interface — rather than referencing the SDK's `McpServer` generic —
 * deliberately: the SDK's `registerTool` overload (zod v3.25 + TS 5.9) trips
 * `TS2589 "type instantiation is excessively deep"` when its `ZodRawShape`/
 * `ToolCallback` conditional generics are instantiated inline for each tool. This
 * port describes the EXACT call shape with plain types, so registration type-checks
 * without that pathological inference; the real `McpServer` (structurally
 * compatible) is passed at the single call site in `mcp.server.ts`. Runtime
 * behaviour is identical — the real `registerTool` runs.
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: z.ZodRawShape;
    },
    cb: (...args: never[]) => unknown,
  ): unknown;
}

/**
 * The narrow service surface the tools delegate to — every method is already
 * implemented by an EXISTING console service (no second admission path):
 *
 *   - `createTask` → `TasksService.create(repoId, body, userId?)` (the console
 *     path: persist the row then offer to the guardrails semaphore — it returns a
 *     handle WITHOUT waiting for the run to finish);
 *   - `getTask` / `listTasks` / `stopTask` → `TasksService.findById|list|stop`;
 *   - `getTranscript` → the durable session-history read (durable-first, container
 *     fallback) the `/v1` transcript + console session-history surfaces share;
 *   - `listRepos` → `ReposService.list`.
 *
 * Modelling the deps as this port (rather than the concrete Nest services) keeps
 * the registration pure and unit-testable; `McpServerFactory` binds it to the
 * real services.
 */
export interface McpToolDeps {
  createTask(
    repoId: string,
    body: CreateTaskBody,
    userId?: string,
  ): Promise<TaskResponse>;
  getTask(id: string): Promise<TaskResponse>;
  listTasks(): Promise<TaskResponse[]>;
  stopTask(id: string, userId?: string): Promise<TaskResponse>;
  getTranscript(id: string): Promise<SessionHistory>;
  listRepos(): Promise<RepoResponse[]>;
}

/**
 * The slice of the SDK request-handler `extra` a tool reads: the resolved
 * `authInfo` (present on every `/mcp` request because `requireBearerAuth` ran
 * first). Narrowed so the tests can synthesize it without the full SDK extra.
 */
export interface ToolExtra {
  readonly authInfo?: AuthInfo;
}

/**
 * Enforce that the resolved token carries `required`, else throw an MCP error
 * with 403-semantics. The `mcp` principal's scopes arrive on `extra.authInfo`
 * (the SDK threads the `requireBearerAuth` result through); an ABSENT `authInfo`
 * is fail-closed (the transport should never reach a tool without it, since the
 * bearer middleware 401s first). Unlike the REST surface there is no scopeless
 * allow-all principal here — every `/mcp` caller is a scoped `mcp_` token — so a
 * tool is gated strictly by `scopes.includes(required)`.
 */
export function requireScope(extra: ToolExtra, required: Scope): void {
  const scopes = extra.authInfo?.scopes;
  if (!Array.isArray(scopes) || !scopes.includes(required)) {
    throw scopeError(required);
  }
}

/**
 * An MCP error with 403-semantics for a missing scope. Uses the JSON-RPC
 * `InvalidParams` code (the SDK's closest analogue to an authorization refusal at
 * the application layer — the transport-level 401 is owned by `requireBearerAuth`)
 * and a message naming the required scope, mirroring the REST
 * `Insufficient scope: <scope> required`.
 */
export function scopeError(required: Scope): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `Insufficient scope: ${required} required (403)`,
  );
}

/** Wrap a value as the MCP tool text result the clients render. */
function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Register the six tools on `server`, delegating to `deps` with per-tool scope
 * gates. Called ONCE per `McpServer` (the server is built once and reused across
 * stateless transports, task 4.1).
 *
 * `userIdOf(extra)` resolves the acting operator's ACCOUNT primary key (`users.id`)
 * from the resolved token (for audit attribution on create/stop, and so the
 * owner-scoped Codex credential resolves — fix-local-account-task-attribution); it
 * is best-effort — a token whose `AuthInfo` carries no owner account id simply
 * attributes the action to no id, exactly as a scopeless legacy principal does on
 * the REST path. The account id (not the GitHub numeric id) is threaded so a LOCAL
 * account's MCP task is owner-attributed too.
 */
export function registerMcpTools(
  server: ToolRegistrar,
  deps: McpToolDeps,
  userIdOf: (extra: ToolExtra) => string | undefined = () => undefined,
): void {
  // --- create_task (tasks:write) — IMMEDIATE handle, never blocks (D4) ---------
  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'Create a sandbox task on a repo. Returns the task handle (id + status) ' +
        'immediately; provisioning proceeds asynchronously through the same ' +
        'admission the console uses. Poll get_task to a terminal status, then ' +
        'read get_transcript. Requires the tasks:write scope.',
      inputSchema: {
        repoId: z.string().min(1).describe('The repo id to run the task against.'),
        prompt: z.string().min(1).describe('The task prompt for the agent.'),
        branch: z.string().min(1).optional(),
        strategy: z.string().min(1).optional(),
        runtime: z.enum(['claude-code', 'codex']).optional(),
        deliver: z
          .enum(['none', 'branch', 'pr'])
          .optional()
          .describe(
            'Where the completed task delivers its edits: none (default), branch (push cap/task-<id>), or pr (push + open a PR/MR on the repo forge).',
          ),
      },
    },
    async (
      { repoId, ...body }: { repoId: string; prompt: string } & Partial<CreateTaskBody>,
      extra: ToolExtra,
    ) => {
      requireScope(extra, 'tasks:write');
      // Delegate to the SAME admission path the console uses. `create` persists
      // the row then OFFERS the task to the guardrails semaphore and returns the
      // handle — it does NOT await the (minutes-long) run, so the tool call never
      // blocks on completion (spec: "create_task returns a handle without
      // blocking").
      const task = await deps.createTask(
        repoId,
        body as CreateTaskBody,
        userIdOf(extra),
      );
      return jsonResult({ id: task.id, status: task.status, task });
    },
  );

  // --- get_task (tasks:read) ---------------------------------------------------
  server.registerTool(
    'get_task',
    {
      title: 'Get a task',
      description:
        'Fetch one task by id (the polling floor — every status transition is ' +
        'durably persisted before the response). Requires the tasks:read scope.',
      inputSchema: {
        id: z.string().min(1).describe('The task id.'),
      },
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      return jsonResult(await deps.getTask(id));
    },
  );

  // --- list_tasks (tasks:read) -------------------------------------------------
  // A zero-argument tool: omit `inputSchema` entirely so the SDK types the
  // callback as `(extra)` (an empty `inputSchema: {}` would instead make it
  // `(args, extra)`).
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks in the shared pool. Requires the tasks:read scope.',
    },
    async (extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      return jsonResult(await deps.listTasks());
    },
  );

  // --- stop_task (tasks:write) -------------------------------------------------
  server.registerTool(
    'stop_task',
    {
      title: 'Stop a task',
      description:
        'Stop a running task (terminal cancelled + teardown). Idempotent for an ' +
        'already-terminal task. Requires the tasks:write scope.',
      inputSchema: {
        id: z.string().min(1).describe('The task id to stop.'),
      },
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      return jsonResult(await deps.stopTask(id, userIdOf(extra)));
    },
  );

  // --- get_transcript (tasks:read) — durable session-history, NEVER the raw PTY -
  server.registerTool(
    'get_transcript',
    {
      title: 'Get a task transcript',
      description:
        'Read the durable session transcript for a finished task (durable-first, ' +
        'container fallback). Never exposes the live PTY/WebSocket stream. ' +
        'Requires the tasks:read scope.',
      inputSchema: {
        id: z.string().min(1).describe('The task id whose transcript to read.'),
      },
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      return jsonResult(await deps.getTranscript(id));
    },
  );

  // --- list_repos (repos:read) -------------------------------------------------
  // Zero-argument tool: omit `inputSchema` so the callback is typed `(extra)`.
  server.registerTool(
    'list_repos',
    {
      title: 'List repos',
      description:
        'List the configured repos a task can run against. Requires the ' +
        'repos:read scope.',
    },
    async (extra: ToolExtra) => {
      requireScope(extra, 'repos:read');
      return jsonResult(await deps.listRepos());
    },
  );
}
