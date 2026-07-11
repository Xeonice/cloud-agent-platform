/**
 * MCP tool definitions (remote-mcp-server, Track `mcp-endpoint-tools`, task 4.2).
 *
 * The tools the `/mcp` server advertises, each delegating to the EXISTING
 * console services (one admission path, design D4) with a per-tool scope gate:
 *
 *   - `create_task`    (`tasks:write`) — returns a handle (id + status) IMMEDIATELY,
 *                                        never blocks for the run (D4 / spec).
 *   - `get_task`       (`tasks:read`)  — fetch one task by id.
 *   - `list_tasks`     (`tasks:read`)  — list the shared pool.
 *   - `stop_task`      (`tasks:write`) — operator stop (terminal `cancelled`).
 *   - `get_transcript` (`tasks:read`)  — the DURABLE session-history read.
 *   - `list_repos` / `get_repo` (`repos:read`) — the repo read surface.
 *   - schedule tools   (`tasks:read` / `tasks:write`) — owner-scoped schedule
 *                                               management and immediate dispatch.
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
import {
  CreateScheduleRequestSchema,
  CreateTaskRequestSchema,
  DispatchScheduleRequestSchema,
  RepoResponseSchema,
  ScheduleCronExpressionSchema,
  ScheduleMisfirePolicySchema,
  ScheduleOverlapPolicySchema,
  ScheduleRecurrenceSchema,
  ScheduleResponseSchema,
  ScheduleTimezoneSchema,
  SessionHistoryEmptyReasonSchema,
  SessionHistoryMetaSchema,
  SessionTurnSchema,
  TaskResponseSchema,
  UpdateScheduleRequestSchema,
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListReposResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListTasksResponseSchema,
  V1ScheduleListQuerySchema,
  type CreateScheduleRequest,
  type CreateTaskBody,
  type DispatchScheduleRequest,
  type RepoResponse,
  type ScheduleResponse,
  type SessionHistory,
  type TaskResponse,
  type UpdateScheduleRequest,
  type V1ListQuery,
  type V1ListReposResponse,
  type V1ListSchedulesResponse,
  type V1ListScheduleRunsResponse,
  type V1ListTasksResponse,
  type V1ScheduleListQuery,
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
      outputSchema?: z.ZodRawShape | z.ZodTypeAny;
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
 *   - `listRepos` / `getRepo` → the same repo reads and keyset page as `/v1`.
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
  listTasks(query: V1ListQuery): Promise<V1ListTasksResponse>;
  stopTask(id: string, userId?: string): Promise<TaskResponse>;
  getTranscript(id: string): Promise<SessionHistory>;
  listRepos(query: V1ListQuery): Promise<V1ListReposResponse>;
  getRepo(id: string): Promise<RepoResponse>;
  createSchedule(
    ownerUserId: string,
    body: CreateScheduleRequest,
  ): Promise<ScheduleResponse>;
  listSchedules(
    ownerUserId: string,
    query: V1ScheduleListQuery,
  ): Promise<V1ListSchedulesResponse>;
  getSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  updateSchedule(
    ownerUserId: string,
    id: string,
    body: UpdateScheduleRequest,
  ): Promise<ScheduleResponse>;
  pauseSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  resumeSchedule(ownerUserId: string, id: string): Promise<ScheduleResponse>;
  dispatchSchedule(
    ownerUserId: string,
    id: string,
    body: DispatchScheduleRequest,
  ): Promise<ScheduleResponse>;
  deleteSchedule(ownerUserId: string, id: string): Promise<void>;
  listScheduleRuns(
    ownerUserId: string,
    id: string,
    query: V1ScheduleListQuery,
  ): Promise<V1ListScheduleRunsResponse>;
}

/**
 * The slice of the SDK request-handler `extra` a tool reads: the resolved
 * `authInfo` (present on every `/mcp` request because `requireBearerAuth` ran
 * first). Narrowed so the tests can synthesize it without the full SDK extra.
 */
