import { z, type AnyZodObject, type ZodTypeAny } from 'zod';

import { SessionHistorySchema } from './session-history.js';
import {
  CreateScheduleRequestSchema,
  DispatchScheduleRequestSchema,
  ScheduleResponseSchema,
  UpdateScheduleRequestSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ScheduleListQuerySchema,
} from './schedule.js';
import { RepoSchema, TaskResponseSchema } from './task.js';
import type { Scope } from './scope.js';
import {
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListReposResponseSchema,
  V1ListTasksResponseSchema,
  V1TaskEventSchema,
} from './v1.js';

/** HTTP methods used by the public, versioned data API. */
export type PublicV1Method = 'get' | 'post' | 'patch' | 'delete';

/** Operation-specific failures beyond shared validation/auth/not-found errors. */
export type PublicV1AdditionalErrorStatus = 404 | 409 | 429;

/** How a public REST operation is represented on the MCP surface. */
export type PublicV1McpMapping =
  | { readonly tool: string }
  | { readonly excluded: string };

/**
 * One public `/v1` data operation.
 *
 * This manifest is transport-neutral contract metadata. The API projects it into
 * OpenAPI, the console projects it into the API Playground, and MCP uses the
 * explicit mapping to prevent capability drift. Controller implementation remains
 * in `apps/api`; a reflection test compares those real decorators with this list.
 */
export interface PublicV1Operation {
  readonly id: string;
  readonly method: PublicV1Method;
  /** OpenAPI-style path template (`{id}`, not Nest's `:id`). */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly scope: Scope;
  readonly streaming: boolean;
  readonly destructive: boolean;
  readonly paramsSchema?: AnyZodObject;
  readonly querySchema?: AnyZodObject;
  readonly headersSchema?: AnyZodObject;
  readonly requestSchema?: ZodTypeAny;
  readonly successStatus: number;
  readonly responseDescription: string;
  /** The complete HTTP response body schema, including transport framing. */
  readonly responseSchema: ZodTypeAny | null;
  readonly responseContentType?: string;
  /** JSON payload carried by each SSE `data:` field, when streaming. */
  readonly streamEventSchema?: ZodTypeAny;
  readonly additionalErrorStatuses?: readonly PublicV1AdditionalErrorStatus[];
  readonly mcp: PublicV1McpMapping;
}

function definePublicV1Operations<
  const Operations extends readonly PublicV1Operation[],
>(
  operations: Operations,
): readonly (
  PublicV1Operation & { readonly id: Operations[number]['id'] }
)[] {
  return operations;
}

/** Shared UUID path parameter for all current public by-id operations. */
export const PublicV1IdParamsSchema = z.object({
  id: z.string().uuid().describe('The resource id.'),
});

/** Optional idempotency key accepted by public task creation. */
export const PublicV1IdempotencyHeadersSchema = z.object({
  'Idempotency-Key': z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Deduplicates retries for the same principal and request body.'),
});

/** Optional SSE resume cursor accepted by the task-event stream. */
export const PublicV1EventHeadersSchema = z.object({
  'Last-Event-ID': z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Resume after the last received lifecycle event id.'),
});

/** Raw HTTP body returned by an SSE operation, including SSE field framing. */
export const PublicV1SseStreamSchema = z
  .string()
  .describe(
    'A text/event-stream body containing repeated `id:` and `data:` fields, ' +
      'blank-line-delimited events, and optional heartbeat comments. Each ' +
      '`data:` value is JSON conforming to the operation stream event schema.',
  );

/**
 * Canonical inventory of the 17 public `/v1` data operations.
 *
 * Metadata-only routes (`/v1/openapi.json` and `/v1/docs`) and the sandbox-only
 * internal approvals callback (`/internal/sandbox/approvals`) are deliberately
 * outside this data-operation manifest.
 */
