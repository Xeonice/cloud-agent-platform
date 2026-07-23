import { ConflictException } from '@nestjs/common';
import {
  RepoCopyStatusSchema,
  TASK_REPO_COPY_NOT_READY_ERROR,
  TaskRepoCopyNotReadyErrorSchema,
  taskRepoCopyNotReadyMessage,
  type TaskRepoCopyBlockingStatus,
} from '@cap/contracts';

/**
 * add-repo-content-store (D6) — task creation gates on repo-copy readiness.
 *
 * Content is acquired at IMPORT time now, so a task start is a local injection
 * of an existing bare mirror. A Repo whose copy is not `ready` therefore has
 * nothing to inject: admitting the task would only buy a provisioning failure
 * minutes later. This gate refuses at the create boundary instead, and names the
 * one action that fixes it.
 *
 * Scope is deliberately CREATE ONLY. A task that was already accepted keeps
 * running (and re-adopted work keeps being supplied) no matter how the Repo's
 * copy status moves afterwards — the copy it needed was resolved at start.
 */

/** Thrown by the create path when the selected Repo's copy is not `ready`. */
export class RepoCopyNotReadyException extends ConflictException {
  readonly repoId: string;
  readonly copyStatus: TaskRepoCopyBlockingStatus;

  constructor(repoId: string, copyStatus: TaskRepoCopyBlockingStatus) {
    // 409: the request is well-formed and the Repo exists — it is the CURRENT
    // repo state that conflicts with starting work. `tasks.create` already
    // declares 409/`conflict`, so `/v1` and MCP inherit this rejection through
    // the existing public error boundary with no new public error code.
    super(
      TaskRepoCopyNotReadyErrorSchema.parse({
        error: TASK_REPO_COPY_NOT_READY_ERROR,
        repoId,
        copyStatus,
        message: taskRepoCopyNotReadyMessage(repoId, copyStatus),
      }),
    );
    this.repoId = repoId;
    this.copyStatus = copyStatus;
  }
}

/** The subset of a Repo row this gate reads. */
export interface RepoCopyGateRow {
  readonly id: string;
  readonly copyStatus?: string | null;
}

/**
 * Classify a stored copy status. `ready` is the ONLY admitting value; an
 * unrecognized string fails closed as `unknown` rather than being read as ready.
 *
 * `null`/`undefined` is the one non-blocking non-`ready` case: the column is
 * NOT NULL with a `missing` default, so every real row carries a value, and an
 * absent one can only come from an adapter that predates the content store.
 * Blocking on it would reject nothing real while breaking those callers.
 */
export function classifyRepoCopyGate(
  copyStatus: string | null | undefined,
): TaskRepoCopyBlockingStatus | 'ready' {
  if (copyStatus === null || copyStatus === undefined) return 'ready';
  const parsed = RepoCopyStatusSchema.safeParse(copyStatus);
  if (!parsed.success) return 'unknown';
  return parsed.data;
}

/**
 * Fail closed before ANY task row, credential, or provider work when the Repo's
 * content copy cannot serve a task start.
 */
export function assertRepoCopyReadyForTaskCreate(repo: RepoCopyGateRow): void {
  const status = classifyRepoCopyGate(repo.copyStatus);
  if (status === 'ready') return;
  throw new RepoCopyNotReadyException(repo.id, status);
}
