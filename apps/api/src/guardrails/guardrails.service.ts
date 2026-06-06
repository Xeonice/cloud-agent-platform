import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { TaskStatus } from '@cap/contracts';
import { TasksService } from '../tasks/tasks.service';
import { TaskTokenService } from '../tasks/task-token.service';
import { SessionCredentialsService } from '../creds/session-credentials.service';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '../audit/audit-recorder.port';
import { ConcurrencySemaphore } from './semaphore';
import { DeadlineWatcher } from './deadline-watcher';
import { IdleTracker } from './idle-tracker';
import { CircuitBreaker, type FailureKind } from './circuit-breaker';
import type { SemaphoreProjectionSource } from '../metrics/metrics-projection';
import {
  RunnerMinutesLedger,
  type RunningInterval,
} from '../metrics/runner-minutes';

/**
 * Guardrails integration (integration 12.1b).
 *
 * Composes the four self-contained guardrail classes — the concurrency semaphore
 * (12.1), wall-clock deadline watcher (12.2), idle tracker (12.3), and start/turn
 * circuit breaker (12.4) — and WIRES their cross-track call sites:
 *
 *  - admit-queued: the semaphore's `onAdmit` callback drives the lifecycle
 *    `queued -> running` transition for the oldest queued task when a slot frees.
 *  - force-fail + teardown + slot-release: the deadline / idle / circuit-breaker
 *    callbacks transition the task to `failed`, tear down its session-scoped
 *    credentials (the primary safety boundary) and revoke its `TASK_TOKEN`, and
 *    release its concurrency slot (which may admit the next queued task).
 *
 * The guardrail CLASSES own no task state and perform no writes; this service is
 * the integration seam that turns their decisions into lifecycle transitions and
 * session teardown. It depends on the {@link SandboxProvider} PORT by token
 * (9.1b), not a concrete impl.
 */

export interface GuardrailsConfig {
  /** Max tasks running concurrently (`MAX_CONCURRENT_TASKS`). */
  readonly maxConcurrentTasks: number;
  /** Idle ceiling in ms (`MAX_IDLE`) before a wedged task is force-failed. */
  readonly maxIdleMs: number;
  /** Consecutive start/turn failures that trip the circuit breaker. */
  readonly circuitBreakerThreshold: number;
}

/** Defaults sourced from env at module construction; safe for local/dev. */
export const DEFAULT_GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 5,
  maxIdleMs: 10 * 60 * 1000, // 10 minutes
  circuitBreakerThreshold: 3,
};

