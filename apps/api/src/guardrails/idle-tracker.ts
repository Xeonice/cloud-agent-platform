/**
 * Per-task idle tracker (guardrail 12.3).
 *
 * Tracks how long a running task has gone with *no terminal output and no agent
 * hook activity*. Idle tracking is OPT-IN PER TASK: each tracked task carries its
 * OWN idle ceiling (supplied to {@link IdleTracker.start}), and a task is tracked
 * only when an effective ceiling exists (a per-task `idleTimeoutMs` or an
 * operator-level default). When the idle gap exceeds that task's ceiling the task
 * is force-failed: the integration layer (Track 14) transitions it to `failed`,
 * tears down its sandbox, and releases its slot, so a wedged session cannot hold
 * a scarce slot indefinitely. A task with no ceiling is never tracked and never
 * reclaimed for idleness.
 *
 * Any qualifying activity — terminal output or a hook event — resets the idle
 * timer. The full ceiling must then elapse again before the task can be
 * reclaimed.
 *
 * This is deliberately DISTINCT from the much shorter `Stop`-hook "awaiting
 * input" notification: that notification merely flags a task as waiting on the
 * operator and does NOT fail it. The idle ceiling here is the longer wedged-task
 * reclamation bound and is the only mechanism in this module that force-fails.
 *
 * The tracker owns no task status and performs no writes; it schedules over an
 * injectable clock/timer and invokes {@link IdleTrackerOptions.onIdleExceeded}
 * when a task crosses the ceiling.
 */

/** Callback fired once when a tracked task's idle gap exceeds `MAX_IDLE`. */
export type IdleExceededCallback = (taskId: string) => void;

/** Minimal timer surface, injectable so tests can drive virtual time. */
export interface TimerLike {
  setTimeout(handler: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface IdleTrackerOptions {
  /**
   * Invoked exactly once per task when its idle gap exceeds that task's ceiling.
   * Wired by the integration layer to: lifecycle `running -> failed`, sandbox
   * teardown, and slot release.
   */
  readonly onIdleExceeded: IdleExceededCallback;
  /** Wall-clock source; defaults to `Date.now`. Injectable for tests. */
  readonly now?: () => number;
  /** Timer source; defaults to the global timers. Injectable for tests. */
  readonly timer?: TimerLike;
}

interface Tracked {
  lastActivityEpochMs: number;
  handle: ReturnType<typeof setTimeout>;
  /** This task's own idle ceiling in ms (per-task, not a process-wide constant). */
  maxIdleMs: number;
}

const defaultTimer: TimerLike = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class IdleTracker {
  private readonly onIdleExceeded: IdleExceededCallback;
  private readonly now: () => number;
  private readonly timer: TimerLike;

  private readonly tracked = new Map<string, Tracked>();

  constructor(options: IdleTrackerOptions) {
    this.onIdleExceeded = options.onIdleExceeded;
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? defaultTimer;
  }

  /** Number of tasks currently being tracked for idleness. */
  get trackedCount(): number {
    return this.tracked.size;
  }

  /** True if the task is currently being tracked. */
  isTracking(taskId: string): boolean {
    return this.tracked.has(taskId);
  }

  /**
   * Begins tracking a running task at its OWN idle ceiling (`maxIdleMs`, a
   * positive number of ms). The idle window starts now; the ceiling must fully
   * elapse with no recorded activity before the task is reclaimed. Starting an
   * already-tracked task resets its window (equivalent to recording activity)
   * and re-pins the ceiling to the supplied value.
   *
   * Idle tracking is OPT-IN per task: the integration layer calls this ONLY when
   * an effective ceiling exists (a per-task `idleTimeoutMs` or an operator-level
   * default). A task with no ceiling is never `start`-ed and so is never
   * reclaimed for idleness.
   */
  start(taskId: string, maxIdleMs: number): void {
    if (!(maxIdleMs > 0) || !Number.isFinite(maxIdleMs)) {
      throw new Error(
        `idle ceiling must be a positive number of milliseconds, received: ${String(
          maxIdleMs,
        )}`,
      );
    }
    this.armFromNow(taskId, maxIdleMs);
  }

  /**
   * Records qualifying activity (terminal output OR a hook event) for a task and
   * resets its idle window. This is the single reset entry point; callers wire
   * it to both the PTY/terminal-output path and the agent-hook event path so any
   * of either resets the timer.
   *
   * Recording activity for an untracked task is a no-op — once a task has been
   * reclaimed or stopped it is not implicitly resurrected.
   */
  recordActivity(taskId: string): void {
    const existing = this.tracked.get(taskId);
    if (!existing) {
      return;
    }
    this.armFromNow(taskId, existing.maxIdleMs);
  }

  /**
   * Stops tracking a task without force-failing it (e.g. it reached a terminal
   * state on its own, or the `Stop`-hook "awaiting input" path applies). Safe to
   * call for an untracked task.
   */
  stop(taskId: string): void {
    const entry = this.tracked.get(taskId);
    if (!entry) {
      return;
    }
    this.timer.clearTimeout(entry.handle);
    this.tracked.delete(taskId);
  }

  /** Stops tracking all tasks (e.g. on shutdown). */
  stopAll(): void {
    for (const entry of this.tracked.values()) {
      this.timer.clearTimeout(entry.handle);
    }
    this.tracked.clear();
  }

  /**
   * (Re)arms the idle timer for a task relative to "now", recording the current
   * time as the last activity and scheduling the ceiling check.
   */
  private armFromNow(taskId: string, maxIdleMs: number): void {
    const existing = this.tracked.get(taskId);
    if (existing) {
      this.timer.clearTimeout(existing.handle);
    }

    const startedAt = this.now();
    const handle = this.timer.setTimeout(() => {
      this.onIdle(taskId);
    }, maxIdleMs);

    this.tracked.set(taskId, { lastActivityEpochMs: startedAt, handle, maxIdleMs });
  }

  /**
   * Fires when the scheduled ceiling elapses. Guards against a stale timer (one
   * scheduled before a reset) by re-checking the elapsed gap against the actual
   * last-activity timestamp; if real activity has since reset the window, it
   * re-arms for the remaining time instead of force-failing.
   */
  private onIdle(taskId: string): void {
    const entry = this.tracked.get(taskId);
    if (!entry) {
      return;
    }

    const idleFor = this.now() - entry.lastActivityEpochMs;
    if (idleFor < entry.maxIdleMs) {
      // A reset happened after this timer was scheduled; re-arm for the rest
      // against this task's own ceiling.
      const remaining = entry.maxIdleMs - idleFor;
      entry.handle = this.timer.setTimeout(() => this.onIdle(taskId), remaining);
      return;
    }

    this.tracked.delete(taskId);
    this.onIdleExceeded(taskId);
  }
}
