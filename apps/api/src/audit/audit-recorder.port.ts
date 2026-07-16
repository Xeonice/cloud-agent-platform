import type {
  TaskFailure,
  TaskProvisioningStage,
  TaskStatus,
} from '@cap/contracts';
import type { ForceFailCause } from './audit-mapping';

export type ProvisioningAuditFailure = Exclude<
  TaskFailure,
  { runtime: unknown }
>;

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
 * CONTRACT: ordinary lifecycle and provisioning-progress methods are
 * BEST-EFFORT and MUST NOT throw. Terminal provisioning detail is different:
 * it returns a durability acknowledgement so the already-failed Task can keep
 * its admission work reclaimable until central/detail audit rows are confirmed.
 * The concrete implementation still does not expose its raw persistence error.
 */
export interface AuditRecorderPort {
  /**
   * Record `task.created`, attributed to the acting account when known. `userId`
   * is the account PRIMARY KEY (`users.id`) — present for BOTH GitHub and LOCAL
   * (password/OTP) accounts (fix-local-account-task-attribution), so a local
   * account's task is owner-attributed and its stored Codex credential resolves
   * at run time. Omitted only for a truly identity-less principal
   * (machine/legacy), which is then system-attributed.
   */
  recordTaskCreated(taskId: string, userId?: string): Promise<void>;
  /**
   * Record one durable provisioning checkpoint after the work row advanced.
   * `(taskId, attempt, stage)` is the idempotency identity, so a lease replay
   * may observe the same checkpoint without duplicating timeline detail.
   */
  recordProvisioningProgress(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
  ): Promise<void>;
  /**
   * Record the central task.failed event plus one structured provisioning detail.
   * Both rows are idempotent per Task so recovery can safely fill a crash gap.
   * Returns false when either durable row could not be confirmed; callers keep
   * terminal work reclaimable so expiry recovery can retry the audit boundary.
   */
  recordProvisioningFailure(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
    failure: ProvisioningAuditFailure,
  ): Promise<boolean>;
  /**
   * Record the operator-driven terminal cancellation with one Task-stable
   * identity. Terminal admission recovery keeps its work marker reclaimable
   * until this method confirms the central lifecycle event is durable.
   */
  recordTaskCancellation(taskId: string, userId?: string): Promise<boolean>;
  /**
   * Record a lifecycle transition event for `status` (no-op for `pending`). The
   * operator-driven `task.cancelled` terminal delegates to the idempotent
   * cancellation recorder above. `userId` is the account PRIMARY KEY (present
   * for local + GitHub accounts), attributed when known.
   */
  recordTransition(
    taskId: string,
    status: TaskStatus,
    userId?: string,
    failure?: TaskFailure,
  ): Promise<void>;
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

  /**
   * Record a result-delivery push-back (add-multi-forge-task-delivery): a change
   * request was opened (`task.change_request_opened`, 201) or an existing open one
   * was reused (`task.change_request_reused`, 200). Carries the CR url + number in
   * the description. Best-effort; never throws.
   */
  recordChangeRequest(
    taskId: string,
    opts: { url: string; number: number; reused: boolean },
  ): Promise<void>;
}

/** DI token used when injecting the audit recorder into the lifecycle services. */
export const AUDIT_RECORDER_TOKEN = 'AUDIT_RECORDER';
