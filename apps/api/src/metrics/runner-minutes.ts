import type { RunnerMinutes } from '@cap/contracts';

/**
 * Runner-minutes (compute-minutes) accounting (be-metrics, task 5.4).
 *
 * A "runner-minute" is one minute a task spent in the RUNNING state. The figure
 * is DERIVED accounting over observed running durations (admission → terminal),
 * NOT a sampled host metric and NOT an exact billing figure. A task still
 * running is counted up to `now`.
 *
 * Critically, when there is no timing data to derive from — no task has ever
 * started in this process — the figure is reported as `unavailable` with
 * `minutes: null`, NOT as a fabricated `0` that would imply an exact "zero
 * minutes used" reading. Zero is only ever reported when timing data exists but
 * genuinely sums to (a rounding of) zero elapsed running time.
 */

/**
 * One observed task running interval. `startedAt` is the epoch-millis instant
 * the task was admitted to RUNNING; `endedAt` is the instant it reached a
 * terminal state, or `null` while it is still running (counted up to `now`).
 */
export interface RunningInterval {
  readonly taskId: string;
  /** Epoch millis the task entered RUNNING. */
  readonly startedAt: number;
  /** Epoch millis the task left RUNNING, or `null` while still in-flight. */
  readonly endedAt: number | null;
}

/**
 * Derives runner-minutes from observed running intervals (task 5.4).
 *
 * - `available: false`, `minutes: null` when `intervals` is empty: there is no
 *   timing data, so the figure is genuinely UNAVAILABLE — never a fabricated 0.
 * - otherwise `available: true` and `minutes` is the sum of each interval's
 *   running duration in minutes. An in-flight interval (`endedAt === null`) is
 *   counted from `startedAt` up to `now`. Each interval is clamped at zero so a
 *   clock skew (`endedAt < startedAt`, or `now < startedAt`) never subtracts.
 *
 * `now` is injected so the function stays pure and deterministically testable.
 */
export function deriveRunnerMinutes(
  intervals: readonly RunningInterval[],
  now: number,
): RunnerMinutes {
  if (intervals.length === 0) {
    // No timing data persisted/observed: honestly unavailable, not zero.
    return { available: false, minutes: null };
  }

  let totalMs = 0;
  for (const interval of intervals) {
    const end = interval.endedAt ?? now;
    const elapsed = end - interval.startedAt;
    // Clamp: a negative span (clock skew / out-of-order timestamps) contributes
    // nothing rather than reducing the total.
    if (elapsed > 0) {
      totalMs += elapsed;
    }
  }

  return { available: true, minutes: totalMs / 60_000 };
}

/**
 * In-memory ledger of task running intervals (task 5.4).
 *
 * The `Task` table persists only `createdAt` — there is no `startedAt`/`endedAt`
 * column — so admission→terminal timing is observed in-process: the guardrails
 * service records a start when a task enters RUNNING and an end when it reaches a
 * terminal state. This ledger is therefore a per-process accounting estimate
 * over the lifetime of the orchestrator process (it resets on restart), which is
 * exactly why the figure is labeled DERIVED accounting, not exact billing.
 *
 * The ledger itself stays a dumb append/close store; {@link deriveRunnerMinutes}
 * (pure) does the math, so the derivation logic is unit-testable in isolation.
 */
export class RunnerMinutesLedger {
  /** Closed (terminal) intervals retained for the reporting window. */
  private readonly closed: RunningInterval[] = [];
  /** Open (in-flight) intervals keyed by task id. */
  private readonly open = new Map<string, RunningInterval>();

  /**
   * Records that a task entered RUNNING at `at` (epoch millis, default now).
   * Idempotent per task: a duplicate start for an already-open task is ignored
   * so a re-admission glitch cannot double-count or reset the interval.
   */
  recordStart(taskId: string, at: number = Date.now()): void {
    if (this.open.has(taskId)) return;
    this.open.set(taskId, { taskId, startedAt: at, endedAt: null });
  }

  /**
   * Records that a task left RUNNING (terminal) at `at` (epoch millis, default
   * now), closing its open interval. A terminal for a task with no open interval
   * (e.g. a task cancelled while still queued, which never ran) is a no-op — it
   * accrued no running time.
   */
  recordEnd(taskId: string, at: number = Date.now()): void {
    const interval = this.open.get(taskId);
    if (!interval) return;
    this.open.delete(taskId);
    this.closed.push({ ...interval, endedAt: at });
  }

  /**
   * Snapshot of all observed intervals — closed first, then the currently-open
   * ones (still `endedAt: null`) — for {@link deriveRunnerMinutes}.
   */
  intervals(): RunningInterval[] {
    return [...this.closed, ...this.open.values()];
  }
}
