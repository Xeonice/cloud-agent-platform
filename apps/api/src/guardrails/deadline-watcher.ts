/**
 * Wall-clock deadline watcher (guardrail 12.2).
 *
 * A running task MAY carry a wall-clock deadline. When the deadline passes while
 * the task is still running, the watcher fires a single force-fail action: the
 * integration layer (Track 14) transitions the task to `failed`, tears down its
 * sandbox, and releases its concurrency slot. A task that reaches a terminal
 * state before its deadline is simply cleared and never force-failed.
 *
 * Why wall-clock rather than token budgets: pure-terminal execution exposes no
 * token metering, so the budget guardrail is observable wall time (design D13).
 *
 * The watcher is a pure scheduling unit over an injectable clock/timer so it can
 * be unit-tested deterministically. It owns no task state and performs no
 * status writes itself — it only decides *when* a task has overrun and invokes
 * the supplied {@link DeadlineWatcherOptions.onDeadlineExceeded} hook.
 */

/** Callback fired once when a tracked task passes its deadline while running. */
export type DeadlineExceededCallback = (taskId: string) => void;

/** Minimal timer surface, injectable so tests can drive virtual time. */
export interface TimerLike {
  setTimeout(handler: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface DeadlineWatcherOptions {
  /**
   * Invoked exactly once per task when its deadline elapses while the task is
   * still being watched (i.e. still running). The integration layer wires this
   * to: lifecycle `running -> failed`, sandbox teardown, and slot release.
   */
  readonly onDeadlineExceeded: DeadlineExceededCallback;
  /** Wall-clock source; defaults to `Date.now`. Injectable for tests. */
  readonly now?: () => number;
  /** Timer source; defaults to the global timers. Injectable for tests. */
  readonly timer?: TimerLike;
}

interface Watch {
  readonly deadlineEpochMs: number;
  readonly handle: ReturnType<typeof setTimeout>;
}

const defaultTimer: TimerLike = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class DeadlineWatcher {
  private readonly onDeadlineExceeded: DeadlineExceededCallback;
  private readonly now: () => number;
  private readonly timer: TimerLike;

  private readonly watches = new Map<string, Watch>();

  constructor(options: DeadlineWatcherOptions) {
    this.onDeadlineExceeded = options.onDeadlineExceeded;
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? defaultTimer;
  }

  /** Number of tasks currently being watched for a deadline. */
  get watchedCount(): number {
    return this.watches.size;
  }

  /** True if the task currently has an armed deadline. */
  isWatching(taskId: string): boolean {
    return this.watches.has(taskId);
  }

  /**
   * Arms (or re-arms) a wall-clock deadline for a running task, expressed as an
   * absolute epoch-millis timestamp. Re-arming replaces any previous deadline.
   *
   * If the deadline is already in the past, the force-fail action fires on the
   * next timer tick (delay clamped to 0) rather than synchronously, so callers
   * observe consistent asynchronous semantics.
   */
  arm(taskId: string, deadlineEpochMs: number): void {
    this.clear(taskId);

    const delayMs = Math.max(0, deadlineEpochMs - this.now());
    const handle = this.timer.setTimeout(() => {
      // The watch is consumed exactly once when it fires.
      this.watches.delete(taskId);
      this.onDeadlineExceeded(taskId);
    }, delayMs);

    this.watches.set(taskId, { deadlineEpochMs, handle });
  }

  /**
   * Arms a deadline expressed as a duration from now. Convenience over
   * {@link arm} for the common "this task may run for at most N ms" case.
   */
  armAfter(taskId: string, ttlMs: number): void {
    this.arm(taskId, this.now() + ttlMs);
  }

  /**
   * Clears a task's deadline without force-failing it. Called when a task
   * reaches a terminal state before its deadline (so it is never force-failed),
   * or whenever the watch should otherwise be cancelled. Safe to call for an
   * untracked task.
   */
  clear(taskId: string): void {
    const watch = this.watches.get(taskId);
    if (!watch) {
      return;
    }
    this.timer.clearTimeout(watch.handle);
    this.watches.delete(taskId);
  }

  /** Clears all armed deadlines (e.g. on shutdown). */
  clearAll(): void {
    for (const watch of this.watches.values()) {
      this.timer.clearTimeout(watch.handle);
    }
    this.watches.clear();
  }
}