export const PUBLIC_V1_OPERATIONS = definePublicV1Operations([
  {
    id: 'tasks.create',
    method: 'post',
    path: '/v1/tasks',
    summary: 'Create a task',
    description:
      'Admit a new task against a repo (`repoId` in the body). Goes through the ' +
      'same admission path as the console create. Accepts an optional ' +
      '`Idempotency-Key` header for safe retries.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    headersSchema: PublicV1IdempotencyHeadersSchema,
    requestSchema: V1CreateTaskRequestSchema,
    successStatus: 201,
    responseDescription: 'The created task with its initial status.',
    responseSchema: TaskResponseSchema,
    additionalErrorStatuses: [404, 409, 429],
    mcp: { tool: 'create_task' },
  },
  {
    id: 'tasks.list',
    method: 'get',
    path: '/v1/tasks',
    summary: 'List tasks',
    description: 'Keyset-paginated list of tasks ordered by `(createdAt, id)`.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    querySchema: V1ListQuerySchema,
    successStatus: 200,
    responseDescription: 'A page of tasks plus the next-page cursor.',
    responseSchema: V1ListTasksResponseSchema,
    mcp: { tool: 'list_tasks' },
  },
  {
    id: 'tasks.get',
    method: 'get',
    path: '/v1/tasks/{id}',
    summary: 'Get a task',
    description:
      'Fetch a single task by id. This polling read is the guaranteed observation ' +
      'floor: every status transition is persisted before the response.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The task.',
    responseSchema: TaskResponseSchema,
    mcp: { tool: 'get_task' },
  },
  {
    id: 'tasks.stop',
    method: 'post',
    path: '/v1/tasks/{id}/stop',
    summary: 'Stop a task',
    description: 'Operator-initiated stop; transitions an active task to `cancelled`.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The task transitioned toward its terminal state.',
    responseSchema: TaskResponseSchema,
    mcp: { tool: 'stop_task' },
  },
  {
    id: 'tasks.transcript',
    method: 'get',
    path: '/v1/tasks/{id}/transcript',
    summary: "Get a task's transcript",
    description:
      'Read the task transcript. Active tasks read the live sandbox rollout; ' +
      'terminal tasks read durable storage first with retained-sandbox fallback.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The recorded transcript.',
    responseSchema: SessionHistorySchema,
    mcp: { tool: 'get_transcript' },
  },
  {
    id: 'tasks.events',
    method: 'get',
    path: '/v1/tasks/{id}/events',
    summary: "Stream a task's lifecycle events",
    description:
      'Server-Sent Events stream of lifecycle transitions sourced from the ' +
      'append-only AuditEvent tail. Each event carries an id for `Last-Event-ID` ' +
      'resume; a heartbeat is emitted at least every 90s; the stream closes after ' +
      'a terminal event. The raw PTY/WebSocket terminal stream is not exposed here.',
    scope: 'tasks:read',
    streaming: true,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    headersSchema: PublicV1EventHeadersSchema,
    successStatus: 200,
    responseDescription:
      'A framed SSE stream. Each `data:` JSON value conforms to V1TaskEvent.',
    responseSchema: PublicV1SseStreamSchema,
    responseContentType: 'text/event-stream',
    streamEventSchema: V1TaskEventSchema,
    mcp: { excluded: 'MCP tools use request/response transport; lifecycle SSE is REST-only.' },
  },
  {
    id: 'repos.list',
    method: 'get',
    path: '/v1/repos',
    summary: 'List repos',
    description: 'Keyset-paginated list of repos ordered by `(createdAt, id)`.',
    scope: 'repos:read',
    streaming: false,
    destructive: false,
    querySchema: V1ListQuerySchema,
    successStatus: 200,
    responseDescription: 'A page of repos plus the next-page cursor.',
    responseSchema: V1ListReposResponseSchema,
    mcp: { tool: 'list_repos' },
  },
  {
    id: 'repos.get',
    method: 'get',
    path: '/v1/repos/{id}',
    summary: 'Get a repo',
    description: 'Fetch a single repo by id.',
    scope: 'repos:read',
    streaming: false,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The repo.',
    responseSchema: RepoSchema,
    mcp: { tool: 'get_repo' },
  },
  {
    id: 'schedules.list',
    method: 'get',
    path: '/v1/schedules',
    summary: 'List schedules',
    description: 'Owner-scoped keyset-paginated list of task schedules.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    querySchema: V1ScheduleListQuerySchema,
    successStatus: 200,
    responseDescription: 'A page of schedules plus the next-page cursor.',
    responseSchema: V1ListSchedulesResponseSchema,
    mcp: { tool: 'list_schedules' },
  },
  {
    id: 'schedules.create',
    method: 'post',
    path: '/v1/schedules',
    summary: 'Create a schedule',
    description:
      'Create an owner-scoped recurring task schedule. Prefer recurrence ' +
      'descriptors such as daily, weekdays, weekly, monthly, hourly, or ' +
      'minuteInterval; cronExpression and timezone remain accepted for ' +
      'compatibility clients. The task template is validated through the same ' +
      'task creation rules.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    requestSchema: CreateScheduleRequestSchema,
    successStatus: 201,
    responseDescription: 'The created schedule.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [404],
    mcp: { tool: 'create_schedule' },
  },
  {
    id: 'schedules.get',
    method: 'get',
    path: '/v1/schedules/{id}',
    summary: 'Get a schedule',
    description: 'Fetch an owner-scoped schedule by id.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The schedule.',
    responseSchema: ScheduleResponseSchema,
    mcp: { tool: 'get_schedule' },
  },
  {
    id: 'schedules.update',
    method: 'patch',
    path: '/v1/schedules/{id}',
    summary: 'Update a schedule',
    description:
      'Update recurrence, policies, enabled state, or task template. Prefer ' +
      'daily, weekdays, weekly, monthly, hourly, or minuteInterval recurrence ' +
      'descriptors; cronExpression and timezone remain compatibility fields.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    requestSchema: UpdateScheduleRequestSchema,
    successStatus: 200,
    responseDescription: 'The updated schedule.',
    responseSchema: ScheduleResponseSchema,
    mcp: { tool: 'update_schedule' },
  },
  {
    id: 'schedules.pause',
    method: 'post',
    path: '/v1/schedules/{id}/pause',
    summary: 'Pause a schedule',
    description: 'Disable future fires for an owner-scoped schedule.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The paused schedule.',
    responseSchema: ScheduleResponseSchema,
    mcp: { tool: 'pause_schedule' },
  },
  {
    id: 'schedules.resume',
    method: 'post',
    path: '/v1/schedules/{id}/resume',
    summary: 'Resume a schedule',
    description: 'Enable a schedule and compute its next future fire time.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The resumed schedule.',
    responseSchema: ScheduleResponseSchema,
    mcp: { tool: 'resume_schedule' },
  },
  {
    id: 'schedules.dispatch',
    method: 'post',
    path: '/v1/schedules/{id}/dispatch',
    summary: 'Dispatch a schedule immediately',
    description:
      'Consume the current schedule period immediately and advance nextRunAt to ' +
      'the next period. expectedPeriodKey can bind a retry to the period observed ' +
      'by the caller.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    requestSchema: DispatchScheduleRequestSchema,
    successStatus: 200,
    responseDescription: 'The schedule after the immediate dispatch.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [409],
    mcp: { tool: 'dispatch_schedule' },
  },
  {
    id: 'schedules.delete',
    method: 'delete',
    path: '/v1/schedules/{id}',
    summary: 'Delete a schedule',
    description: 'Delete an owner-scoped schedule and its run ledger.',
    scope: 'tasks:write',
    streaming: false,
    destructive: true,
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 204,
    responseDescription: 'The schedule was deleted.',
    responseSchema: null,
    mcp: { tool: 'delete_schedule' },
  },
  {
    id: 'schedules.runs',
    method: 'get',
    path: '/v1/schedules/{id}/runs',
    summary: "List a schedule's runs",
    description:
      'Owner-scoped keyset-paginated run ledger ordered by scheduled fire time.',
    scope: 'tasks:read',
    streaming: false,
    destructive: false,
    paramsSchema: PublicV1IdParamsSchema,
    querySchema: V1ScheduleListQuerySchema,
    successStatus: 200,
    responseDescription: 'A page of schedule runs plus the next-page cursor.',
    responseSchema: V1ListScheduleRunsResponseSchema,
    mcp: { tool: 'list_schedule_runs' },
  },
] as const);

/** Stable ids accepted by UI overlays and parity maps. */
export type PublicV1OperationId =
  (typeof PUBLIC_V1_OPERATIONS)[number]['id'];