export interface ToolExtra {
  readonly authInfo?: AuthInfo;
}

/** Resolve the MCP token owner's account primary key from SDK request metadata. */
export function userIdFromExtra(extra: ToolExtra): string | undefined {
  const raw = (extra.authInfo?.extra as { userId?: unknown } | undefined)?.userId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
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

/** Schedule definitions always execute with the MCP token owner's account. */
function requireOwner(
  extra: ToolExtra,
  userIdOf: (extra: ToolExtra) => string | undefined,
): string {
  const userId = userIdOf(extra);
  if (userId) return userId;
  throw new McpError(
    ErrorCode.InvalidParams,
    'Schedule tools require an authenticated account owner (403)',
  );
}

/** Wrap a value as the MCP tool text result the clients render. */
function jsonResult(
  value: unknown,
  structuredValue: unknown = value,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: jsonObject(structuredValue),
  };
}

/** MCP structured content must be a JSON object; normalize Dates and omit undefined. */
function jsonObject(value: unknown): Record<string, unknown> {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new TypeError('MCP structured content must be a JSON object');
  }
  return normalized as Record<string, unknown>;
}

const scheduleIdSchema = ScheduleResponseSchema.shape.id.describe('The schedule id.');
const taskIdSchema = TaskResponseSchema.shape.id.describe('The task id.');
const repoIdSchema = RepoResponseSchema.shape.id.describe('The repo id.');
const scheduleTaskTemplateInputSchema = CreateTaskRequestSchema.extend({
  repoId: z.string().uuid().describe('The repo id the scheduled task runs against.'),
});

const createScheduleInputSchema = {
  name: z.string().trim().min(1).max(120).nullable().optional(),
  recurrence: ScheduleRecurrenceSchema.optional(),
  cronExpression: ScheduleCronExpressionSchema.optional(),
  timezone: ScheduleTimezoneSchema.optional(),
  taskTemplate: scheduleTaskTemplateInputSchema,
  enabled: z.boolean().optional(),
  overlapPolicy: ScheduleOverlapPolicySchema.optional(),
  misfirePolicy: ScheduleMisfirePolicySchema.optional(),
} satisfies z.ZodRawShape;

const updateScheduleInputSchema = {
  id: scheduleIdSchema,
  name: z.string().trim().min(1).max(120).nullable().optional(),
  recurrence: ScheduleRecurrenceSchema.optional(),
  cronExpression: ScheduleCronExpressionSchema.optional(),
  timezone: ScheduleTimezoneSchema.optional(),
  taskTemplate: scheduleTaskTemplateInputSchema.optional(),
  enabled: z.boolean().optional(),
  overlapPolicy: ScheduleOverlapPolicySchema.optional(),
  misfirePolicy: ScheduleMisfirePolicySchema.optional(),
} satisfies z.ZodRawShape;

const transcriptOutputSchema = z.object({
  status: z.enum(['available', 'empty', 'expired']),
  turns: z.array(SessionTurnSchema).optional(),
  meta: SessionHistoryMetaSchema.optional(),
  isInterrupted: z.boolean().optional(),
  reason: SessionHistoryEmptyReasonSchema.optional(),
});
const deleteScheduleOutputSchema = z.object({
  id: ScheduleResponseSchema.shape.id,
  deleted: z.literal(true),
});

