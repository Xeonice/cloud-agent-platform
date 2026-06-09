/**
 * Per-task start/turn circuit breaker (guardrail 12.4).
 *
 * Counts CONSECUTIVE agent-failed-to-start and turn-failure events for a task.
 * On reaching the configured threshold it trips the task to `failed` with NO
 * automatic retry, preventing a burn loop where a task repeatedly fails to start
 * and is endlessly re-provisioned, holding a slot and burning provider quota.
 *
 * Scope under the connect-in model: this accumulation is for PROVISION-TIME start
 * failures (`agent_failed_to_start`), where a task may legitimately be retried
 * before tripping. It is NOT the mechanism that reclaims a RUNNING task whose
 * sandbox terminal session has exited — a running task's terminal WS-close is a
 * single terminal event with no re-launch, so that exit is handled by
 * `GuardrailsService.recordExit` (which transitions the task and frees its slot on
 * the FIRST exit), not by waiting for a threshold of consecutive failures.
 *
 * A recorded success resets the consecutive-failure counter to zero, so a task
 * that recovers before the threshold is not penalized for earlier hiccups.
 *
 * The breaker owns only the per-task counters and the tripped flag. It performs
 * no status writes itself: when the threshold is reached it invokes
 * {@link CircuitBreakerOptions.onTrip}, which the integration layer (Track 14)
 * wires to the lifecycle `-> failed` transition (and slot release / teardown).
 * Once tripped, the breaker latches: further failures for that task are ignored
 * and do not re-fire the trip callback, since there is no auto-retry.
 */

/** Failure classes counted by the breaker. */
export type FailureKind = 'agent_failed_to_start' | 'turn_failure';

/** Callback fired once when a task's consecutive failures reach the threshold. */
export type CircuitTripCallback = (taskId: string, consecutiveFailures: number) => void;

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive start/turn failures that trips the breaker. Must be a
   * positive integer (a threshold of 1 trips on the first failure).
   */
  readonly threshold: number;
  /**
   * Invoked exactly once per task when its consecutive-failure count reaches the
   * threshold. Wired by the integration layer to lifecycle `-> failed` with no
   * automatic retry.
   */
  readonly onTrip: CircuitTripCallback;
}

interface BreakerState {
  consecutiveFailures: number;
  tripped: boolean;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly onTrip: CircuitTripCallback;

  private readonly states = new Map<string, BreakerState>();

  constructor(options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new Error(
        `Circuit breaker threshold must be a positive integer, received: ${String(
          options.threshold,
        )}`,
      );
    }
    this.threshold = options.threshold;
    this.onTrip = options.onTrip;
  }

  /** Current consecutive-failure count for a task (0 if untracked/reset). */
  consecutiveFailures(taskId: string): number {
    return this.states.get(taskId)?.consecutiveFailures ?? 0;
  }

  /** True once the breaker has tripped for a task (latched). */
  isTripped(taskId: string): boolean {
    return this.states.get(taskId)?.tripped ?? false;
  }

  /**
   * Records a start/turn failure for a task.
   *
   * Increments the consecutive-failure counter; when it reaches the threshold
   * the breaker trips: it latches the tripped flag and invokes {@link onTrip}
   * exactly once. Subsequent failures on an already-tripped task are ignored
   * (no re-trip), reflecting that there is no automatic retry after a trip.
   *
   * Returns `true` if this call caused the breaker to trip, `false` otherwise.
   */
  recordFailure(taskId: string, _kind: FailureKind = 'agent_failed_to_start'): boolean {
    const state = this.states.get(taskId) ?? { consecutiveFailures: 0, tripped: false };

    if (state.tripped) {
      // Already broken; do not count further or re-fire the trip.
      this.states.set(taskId, state);
      return false;
    }

    state.consecutiveFailures += 1;

    if (state.consecutiveFailures >= this.threshold) {
      state.tripped = true;
      this.states.set(taskId, state);
      this.onTrip(taskId, state.consecutiveFailures);
      return true;
    }

    this.states.set(taskId, state);
    return false;
  }

  /**
   * Records a successful start/turn for a task, resetting its consecutive-
   * failure counter to zero. A success on a not-yet-tripped task clears the
   * count so it must re-accumulate the full threshold before tripping.
   *
   * A success does NOT un-trip an already-tripped breaker — once a task is
   * circuit-broken to `failed` it stays failed (no auto-retry); reset is a no-op
   * in that case.
   */
  recordSuccess(taskId: string): void {
    const state = this.states.get(taskId);
    if (!state || state.tripped) {
      return;
    }
    state.consecutiveFailures = 0;
    this.states.set(taskId, state);
  }

  /** Forgets all state for a task (e.g. when it is removed entirely). */
  forget(taskId: string): void {
    this.states.delete(taskId);
  }

  /** Forgets all tracked tasks (e.g. on shutdown). */
  forgetAll(): void {
    this.states.clear();
  }
}
