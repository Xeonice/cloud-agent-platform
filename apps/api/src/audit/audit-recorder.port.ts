import type { TaskStatus } from '@cap/contracts';
import type { ForceFailCause } from './audit-mapping';

/**
 * Narrow, best-effort audit-recorder PORT the lifecycle services depend on
 * (be-audit-approvals 6.2).
 *
 * The lifecycle write paths (`TasksService` create/transition/mark and
 * `GuardrailsService.forceFail`) inject this interface by the
 * {@link AUDIT_RECORDER_TOKEN} with `@Optional()` so they can be constructed and
 * tested in isolation, and so the cross-module binding lives in `app.module.ts`
 * (wired by the verify phase) WITHOUT importing `AuditModule` into `TasksModule`
 * (which would form a cycle: TasksModule -> AuditModule -> TerminalModule ->
 * TasksModule). The concrete `AuditService` satisfies this shape.
 *
 * CONTRACT: every method is BEST-EFFORT and MUST NOT throw — a persistence
 * failure is logged and swallowed by the implementation, so an audit failure can
 * never roll back or block the lifecycle transition that triggered it (6.2). The
 * methods return `Promise<void>`; callers `void` them (or await-and-ignore) so a
 * rejected promise can never surface in the transition path.
 */
export interface AuditRecorderPort {
  /** Record `task.created`, attributed to the GitHub-identity user when known. */
  recordTaskCreated(taskId: string, githubId?: number): Promise<void>;
  /**
   * Record a lifecycle transition event for `status` (no-op for `pending`). The
   * operator-driven `task.cancelled` terminal flows through here too —
   * `recordTransition(id, 'cancelled')` emits the `task.cancelled` event — so no
   * dedicated cancel method is needed.
   */
  recordTransition(taskId: string, status: TaskStatus, githubId?: number): Promise<void>;
  /** Record a force-fail naming its cause (deadline / idle / circuit_breaker). */
  recordForceFailed(taskId: string, cause: ForceFailCause): Promise<void>;
  /**
   * Record a failure-detail event for a non-success process exit
   * (record-task-failure-reason): the resolved exit `code` (or `null` when
   * unresolved), the `abnormal` flag, and an already-sampled, ANSI-stripped
   * `tail` of the task transcript. The description carries the code + the mapped
   * human reason + the tail so a failure is diagnosable without the sandbox.
   * This is a DETAIL event ALONGSIDE the central `task.failed` transition — it
   * does not replace it. Best-effort; never throws.
   */
  recordExited(
    taskId: string,
    code: number | null,
    abnormal: boolean,
    tail: string,
  ): Promise<void>;
}

/** DI token used when injecting the audit recorder into the lifecycle services. */
export const AUDIT_RECORDER_TOKEN = 'AUDIT_RECORDER';