@Injectable()
export class GuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);

  private readonly semaphore: ConcurrencySemaphore;
  private readonly deadlines: DeadlineWatcher;
  private readonly idle: IdleTracker;
  private readonly breaker: CircuitBreaker;
  /**
   * Deadlines parked for tasks admitted to `queued` (no free slot at admit time).
   * The semaphore's `AdmitCallback` is taskId-only, so the deadline is stashed
   * here at `admit()` and consumed when the task is later promoted
   * `queued -> running` in {@link onAdmit} — so a queued-then-admitted task still
   * arms its wall-clock deadline, not only a task that runs immediately.
   */
  private readonly pendingDeadlines = new Map<string, number>();

  /**
   * Per-process ledger of task running intervals (admission→terminal), the
   * source for the DERIVED runner-minutes metric (be-metrics 5.4). The
   * guardrails service is the admission/terminal seam, so it is the natural
   * place to observe RUNNING durations; the `Task` table persists only
   * `createdAt`, so this timing is observed in-process and resets on restart —
   * which is exactly why the metric is labeled derived accounting, not billing.
   */
  private readonly runnerMinutes = new RunnerMinutesLedger();

  constructor(
    private readonly tasks: TasksService,
    private readonly creds: SessionCredentialsService,
    private readonly taskTokens: TaskTokenService,
    @Optional()
    @Inject(SANDBOX_PROVIDER)
    private readonly sandbox?: SandboxProvider,
    config: GuardrailsConfig = DEFAULT_GUARDRAILS_CONFIG,
    /**
     * Best-effort audit recorder (6.2), injected by the {@link AUDIT_RECORDER_TOKEN}
     * (verify-phase wiring in `app.module.ts`). Optional so the service still
     * constructs without it; when absent, transitions proceed unaudited. Every
     * call is fire-and-forget and the recorder never throws (6.2), so it can never
     * affect a transition.
     */
    @Optional()
    @Inject(AUDIT_RECORDER_TOKEN)
    private readonly audit?: AuditRecorderPort,
  ) {
    // admit-queued: when a slot frees, drive `queued -> running` for the admitted
    // task (FIFO) — the cross-track lifecycle call site for 12.1.
    this.semaphore = new ConcurrencySemaphore({
      maxConcurrentTasks: config.maxConcurrentTasks,
      onAdmit: (taskId) => void this.onAdmit(taskId),
    });

    // force-fail call sites (12.2 / 12.3 / 12.4) all converge on `forceFail`.
    this.deadlines = new DeadlineWatcher({
      onDeadlineExceeded: (taskId) => void this.forceFail(taskId, 'deadline'),
    });
    this.idle = new IdleTracker({
      maxIdleMs: config.maxIdleMs,
      onIdleExceeded: (taskId) => void this.forceFail(taskId, 'idle'),
    });
    this.breaker = new CircuitBreaker({
      threshold: config.circuitBreakerThreshold,
      onTrip: (taskId) => void this.forceFail(taskId, 'circuit_breaker'),
    });
  }

  /**
   * Offer a newly created task to the concurrency semaphore (12.1). When a slot
   * is free the task is admitted to `running` and its guardrail timers are armed;
   * otherwise it is held `queued` (no sandbox provisioned) and its lifecycle is
   * moved to `queued`. Returns the admission outcome.
   */
  async admit(taskId: string, deadlineMs?: number): Promise<'running' | 'queued'> {
    const outcome = this.semaphore.offer(taskId);
    if (outcome === 'running') {
      await this.startRunning(taskId, deadlineMs);
    } else {
      // Park the deadline so it is armed when the slot frees and this queued task
      // is promoted to running (onAdmit), not silently dropped.
      if (deadlineMs !== undefined) this.pendingDeadlines.set(taskId, deadlineMs);
      await this.safeTransition(taskId, 'queued');
    }
    return outcome;
  }

  /** Record terminal output or a hook event — resets the idle window (12.3). */
  recordActivity(taskId: string): void {
    this.idle.recordActivity(taskId);
  }

  /** Record a start/turn failure for the circuit breaker (12.4). */
  recordFailure(taskId: string, kind: FailureKind = 'agent_failed_to_start'): void {
    this.breaker.recordFailure(taskId, kind);
  }

  /** Record a successful start/turn, resetting the breaker's counter (12.4). */
  recordSuccess(taskId: string): void {
    this.breaker.recordSuccess(taskId);
  }

  /**
   * A task reached a terminal state on its own (completion/failure). Clear its
   * guardrail timers, tear down its session credentials, and release its slot —
   * which admits the next queued task if any (12.1 slot-release; session-end
   * teardown). Idempotent.
   */
  async onTerminal(taskId: string): Promise<void> {
    this.clearTimers(taskId);
    // Close the runner-minutes interval (no-op if the task never ran) (5.4).
    this.runnerMinutes.recordEnd(taskId);
    this.teardownSession(taskId, 'completed');
    // release() admits the next queued task via the onAdmit callback.
    this.semaphore.release(taskId);
  }

  // -------------------------------------------------------------------------
  // Internal wiring
  // -------------------------------------------------------------------------

  /** Admit a previously-queued task: `queued -> running` + arm timers (12.1). */
  private async onAdmit(taskId: string): Promise<void> {
    // Consume the deadline parked at admit() so a queued-then-admitted task arms
    // its wall-clock deadline just like one that ran immediately.
    const deadlineMs = this.pendingDeadlines.get(taskId);
    this.pendingDeadlines.delete(taskId);
    await this.startRunning(taskId, deadlineMs);
  }

  /** Transition to `running`, arm the idle tracker (and deadline, if any). */
  private async startRunning(taskId: string, deadlineMs?: number): Promise<void> {
    await this.safeTransition(taskId, 'running');
    this.idle.start(taskId);
    // Begin the runner-minutes interval the moment the task enters RUNNING (5.4).
    this.runnerMinutes.recordStart(taskId);
    if (deadlineMs !== undefined) {
      this.deadlines.armAfter(taskId, deadlineMs);
    }
  }

  /**
   * Force-fail a task (deadline overrun / idle ceiling / circuit trip): transition
   * to `failed`, stop/kill its running sandbox (VR.2), tear down its session
   * credentials + revoke its token, and release its slot (admitting the next
   * queued task). The cause is logged for audit.
   */
  private async forceFail(
    taskId: string,
    cause: 'deadline' | 'idle' | 'circuit_breaker',
  ): Promise<void> {
    this.logger.warn(`force-failing task ${taskId} (${cause})`);
    this.clearTimers(taskId);
    // Close the runner-minutes interval on the forced-failure terminal too (5.4).
    this.runnerMinutes.recordEnd(taskId);
    // 6.2 — record the force-fail naming its CAUSE (deadline / idle /
    // circuit_breaker), so the timeline shows WHY the task was reclaimed. The
    // generic `task.failed` transition is also recorded centrally by the tasks
    // service when the `failed` write below is accepted; the two are distinct
    // events (the terminal transition + its cause).
    await this.recordAudit(() => this.audit?.recordForceFailed(taskId, cause));
    await this.safeTransition(taskId, 'failed');
    // VR.2 — tear down the running sandbox so the container/process is stopped,
    // not just the credentials. Idempotent: safe if the sandbox already exited.
    if (this.sandbox) {
      await this.sandbox.teardownSandbox(taskId).catch((err: unknown) => {
        this.logger.warn(
          `sandbox teardown for task ${taskId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    this.teardownSession(taskId, 'failed');
    this.semaphore.release(taskId);
  }

  /** Clear deadline + idle timers for a task (it has settled). */
  private clearTimers(taskId: string): void {
    this.deadlines.clear(taskId);
    this.idle.stop(taskId);
    // Drop any deadline parked while the task was queued but never promoted.
    this.pendingDeadlines.delete(taskId);
  }

  /**
   * Tear down a task's session at session end: destroy its ephemeral
   * session-scoped credentials (the primary safety boundary) and revoke its
   * `TASK_TOKEN`, so neither can authenticate after the session closes.
   */
  private teardownSession(taskId: string, reason: 'completed' | 'failed'): void {
    this.creds.destroyForSession(taskId, reason);
    this.taskTokens.revokeForTask(taskId);
  }

  /**
   * Apply a lifecycle transition, tolerating an illegal edge (e.g. a task that
   * already settled). Guardrail-driven transitions race with the agent's own
   * transitions, so a rejected edge is logged and swallowed rather than thrown.
   *
   * 6.2 — the per-transition audit event is emitted CENTRALLY by
   * {@link TasksService.transition} (the single status-write chokepoint every
   * caller funnels through), so it is NOT re-emitted here; this avoids a
   * double-recorded `task.queued`/`task.running` for guardrail-driven edges. The
   * force-fail path additionally records its CAUSE-specific event before calling
   * this (see {@link forceFail}).
   */
  private async safeTransition(taskId: string, next: TaskStatus): Promise<void> {
    try {
      await this.tasks.transition(taskId, next);
    } catch (err) {
      this.logger.debug(
        `guardrail transition ${taskId} -> ${next} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Run a best-effort audit recording call, guaranteeing it NEVER throws into the
   * transition path (6.2). The recorder itself swallows persistence failures, but
   * this is a defensive second layer: even a synchronous throw or a rejected
   * promise from the (optional) recorder is caught and logged here, so the
   * guardrail transition/force-fail path can never be affected by audit failure.
   */
  private async recordAudit(call: () => Promise<void> | undefined): Promise<void> {
    try {
      await call();
    } catch (err) {
      this.logger.debug(
        `guardrail audit record failed (swallowed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Inspectors (for diagnostics / tests)
  // -------------------------------------------------------------------------

  get runningCount(): number {
    return this.semaphore.runningCount;
  }

  get queuedCount(): number {
    return this.semaphore.queuedCount;
  }

  /** The sandbox mode the bound provider reports, when wired (9.1b). */
  sandboxMode(): string | null {
    return this.sandbox?.getSandboxMode() ?? null;
  }

  // -------------------------------------------------------------------------
  // Metrics projection sources (be-metrics 5.1 / 5.2 / 5.4)
  // -------------------------------------------------------------------------

  /**
   * A LIVE, read-only projection source over the concurrency semaphore for the
   * derived capacity block (5.1 / 5.2). Every property/method delegates directly
   * to the semaphore, so a `/metrics` read reflects the exact admission state at
   * request time — there is NO parallel counter that could drift. The metrics
   * layer's pure projection/slot-table builders consume this view.
   */
  semaphoreProjection(): SemaphoreProjectionSource {
    const semaphore = this.semaphore;
    return {
      get maxConcurrentTasks() {
        return semaphore.maxConcurrentTasks;
      },
      get runningCount() {
        return semaphore.runningCount;
      },
      get queuedCount() {
        return semaphore.queuedCount;
      },
      snapshotRunning: () => semaphore.snapshotRunning(),
      snapshotQueue: () => semaphore.snapshotQueue(),
    };
  }

  /** Observed running intervals for the derived runner-minutes metric (5.4). */
  runnerMinuteIntervals(): RunningInterval[] {
    return this.runnerMinutes.intervals();
  }
}
