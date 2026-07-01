import { z } from 'zod';
import {
  CreateTaskRequestSchema,
  RepoSchema,
  TaskResponseSchema,
  TaskSchema,
} from './task.js';

/**
 * `@cap/contracts` — the `/v1` public-API DTOs (public-v1-api spec, D2).
 *
 * These shapes are ADDITIVE: they live ALONGSIDE the console's
 * `CreateTaskRequestSchema` / `ListTasksResponseSchema` / `ListReposResponseSchema`
 * (in `./task.js`) and never mutate them, so the `apps/web` console contract stays
 * byte-identical (a generation test asserts the console schemas are unchanged after
 * these additions). The `/v1` controllers validate against these same schemas, and
 * the OpenAPI document is generated from them, so the doc cannot drift from the wire.
 */

// ---------------------------------------------------------------------------
// Task create with `repoId` in the body (D1 — single admission path)
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /v1/tasks`.
 *
 * Unlike the console's `POST /repos/:repoId/tasks` (which takes `repoId` from the
 * route), the `/v1` create carries `repoId` IN THE BODY so a machine caller hits a
 * single, flat endpoint. Every other field is the console
 * {@link CreateTaskRequestSchema} verbatim (via `.extend`) so a `/v1` create routes
 * through the SAME `TasksService.create(repoId, body)` admission path — there is no
 * second admission code path.
 */
export const V1CreateTaskRequestSchema = CreateTaskRequestSchema.extend({
  /** Foreign key to the owning repo, supplied in the body (not the route). */
  repoId: z.string().uuid(),
});
export type V1CreateTaskRequest = z.infer<typeof V1CreateTaskRequestSchema>;

// ---------------------------------------------------------------------------
// Keyset (cursor) pagination query + envelopes (D4)
// ---------------------------------------------------------------------------

/** Default page size when `?limit=` is omitted. */
export const V1_LIST_DEFAULT_LIMIT = 50 as const;
/** Hard upper bound on `?limit=`; larger requests are clamped/rejected to this. */
export const V1_LIST_MAX_LIMIT = 200 as const;

/**
 * Query parameters accepted by the `/v1` list endpoints (`GET /v1/tasks`,
 * `GET /v1/repos`).
 *
 * `limit` is coerced from the query string, defaults to
 * {@link V1_LIST_DEFAULT_LIMIT} and is bounded by {@link V1_LIST_MAX_LIMIT}.
 * `cursor` is the opaque base64 token returned as the previous page's
 * `nextCursor` (it encodes the `(createdAt, id)` tuple of the last row); absent on
 * the first page.
 */
export const V1ListQuerySchema = z.object({
  /**
   * Page size. Coerced from the query string, defaults to
   * {@link V1_LIST_DEFAULT_LIMIT}, minimum 1, maximum {@link V1_LIST_MAX_LIMIT}.
   */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(V1_LIST_MAX_LIMIT)
    .default(V1_LIST_DEFAULT_LIMIT),
  /**
   * Opaque keyset cursor returned as the prior page's `nextCursor`. Absent on the
   * first page. Decoded server-side to the `(createdAt, id)` tuple the next page
   * resumes after.
   */
  cursor: z.string().min(1).optional(),
});
export type V1ListQuery = z.infer<typeof V1ListQuerySchema>;

/**
 * Builds a `{ items, nextCursor }` keyset-pagination envelope schema for a given
 * item schema. `nextCursor` is the opaque token to fetch the next page, and is
 * `null` once the last page has been returned.
 */
const paginatedEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    /** The page of rows, in `(createdAt, id)` order. */
    items: z.array(item),
    /**
     * Opaque cursor for the next page (pass it back as `?cursor=`), or `null` when
     * this is the last page.
     */
    nextCursor: z.string().min(1).nullable(),
  });

/** Response body for `GET /v1/tasks` — a keyset page of tasks. */
export const V1ListTasksResponseSchema = paginatedEnvelope(TaskResponseSchema);
export type V1ListTasksResponse = z.infer<typeof V1ListTasksResponseSchema>;

/** Response body for `GET /v1/repos` — a keyset page of repos. */
export const V1ListReposResponseSchema = paginatedEnvelope(RepoSchema);
export type V1ListReposResponse = z.infer<typeof V1ListReposResponseSchema>;

// ---------------------------------------------------------------------------
// SSE lifecycle-event shape (D6)
// ---------------------------------------------------------------------------

/**
 * One lifecycle event emitted by the `GET /v1/tasks/:id/events` SSE stream.
 *
 * Each event is derived from a single append-only `AuditEvent` tail row (NOT the
 * raw PTY/WebSocket stream). `id` is the AuditEvent's stable id, carried as the SSE
 * `id:` field so a reconnecting client can resume via `Last-Event-ID`. `status`
 * is the task's lifecycle status at the moment the event was recorded, so a caller
 * can detect a terminal state and the stream's auto-close after it. `type`,
 * `title`, `description` and `timestamp` mirror the underlying AuditEvent so the
 * event is self-describing without a second fetch.
 */
export const V1TaskEventSchema = z.object({
  /**
   * Stable event id (the underlying AuditEvent id), surfaced as the SSE `id:`
   * field for `Last-Event-ID` resume.
   */
  id: z.string().uuid(),
  /** The task this lifecycle event belongs to. */
  taskId: z.string().uuid(),
  /**
   * The lifecycle/audit kind mirrored from the AuditEvent (e.g. `task.created`,
   * `task.running`, `task.completed`, `task.failed`, `task.cancelled`).
   */
  type: z.string().min(1),
  /**
   * The task's lifecycle status at the moment this event was recorded. A terminal
   * status (`completed` / `failed` / `cancelled` / `agent_failed_to_start`)
   * signals the stream will auto-close after this event.
   */
  status: TaskSchema.shape.status,
  /** Short, human-readable title mirrored from the AuditEvent. */
  title: z.string().min(1),
  /** Human-readable description mirrored from the AuditEvent. */
  description: z.string(),
  /** UTC timestamp at which the event was recorded. */
  timestamp: z.coerce.date(),
});
export type V1TaskEvent = z.infer<typeof V1TaskEventSchema>;