/**
 * Register the tools on `server`, delegating to `deps` with per-tool scope
 * gates. Called once for each request-scoped `McpServer`; the SDK server itself
 * owns exactly one transport, so stateless concurrent requests must not share it.
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
  userIdOf: (extra: ToolExtra) => string | undefined = userIdFromExtra,
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
        'read get_transcript. Each MCP call is a distinct create: the REST-only ' +
        'Idempotency-Key header is not mapped to a tool argument. Requires the ' +
        'tasks:write scope.',
      inputSchema: V1CreateTaskRequestSchema.shape,
      outputSchema: TaskResponseSchema,
    },
    async (args: unknown, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      const { repoId, ...body } = V1CreateTaskRequestSchema.parse(args);
      // Delegate to the SAME admission path the console uses. `create` persists
      // the row then OFFERS the task to the guardrails semaphore and returns the
      // handle — it does NOT await the (minutes-long) run, so the tool call never
      // blocks on completion (spec: "create_task returns a handle without
      // blocking").
      const task = await deps.createTask(
        repoId,
        body,
        userIdOf(extra),
      );
      // Keep the historical text handle for clients that render `content`, while
      // the machine-readable result matches POST /v1/tasks exactly.
      return jsonResult({ id: task.id, status: task.status, task }, task);
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
        id: taskIdSchema,
      },
      outputSchema: TaskResponseSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      return jsonResult(await deps.getTask(id));
    },
  );

  // --- list_tasks (tasks:read) -------------------------------------------------
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks in the shared pool using the same keyset pagination as /v1. ' +
        'Requires the tasks:read scope.',
      inputSchema: V1ListQuerySchema.shape,
      outputSchema: V1ListTasksResponseSchema,
    },
    async (args: unknown, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      const query = V1ListQuerySchema.parse(args);
      return jsonResult(await deps.listTasks(query));
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
        id: taskIdSchema.describe('The task id to stop.'),
      },
      outputSchema: TaskResponseSchema,
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
        id: taskIdSchema.describe('The task id whose transcript to read.'),
      },
      outputSchema: transcriptOutputSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      const transcript = await deps.getTranscript(id);
      return jsonResult(transcript);
    },
  );

  // --- list_repos (repos:read) -------------------------------------------------
  server.registerTool(
    'list_repos',
    {
      title: 'List repos',
      description:
        'List the configured repos a task can run against using the same keyset ' +
        'pagination as /v1. Requires the repos:read scope.',
      inputSchema: V1ListQuerySchema.shape,
      outputSchema: V1ListReposResponseSchema,
    },
    async (args: unknown, extra: ToolExtra) => {
      requireScope(extra, 'repos:read');
      const query = V1ListQuerySchema.parse(args);
      return jsonResult(await deps.listRepos(query));
    },
  );

  // --- get_repo (repos:read) ---------------------------------------------------
  server.registerTool(
    'get_repo',
    {
      title: 'Get a repo',
      description: 'Fetch one configured repo by id. Requires the repos:read scope.',
      inputSchema: { id: repoIdSchema },
      outputSchema: RepoResponseSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'repos:read');
      return jsonResult(await deps.getRepo(id));
    },
  );

  // --- owner-scoped scheduled tasks -------------------------------------------
  server.registerTool(
    'create_schedule',
    {
      title: 'Create a recurring task schedule',
      description:
        'Create an owner-scoped recurring task schedule. Accepts either a ' +
        'recurrence descriptor or a five-field cron expression. Requires the ' +
        'tasks:write scope.',
      inputSchema: createScheduleInputSchema,
      outputSchema: ScheduleResponseSchema,
    },
    async (args: unknown, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      const body = CreateScheduleRequestSchema.parse(args);
      return jsonResult(await deps.createSchedule(ownerUserId, body));
    },
  );

  server.registerTool(
    'list_schedules',
    {
      title: 'List recurring task schedules',
      description:
        'List recurring task schedules owned by the MCP token account using the ' +
        'same keyset pagination as /v1. Requires the tasks:read scope.',
      inputSchema: V1ScheduleListQuerySchema.shape,
      outputSchema: V1ListSchedulesResponseSchema,
    },
    async (args: unknown, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      const ownerUserId = requireOwner(extra, userIdOf);
      const query = V1ScheduleListQuerySchema.parse(args);
      return jsonResult(await deps.listSchedules(ownerUserId, query));
    },
  );

  server.registerTool(
    'get_schedule',
    {
      title: 'Get a recurring task schedule',
      description:
        'Fetch one recurring task schedule owned by the MCP token account. ' +
        'Requires the tasks:read scope.',
      inputSchema: { id: scheduleIdSchema },
      outputSchema: ScheduleResponseSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:read');
      const ownerUserId = requireOwner(extra, userIdOf);
      return jsonResult(await deps.getSchedule(ownerUserId, id));
    },
  );

  server.registerTool(
    'update_schedule',
    {
      title: 'Update a recurring task schedule',
      description:
        'Update future occurrences of an owner-scoped recurring task schedule. ' +
        'Requires the tasks:write scope.',
      inputSchema: updateScheduleInputSchema,
      outputSchema: ScheduleResponseSchema,
    },
    async (
      { id, ...input }: { id: string } & Record<string, unknown>,
      extra: ToolExtra,
    ) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      const body = UpdateScheduleRequestSchema.parse(input);
      return jsonResult(await deps.updateSchedule(ownerUserId, id, body));
    },
  );

  server.registerTool(
    'pause_schedule',
    {
      title: 'Pause a recurring task schedule',
      description:
        'Disable future fires for an owner-scoped recurring task schedule. ' +
        'Requires the tasks:write scope.',
      inputSchema: { id: scheduleIdSchema },
      outputSchema: ScheduleResponseSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      return jsonResult(await deps.pauseSchedule(ownerUserId, id));
    },
  );

  server.registerTool(
    'resume_schedule',
    {
      title: 'Resume a recurring task schedule',
      description:
        'Enable an owner-scoped recurring task schedule and compute its next ' +
        'future fire time. Requires the tasks:write scope.',
      inputSchema: { id: scheduleIdSchema },
      outputSchema: ScheduleResponseSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      return jsonResult(await deps.resumeSchedule(ownerUserId, id));
    },
  );

  server.registerTool(
    'dispatch_schedule',
    {
      title: 'Run a recurring task schedule now',
      description:
        'Consume the current period of an owner-scoped recurring task schedule ' +
        'immediately and advance its next period. expectedPeriodKey can bind a ' +
        'retry to the period observed by the caller. Requires the tasks:write scope.',
      inputSchema: {
        id: scheduleIdSchema,
        ...DispatchScheduleRequestSchema.removeDefault().shape,
      },
      outputSchema: ScheduleResponseSchema,
    },
    async (
      { id, ...rawBody }: { id: string; expectedPeriodKey?: string },
      extra: ToolExtra,
    ) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      const body = DispatchScheduleRequestSchema.parse(rawBody);
      return jsonResult(await deps.dispatchSchedule(ownerUserId, id, body));
    },
  );

  server.registerTool(
    'delete_schedule',
    {
      title: 'Delete a recurring task schedule',
      description:
        'Delete an owner-scoped recurring task schedule. Existing tasks and run ' +
        'history follow the scheduled-task service semantics. Requires the ' +
        'tasks:write scope.',
      inputSchema: { id: scheduleIdSchema },
      outputSchema: deleteScheduleOutputSchema,
    },
    async ({ id }: { id: string }, extra: ToolExtra) => {
      requireScope(extra, 'tasks:write');
      const ownerUserId = requireOwner(extra, userIdOf);
      await deps.deleteSchedule(ownerUserId, id);
      return jsonResult({ id, deleted: true });
    },
  );

  server.registerTool(
    'list_schedule_runs',
    {
      title: 'List runs for a recurring task schedule',
      description:
        'List recent occurrence records for an owner-scoped recurring task ' +
        'schedule. Requires the tasks:read scope.',
      inputSchema: {
        id: scheduleIdSchema,
        ...V1ScheduleListQuerySchema.shape,
      },
      outputSchema: V1ListScheduleRunsResponseSchema,
    },
    async (
      { id, ...rawQuery }: { id: string } & Record<string, unknown>,
      extra: ToolExtra,
    ) => {
      requireScope(extra, 'tasks:read');
      const ownerUserId = requireOwner(extra, userIdOf);
      const query = V1ScheduleListQuerySchema.parse(rawQuery);
      return jsonResult(await deps.listScheduleRuns(ownerUserId, id, query));
    },
  );
}
