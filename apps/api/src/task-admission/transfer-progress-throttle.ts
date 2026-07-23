import type { TaskProvisioningStage } from '@cap/contracts';
import type { TaskAdmissionTransferProgress } from './task-admission.types';

/**
 * Time-throttled transfer-progress writer
 * (chunk-archive-injection-with-progress D2, operator-decided 1s interval).
 *
 * Archive injection reports progress per uploaded part — hundreds of times for
 * a large mirror — while the durable snapshot only needs a human-paced feed.
 * At most one write per interval goes through; suppressed reports are dropped
 * (progress is an output stream, never authority, so a lost intermediate
 * snapshot is harmless). Failed writes are swallowed for the same reason.
 */
export const TRANSFER_PROGRESS_WRITE_INTERVAL_MS = 1_000;

export type ThrottledTransferProgressWriter = (
  stage: TaskProvisioningStage,
  progress: TaskAdmissionTransferProgress,
) => Promise<void>;

export function createThrottledTransferProgressWriter(options: {
  readonly write: (
    stage: TaskProvisioningStage,
    progress: TaskAdmissionTransferProgress,
  ) => Promise<void>;
  readonly writeIntervalMs?: number;
  readonly now?: () => number;
}): ThrottledTransferProgressWriter {
  const interval = options.writeIntervalMs ?? TRANSFER_PROGRESS_WRITE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastWriteAtMs: number | null = null;
  let writing = false;
  return async (stage, progress) => {
    const at = now();
    if (writing) return;
    if (lastWriteAtMs !== null && at - lastWriteAtMs < interval) return;
    // Claim the slot before awaiting so concurrent reports within one write
    // settle to a single database round trip.
    lastWriteAtMs = at;
    writing = true;
    try {
      await options.write(stage, progress);
    } catch {
      // Best-effort: durable admission state stays authoritative.
    } finally {
      writing = false;
    }
  };
}
