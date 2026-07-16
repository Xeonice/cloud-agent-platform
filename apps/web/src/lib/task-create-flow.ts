/** A mutable single-flight cell; React refs satisfy this shape directly. */
export interface TaskCreateSubmissionFence {
  current: boolean;
}

/**
 * Atomically claim one Console task-create submission. This closes the small
 * gap before React can re-render an `isPending`-disabled submit button.
 */
export function claimTaskCreateSubmission(
  fence: TaskCreateSubmissionFence,
): boolean {
  if (fence.current) return false;
  fence.current = true;
  return true;
}

/** A rejected create may be retried; a committed create deliberately stays claimed. */
export function releaseRejectedTaskCreate(
  fence: TaskCreateSubmissionFence,
): void {
  fence.current = false;
}

/**
 * Reopening a modal must not detach from an in-flight mutation. A rejected
 * submission has released the fence, while an accepted one has a recoverable
 * id and may start a fresh flow on the next explicit open.
 */
export function canResetTaskCreateSubmission(
  fence: TaskCreateSubmissionFence,
  acceptedTaskId: string | null,
): boolean {
  return !fence.current || acceptedTaskId !== null;
}

/** A freshly opened modal represents a new create flow. */
export function resetTaskCreateSubmission(
  fence: TaskCreateSubmissionFence,
): void {
  fence.current = false;
}
