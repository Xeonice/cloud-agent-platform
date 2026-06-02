/**
 * @cap/runner — bounded startup window (Track 4, task 4.4).
 *
 * Watches a freshly-spawned interactive codex PTY for two startup failures and
 * reports a DISTINCT agent-failed-to-start condition rather than hanging:
 *
 *   - early_exit:     the process exits with a non-zero status BEFORE producing
 *                     its first interactive frame;
 *   - startup_timeout: no first interactive frame arrives within the bounded
 *                     window.
 *
 * Either failure resolves the window's `outcome` promise as `{ ok: false }`,
 * so the task lifecycle leaves `pending`/`running` and is surfaced to the
 * orchestrator (the task does not remain hanging — see the spec scenarios).
 */

/**
 * The agent-failed-to-start status string. Deliberately identical to the
 * contracts `TaskStatus` literal so the orchestrator maps it directly onto the
 * lifecycle state machine. Kept as a local typed constant here to avoid this
 * runner-local startup logic taking a hard dependency on the contracts package
 * wiring, which the integration track finalizes.
 */
export const AGENT_FAILED_TO_START = 'agent_failed_to_start' as const;

/** Reason an agent was judged to have failed to start. */
export type AgentFailedToStartReason = 'early_exit' | 'startup_timeout';

/** Default bounded window before a no-first-frame start is judged failed. */
export const DEFAULT_STARTUP_WINDOW_MS = 30_000;

/** Outcome of the bounded startup window. */
export type StartupOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AgentFailedToStartReason;
      /** Present when the failure was an early non-zero exit. */
      readonly exitCode?: number;
    };

/**
 * Arms a single-shot startup window for one spawned process. The window is
 * decided exactly once, by whichever of these happens first:
 *   - first interactive frame observed  -> resolve ok
 *   - non-zero exit before first frame   -> resolve failed(early_exit)
 *   - zero exit before first frame       -> resolve failed(early_exit) (the
 *       process ended before ever reaching an interactive state)
 *   - window elapses with no first frame -> resolve failed(startup_timeout)
 *
 * Subsequent signals are ignored, so a normal exit AFTER a successful start does
 * not retroactively mark the task as failed-to-start.
 */
export class StartupWindow {
  /** Resolves once (and only once) the startup window has been decided. */
  public readonly outcome: Promise<StartupOutcome>;

  private resolveOutcome!: (outcome: StartupOutcome) => void;
  private settled = false;
  private sawFirstFrame = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(windowMs: number = DEFAULT_STARTUP_WINDOW_MS) {
    this.outcome = new Promise<StartupOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    this.timer = setTimeout(() => {
      // No first interactive frame within the bounded window.
      this.settle({ ok: false, reason: 'startup_timeout' });
    }, windowMs);
    // Do not let the timer keep the event loop alive on its own.
    this.timer.unref?.();
  }

  /**
   * Record that the first interactive frame (first PTY output byte) was seen.
   * The first call settles the window as successful; later calls are ignored.
   */
  noteFirstFrame(): void {
    if (this.settled || this.sawFirstFrame) return;
    this.sawFirstFrame = true;
    this.settle({ ok: true });
  }

  /**
   * Record process exit. If it happens BEFORE the first interactive frame, the
   * window settles as agent-failed-to-start (`early_exit`) — covering both the
   * non-zero early-exit scenario and a process that ends before ever rendering.
   * An exit AFTER a successful start is ignored here (the window already settled
   * ok); normal post-start exit is reported on the lifecycle path, not here.
   */
  noteExit(exitCode: number): void {
    if (this.settled || this.sawFirstFrame) return;
    this.settle({ ok: false, reason: 'early_exit', exitCode });
  }

  /** Cancel the window without reporting a failure (e.g. operator teardown). */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
  }

  private settle(outcome: StartupOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.resolveOutcome(outcome);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
