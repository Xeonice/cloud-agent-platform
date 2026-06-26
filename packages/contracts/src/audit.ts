import { z } from 'zod';
import { TaskStatusSchema } from './task.js';

/**
 * Audit / history contract (audit-history spec).
 *
 * The orchestrator persists an immutable, append-only audit event record for
 * every task lifecycle transition and notable operational outcome, so the
 * history page ("历史与日志 · 审计时间线") renders from real recorded events
 * rather than client-side mocks. Recording is best-effort with respect to the
 * controlled action: a failure to persist an audit event never rolls back or
 * blocks the lifecycle transition itself.
 */

// ---------------------------------------------------------------------------
// Severity level
// ---------------------------------------------------------------------------

/**
 * Audit severity, driving the colored audit-dot on a timeline row. Maps to the
 * prototype's 信息/警告/错误 segmented control (`info` / `warning` / `error`).
 *
 * `level` is kept consistent with {@link AuditEventSchema.resultCode}: a `2xx`
 * code is never paired with `error`, and a `4xx`/`5xx` code is never paired with
 * `info`, so the colored dot and the status code on a row never contradict.
 */
export const AuditLevelSchema = z.enum(['info', 'warning', 'error']);
export type AuditLevel = z.infer<typeof AuditLevelSchema>;

// ---------------------------------------------------------------------------
// Audit event record
// ---------------------------------------------------------------------------

/**
 * A single append-only audit event. Once written it is never mutated or deleted
 * by lifecycle progression, so a task's full ordered history remains queryable
 * even after it reaches a terminal state.
 *
 * The guardrails service emits one of these at the moment of each lifecycle
 * transition (`running` / `completed` / `failed` / `cancelled`,
 * `agent_failed_to_start`, and force-fail causes such as deadline, idle, and
 * circuit-break), recording the transition's outcome and its cause where one
 * exists.
 */
export const AuditEventSchema = z.object({
  /** Stable, unique event id. */
  id: z.string().uuid(),
  /**
   * Foreign key to the owning task. Every persisted event references a real
   * task id and is never orphaned; the console uses it to deep-link a timeline
   * row to that task's live session route (`/tasks/$taskId`).
   */
  taskId: z.string().uuid(),
  /**
   * The numeric operator id the event is attributed to, retained for legacy
   * GitHub-backed audit records so the history page can show who initiated or
   * owns a recorded action.
   */
  userId: z.number().int(),
  /**
   * The lifecycle/audit kind, e.g. `task.created`, `task.running`,
   * `task.completed`, `task.failed`, `task.cancelled`, `agent_failed_to_start`,
   * `force_failed`.
   */
  type: z.string().min(1),
  /** Severity, governing the colored audit-dot. */
  level: AuditLevelSchema,
  /** Short, human-readable title for the timeline row. */
  title: z.string().min(1),
  /**
   * Human-readable description; for a force-fail it names the cause (deadline /
   * idle / circuit-break) so the timeline shows why the task failed.
   */
  description: z.string(),
  /** Server-assigned UTC timestamp at which the event was recorded. */
  timestamp: z.coerce.date(),
  /**
   * Optional HTTP-status-like result code the console renders verbatim:
   * `201` (created), `200` (read/transition with no new resource),
   * `409` (conflict — e.g. a rejected concurrent operation or a slot/admission
   * conflict), `422` (validation/precondition failure). When present it is kept
   * consistent with {@link AuditEventSchema.level}.
   */
  resultCode: z.number().int().optional(),
  /**
   * Session linkage: the most recent run identifier where one applies, letting
   * the console deep-link the event's task to its live session route. Absent
   * when the event has no associated run.
   */
  runId: z.string().min(1).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

/**
 * Default cap on returned events so the timeline does not unboundedly grow,
 * applied when the caller supplies no `limit`.
 */
export const AUDIT_QUERY_DEFAULT_LIMIT = 100 as const;

/**
 * Filters accepted by the authenticated read endpoint that returns recent audit
 * events ordered most-recent-first. All fields are optional; omitting `level`
 * (the prototype's "全部"/all selection) returns every severity, and omitting
 * `status` returns events for tasks in any lifecycle state.
 */
export const AuditQuerySchema = z.object({
  /**
   * Filter by severity. Maps to the 信息/警告/错误 segmented control; omit for
   * "全部"/all.
   */
  level: AuditLevelSchema.optional(),
  /**
   * Filter by the lifecycle status of the associated task; omit to return events
   * for tasks in any status.
   */
  status: TaskStatusSchema.optional(),
  /**
   * Bound on the number of returned events. Defaults to
   * {@link AUDIT_QUERY_DEFAULT_LIMIT} when omitted.
   */
  limit: z.number().int().positive().default(AUDIT_QUERY_DEFAULT_LIMIT),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** Response body for the audit events read endpoint, ordered most-recent-first. */
export const ListAuditEventsResponseSchema = z.array(AuditEventSchema);
export type ListAuditEventsResponse = z.infer<typeof ListAuditEventsResponseSchema>;
