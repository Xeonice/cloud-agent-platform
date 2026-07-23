import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  TaskFailureCodeSchema,
  TaskProvisioningStageSchema,
  type TaskProvisioningStage,
  type TaskStatus,
} from '@cap/contracts';
import { canTransition, isTerminal } from '../tasks/task-lifecycle';
import type { TaskAdmissionWakePort } from '../tasks/task-admission-gate';
import {
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionRetryPolicy,
  TaskAdmissionScheduler,
  TASK_ADMISSION_WORKER_OPTIONS,
  validateTaskAdmissionWorkerOptions,
  type TaskAdmissionTimer,
  type TaskAdmissionWorkerOptions,
} from './task-admission-runtime';
import {
  TASK_ADMISSION_PROCESSOR_TOKEN,
  TaskAdmissionCoordinationError,
  TaskAdmissionLeaseLostError,
  TaskAdmissionProcessingError,
  TaskAdmissionProcessorUnavailableError,
  TaskAdmissionStore,
  type TaskAdmissionClaim,
  type TaskAdmissionCancellationPort,
  type TaskAdmissionLeaseControls,
  type TaskAdmissionParkedJobPort,
  type TaskAdmissionProcessResult,
  type TaskAdmissionProcessor,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRunOutcome,
  type TaskAdmissionSettlement,
  type TaskAdmissionTaskFence,
  type TaskAdmissionTerminalRecovery,
  type TaskAdmissionTerminalFailure,
} from './task-admission.types';
import type { ProvisioningTaskFailureCode } from '../tasks/task-failure';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '../audit/audit-recorder.port';

export interface TaskAdmissionWorkerErrorReporter {
  report(error: unknown): void;
}

export const TASK_ADMISSION_WORKER_ERROR_REPORTER = Symbol(
  'TASK_ADMISSION_WORKER_ERROR_REPORTER',
);

// Retry is an orchestrator decision, never an unchecked provider hint. The
// current safe vocabulary has one explicitly transient infrastructure class;
// capacity, timeout, auth, ref and unknown failures settle deterministically.
const RETRYABLE_TASK_ADMISSION_CAUSES = new Set<ProvisioningTaskFailureCode>([
  'provisioning_tls_network_failed',
]);

const TASK_ADMISSION_STAGE_ORDER = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
] as const satisfies readonly TaskProvisioningStage[];

@Injectable()
export class SafeTaskAdmissionWorkerErrorReporter
  implements TaskAdmissionWorkerErrorReporter
{
  private readonly logger = new Logger('TaskAdmissionWorker');

  report(_error: unknown): void {
    // Never interpolate a provider/SQL error: it may carry raw diagnostics.
    this.logger.error(
      'task admission background coordination failed; the durable lease remains recoverable',
    );
  }
}

/** Fail-closed fallback retained for isolated coordination tests. */
@Injectable()
export class UnboundTaskAdmissionProcessor implements TaskAdmissionProcessor {
  async process(): Promise<TaskAdmissionProcessResult> {
    // A missing 5.3 binding must never permanently fail otherwise valid work.
    // The worker leaves the lease intact so DB-time expiry can recover it.
    throw new TaskAdmissionProcessorUnavailableError();
  }
}

/**
 * Durable lease coordinator. This class deliberately owns no capacity counter,
 * Guardrails call, or provider operation: cross-replica capacity reservation and
 * every external-boundary status fence belong to the 5.3 processor/DB fence.
 * It intentionally does not implement an independent Nest bootstrap hook.
 * TasksService owns the ordered startup coordinator and starts polling only
 * after readoption, orphan reconciliation, ceiling restore, and legacy FIFO
 * recovery have completed.
 *
 * Parked detached-transfer recovery (detach-workspace-clone D9) deliberately
 * rides this same claim query: a parked row becomes claimable when its job
 * settles or its lease/liveness gates expire, and the claimed processor — not
 * any bootstrap hook — performs the marker probe triage (alive keeps it
 * parked, exit marker settles, unprovable fails the attempt). Boot recovery of
 * parked work therefore needs no ordering guarantee relative to provider
 * re-adoption scans.
 */
@Injectable()
export class TaskAdmissionWorker
  implements TaskAdmissionWakePort, TaskAdmissionCancellationPort
{
  private started = false;
  private lifecycleGeneration = 0;
  private wakeGeneration = 0;
  private drainRequested = false;
  private kickTimer: TaskAdmissionTimer | null = null;
  private pollTimer: TaskAdmissionTimer | null = null;
  private backgroundDrain: Promise<void> | null = null;
  private readonly activeClaimRuns = new Map<
    string,
    {
      readonly taskId: string;
      readonly controller: AbortController;
      readonly operation: Promise<TaskAdmissionRunOutcome>;
    }
  >();
  /**
   * Parked detached-transfer claims observed by the lightweight marker poll
   * loop. Deliberately outside drainClaims' maxInFlight accounting and the
   * activeClaimRuns dispatch pool: the loop observes markers, heartbeats the
   * parked lease, and re-enqueues via the expired-lease branch + wake(). It
   * never admits, never touches slots, and never reads the DB on the offer()
   * hot path. Entries do not survive a restart — recovery rides lease expiry.
   */
  private readonly parkedClaims = new Map<
    string,
    {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly job: TaskAdmissionParkedJobPort;
    }
  >();
  private parkedTimer: TaskAdmissionTimer | null = null;
  private parkedTick: Promise<void> | null = null;
  private readonly options: TaskAdmissionWorkerOptions;
  private readonly retryPolicy: TaskAdmissionRetryPolicy;
  private lastBackgroundFailure: unknown = null;

  constructor(
    private readonly store: TaskAdmissionStore,
    @Inject(TASK_ADMISSION_PROCESSOR_TOKEN)
    private readonly processor: TaskAdmissionProcessor,
    private readonly scheduler: TaskAdmissionScheduler,
    private readonly clock: TaskAdmissionClock,
    private readonly leaseTokens: TaskAdmissionLeaseTokenFactory,
    @Inject(TASK_ADMISSION_WORKER_OPTIONS)
    options: TaskAdmissionWorkerOptions,
    @Optional()
    @Inject(TASK_ADMISSION_WORKER_ERROR_REPORTER)
    private readonly errorReporter?: TaskAdmissionWorkerErrorReporter,
    @Optional()
    @Inject(AUDIT_RECORDER_TOKEN)
    private readonly audit?: AuditRecorderPort,
  ) {
    this.options = validateTaskAdmissionWorkerOptions(options);
    this.retryPolicy = new TaskAdmissionRetryPolicy(this.options);
  }

  /** Generation-only signal. Database polling remains the durable authority. */
  wake(_taskId: string): void {
    this.wakeGeneration += 1;
    if (!this.started) return;
    this.drainRequested = true;
    this.requestBackgroundDrain();
  }

  /** Same-process fast path; automatic DB-fenced renewal covers other replicas. */
  abortTask(taskId: string): void {
    for (const active of this.activeClaimRuns.values()) {
      if (active.taskId !== taskId) continue;
      abortLease(active.controller, new TaskAdmissionLeaseLostError(taskId));
    }
  }

  /**
   * Parked-aware stop seam (kill via pid marker). Best-effort in-process fast
   * path: kill the detached job, then hand the row back to the claim path so
   * the standard fence/cleanup chain settles the stop. Never settles here.
   */
  async killParkedTask(taskId: string): Promise<boolean> {
    const parked = this.parkedClaims.get(taskId);
    if (!parked) return false;
    this.parkedClaims.delete(taskId);
    try {
      // Idempotent by the detached-job contract: killing an already-exited
      // job is a safe no-op and settlement still reads the exit marker.
      await parked.job.kill();
    } catch (error) {
      this.errorReporter?.report(error);
    }
    try {
      await this.store.releaseParked({
        taskId: parked.taskId,
        leaseToken: parked.leaseToken,
      });
    } catch (error) {
      // The parked lease still expires on its own; recovery is only delayed.
      this.errorReporter?.report(error);
    }
    this.wake(taskId);
    return true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lifecycleGeneration += 1;
    this.drainRequested = true;
    this.requestBackgroundDrain();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.lifecycleGeneration += 1;
    this.drainRequested = false;
    this.cancelTimer('kick');
    this.cancelTimer('poll');
    this.parkedTimer?.cancel();
    this.parkedTimer = null;
    for (const { controller } of this.activeClaimRuns.values()) {
      abortLease(controller, new TaskAdmissionLeaseLostError('shutdown'));
    }
    await this.waitForBackgroundIdle();
    await this.waitForClaimRunsIdle();
    await this.parkedTick;
    // Parked rows stay durable and leased; after a restart they are recovered
    // through the expired-lease claim branch, never from process memory.
    this.parkedClaims.clear();
  }

  /** Claim and process at most one row; useful for deterministic/manual runs. */
  async runOnce(): Promise<TaskAdmissionRunOutcome> {
    const claim = await this.claimNext();
    if (!claim) return { kind: 'idle' };
    return this.runClaim(claim);
  }

  /**
   * Drain the database floor through a bounded local dispatch pool. This width
   * is not a cross-replica capacity reservation; 5.3 will bind effective
   * Guardrails/provider capacity before any external boundary.
   */
  async drain(): Promise<number> {
    return this.drainClaims();
  }

  private async drainClaims(
    canDispatch?: () => boolean,
  ): Promise<number> {
    let processed = 0;
    let firstFailure: unknown = null;
    let acceptingClaims = true;
    const dispatched = new Set<Promise<void>>();

    const dispatch = (claim: TaskAdmissionClaim) => {
      const operation: Promise<void> = this.runClaim(claim)
        .then(
          () => undefined,
          (error: unknown) => {
            firstFailure ??= error;
          },
        )
        .finally(() => dispatched.delete(operation));
      dispatched.add(operation);
    };

    for (;;) {
      while (
        firstFailure === null &&
        acceptingClaims &&
        dispatched.size < this.options.maxInFlight
      ) {
        if (canDispatch && !canDispatch()) {
          acceptingClaims = false;
          break;
        }
        let claim: TaskAdmissionClaim | null;
        try {
          claim = await this.claimNext();
        } catch (error) {
          firstFailure = error;
          break;
        }
        if (!claim) {
          acceptingClaims = false;
          break;
        }
        if (canDispatch && !canDispatch()) {
          // The durable lease was acquired after this background generation
          // stopped. Do not start an external boundary; DB-time expiry is the
          // only authority that may make the row claimable again.
          acceptingClaims = false;
          break;
        }
        processed += 1;
        // No await may be introduced between the lifecycle fence above and
        // runClaim's synchronous activeClaimRuns registration.
        dispatch(claim);
      }

      if (firstFailure !== null) {
        await Promise.all(dispatched);
        throw firstFailure;
      }
      if (dispatched.size === 0) return processed;
      await Promise.race(dispatched);
    }
  }

  get backgroundFailure(): unknown {
    return this.lastBackgroundFailure;
  }

  async waitForBackgroundIdle(): Promise<void> {
    while (this.backgroundDrain) {
      await this.backgroundDrain;
    }
  }

  async waitForClaimRunsIdle(): Promise<void> {
    while (this.activeClaimRuns.size > 0) {
      await Promise.allSettled(
        [...this.activeClaimRuns.values()].map(({ operation }) => operation),
      );
    }
  }

  private async claimNext(): Promise<TaskAdmissionClaim | null> {
    void this.clock.now();
    return this.store.claim({
      leaseToken: this.leaseTokens.create(),
      leaseDurationMs: this.options.leaseDurationMs,
    });
  }

  private runClaim(claim: TaskAdmissionClaim): Promise<TaskAdmissionRunOutcome> {
    const controller = new AbortController();
    const operation: Promise<TaskAdmissionRunOutcome> = this.processClaim(
      claim,
      controller,
    ).finally(() => {
      const current = this.activeClaimRuns.get(claim.leaseToken);
      if (current?.operation === operation) {
        this.activeClaimRuns.delete(claim.leaseToken);
      }
    });
    this.activeClaimRuns.set(claim.leaseToken, {
      taskId: claim.taskId,
      controller,
      operation,
    });
    return operation;
  }

  private async processClaim(
    claim: TaskAdmissionClaim,
    controller: AbortController,
  ): Promise<TaskAdmissionRunOutcome> {
    const terminalClaim = isTerminal(claim.taskStatus);
    if (terminalClaim && !this.processor.recoverTerminal) {
      return this.settleClaim(claim, {
        state: 'cancelled',
        stage: claim.stage,
      });
    }

    const authority = new TaskAdmissionTaskAuthority(claim);
    const renewal = this.startAutomaticRenewal(claim, controller, authority);
    const lease = this.leaseControls(claim, controller, authority);
    const processorContext = {
      claim,
      lease,
      signal: controller.signal,
    } as const;
    let result: TaskAdmissionProcessResult | null = null;
    let terminalRecovery: TaskAdmissionTerminalRecovery | null = null;
    let processingError: unknown = null;
    try {
      // Claim already advanced the durable work state/attempt. Audit follows
      // that source of truth and is strictly best-effort.
      this.dispatchAudit(() =>
        this.audit?.recordProvisioningProgress(
          claim.taskId,
          claim.stage,
          claim.attempt,
        ),
      );
      try {
        if (terminalClaim) {
          terminalRecovery = await this.processor.recoverTerminal!(processorContext);
        } else {
          result = await this.processor.process(processorContext);
        }
      } catch (error) {
        processingError = error;
      }

      if (renewal.coordinationFailure) {
        throw renewal.coordinationFailure;
      }
      if (processingError instanceof TaskAdmissionCoordinationError) {
        throw processingError;
      }
      if (
        controller.signal.reason instanceof TaskAdmissionCoordinationError
      ) {
        throw controller.signal.reason;
      }
      if (processingError instanceof TaskAdmissionProcessorUnavailableError) {
        throw processingError;
      }
      if (renewal.leaseLost || controller.signal.aborted) {
        return leaseLostOutcome(claim);
      }
      if (processingError instanceof TaskAdmissionLeaseLostError) {
        return leaseLostOutcome(claim);
      }
      if (processingError !== null) {
        // Await inside the renewal scope: terminal settlement may perform a
        // long exact-owner teardown before its second fenced DB phase.
        return await this.settleProcessingFailure(
          claim,
          processingError,
          authority,
          processorContext,
        );
      }
      if (terminalRecovery) {
        if (terminalRecovery.state === 'succeeded') {
          return await this.settleClaim(
            claim,
            { state: 'succeeded', stage: 'complete' },
            authority,
          );
        }
        return await this.settleClaim(
          claim,
          terminalRecovery.state === 'failed'
            ? {
                state: 'failed',
                stage: terminalRecovery.stage,
                causeCode: terminalRecovery.causeCode,
              }
            : {
                state: 'cancelled',
                stage: terminalRecovery.stage,
              },
          authority,
        );
      }
      return await this.settleProcessResult(claim, result, authority);
    } finally {
      await renewal.stop();
    }
  }

  private leaseControls(
    claim: TaskAdmissionClaim,
    controller: AbortController,
    authority: TaskAdmissionTaskAuthority,
  ): TaskAdmissionLeaseControls {
    return {
      currentTaskFence: () => authority.currentFence,
      beginTaskTransition: (nextStatuses) =>
        authority.beginTransition(nextStatuses),
      commitTaskTransition: (fence) => authority.commitTransition(fence),
      rollbackTaskTransition: () => authority.rollbackTransition(),
      authorize: async () => {
        assertLeaseSignal(controller.signal, claim.taskId);
        let authorized: boolean;
        try {
          authorized = await this.store.authorize({
            taskId: claim.taskId,
            leaseToken: claim.leaseToken,
            taskFences: authority.acceptedFences,
          });
        } catch (error) {
          const coordination = new TaskAdmissionCoordinationError(
            'checkpoint',
            claim.taskId,
            error,
          );
          abortLease(controller, coordination);
          throw coordination;
        }
        if (!authorized) {
          const lost = new TaskAdmissionLeaseLostError(claim.taskId);
          abortLease(controller, lost);
          throw lost;
        }
        assertLeaseSignal(controller.signal, claim.taskId);
      },
      renew: async () => {
        assertLeaseSignal(controller.signal, claim.taskId);
        let renewed: boolean;
        try {
          renewed = await this.store.renew({
            taskId: claim.taskId,
            leaseToken: claim.leaseToken,
            leaseDurationMs: this.options.leaseDurationMs,
            taskFences: authority.acceptedFences,
          });
        } catch (error) {
          const coordination = new TaskAdmissionCoordinationError(
            'renew',
            claim.taskId,
            error,
          );
          abortLease(controller, coordination);
          throw coordination;
        }
        if (!renewed) {
          const lost = new TaskAdmissionLeaseLostError(claim.taskId);
          abortLease(controller, lost);
          throw lost;
        }
        assertLeaseSignal(controller.signal, claim.taskId);
      },
      transferProgress: async (stage, progress) => {
        // Best-effort (chunk-archive-injection-with-progress D2): progress is
        // an output stream, never authority. A fenced or failed write is
        // swallowed — unlike `checkpoint`, it must not abort the lease.
        try {
          const parsedStage = TaskProvisioningStageSchema.parse(stage);
          if (stageIndex(parsedStage) < stageIndex(authority.stage)) return;
          await this.store.checkpoint({
            taskId: claim.taskId,
            leaseToken: claim.leaseToken,
            stage: parsedStage,
            taskFences: [authority.currentFence],
            progress,
          });
        } catch {
          // Durable admission state stays authoritative without the snapshot.
        }
      },
      checkpoint: async (stage) => {
        assertLeaseSignal(controller.signal, claim.taskId);
        const parsedStage = TaskProvisioningStageSchema.parse(stage);
        if (stageIndex(parsedStage) < stageIndex(authority.stage)) {
          // Recovery may have to replay provider setup from an earlier physical
          // step than the durable progress projection. Do not regress the
          // stored stage, but retain the load-bearing Task+lease authority check.
          let authorized: boolean;
          try {
            authorized = await this.store.authorize({
              taskId: claim.taskId,
              leaseToken: claim.leaseToken,
              taskFences: [authority.currentFence],
            });
          } catch (error) {
            const coordination = new TaskAdmissionCoordinationError(
              'checkpoint',
              claim.taskId,
              error,
            );
            abortLease(controller, coordination);
            throw coordination;
          }
          if (!authorized) {
            const lost = new TaskAdmissionLeaseLostError(claim.taskId);
            abortLease(controller, lost);
            throw lost;
          }
          assertLeaseSignal(controller.signal, claim.taskId);
          return;
        }
        let checkpointed: boolean;
        try {
          checkpointed = await this.store.checkpoint({
            taskId: claim.taskId,
            leaseToken: claim.leaseToken,
            stage: parsedStage,
            taskFences: [authority.currentFence],
          });
        } catch (error) {
          const coordination = new TaskAdmissionCoordinationError(
            'checkpoint',
            claim.taskId,
            error,
          );
          abortLease(controller, coordination);
          throw coordination;
        }
        if (!checkpointed) {
          const lost = new TaskAdmissionLeaseLostError(claim.taskId);
          abortLease(controller, lost);
          throw lost;
        }
        authority.advanceStage(parsedStage);
        assertLeaseSignal(controller.signal, claim.taskId);
        this.dispatchAudit(() =>
          this.audit?.recordProvisioningProgress(
            claim.taskId,
            parsedStage,
            claim.attempt,
          ),
        );
      },
    };
  }

  private startAutomaticRenewal(
    claim: TaskAdmissionClaim,
    controller: AbortController,
    authority: TaskAdmissionTaskAuthority,
  ): {
    readonly stop: () => Promise<void>;
    readonly leaseLost: boolean;
    readonly coordinationFailure: TaskAdmissionCoordinationError | null;
  } {
    let active = true;
    let timer: TaskAdmissionTimer | null = null;
    let inFlight: Promise<void> | null = null;
    let leaseLost = false;
    let coordinationFailure: TaskAdmissionCoordinationError | null = null;

    const schedule = () => {
      if (
        !active ||
        leaseLost ||
        coordinationFailure ||
        controller.signal.aborted
      ) {
        return;
      }
      timer = this.scheduler.schedule(this.options.renewIntervalMs, () => {
        timer = null;
        if (controller.signal.aborted) return;
        inFlight = (async () => {
          try {
            const renewed = await this.store.renew({
              taskId: claim.taskId,
              leaseToken: claim.leaseToken,
              leaseDurationMs: this.options.leaseDurationMs,
              taskFences: authority.acceptedFences,
            });
            if (!renewed) {
              leaseLost = true;
              abortLease(
                controller,
                new TaskAdmissionLeaseLostError(claim.taskId),
              );
            }
          } catch (error) {
            coordinationFailure = new TaskAdmissionCoordinationError(
              'renew',
              claim.taskId,
              error,
            );
            abortLease(controller, coordinationFailure);
          } finally {
            inFlight = null;
            schedule();
          }
        })();
      });
    };
    schedule();

    return {
      async stop() {
        active = false;
        timer?.cancel();
        timer = null;
        await inFlight;
      },
      get leaseLost() {
        return leaseLost;
      },
      get coordinationFailure() {
        return coordinationFailure;
      },
    };
  }

  private async settleProcessResult(
    claim: TaskAdmissionClaim,
    result: TaskAdmissionProcessResult | null,
    authority: TaskAdmissionTaskAuthority,
  ): Promise<TaskAdmissionRunOutcome> {
    if (result?.kind === 'succeeded') {
      return this.settleClaim(
        claim,
        { state: 'succeeded', stage: 'complete' },
        authority,
      );
    }
    if (result?.kind === 'queued') {
      const stage = safeStageAtOrAfter(result.stage, authority.stage);
      const retryAfterMs = positiveDelayOrDefault(
        result.retryAfterMs,
        this.options.queuedRetryAfterMs,
      );
      return this.settleClaim(claim, {
        state: 'queued',
        stage,
        availableAfterMs: retryAfterMs,
      }, authority);
    }
    if (result?.kind === 'cancelled') {
      return this.settleClaim(claim, {
        state: 'cancelled',
        stage: safeStageAtOrAfter(result.stage, authority.stage),
      }, authority);
    }
    if (result?.kind === 'parked') {
      // A thrown database failure escapes like settle: the row stays
      // running/leased and DB-time expiry recovers it.
      const parked = await this.store.park({
        taskId: claim.taskId,
        leaseToken: claim.leaseToken,
        taskFences: [authority.currentFence],
        settlement: {
          state: 'parked',
          stage: safeStageAtOrAfter(result.stage, authority.stage),
          leaseDurationMs: this.options.leaseDurationMs,
        },
      });
      if (!parked) return leaseLostOutcome(claim);
      // Registration is synchronous after the durable settlement so the
      // marker loop can only ever observe a row that is truly parked.
      this.registerParkedClaim(claim, result.job);
      return {
        kind: 'parked',
        taskId: claim.taskId,
        attempt: claim.attempt,
      };
    }
    // Invalid/unknown processor results are terminal and contain no raw detail.
    return this.settleClaim(claim, {
      state: 'failed',
      stage: authority.stage,
      causeCode: 'provisioning_unknown',
    }, authority);
  }

  private async settleProcessingFailure(
    claim: TaskAdmissionClaim,
    error: unknown,
    authority: TaskAdmissionTaskAuthority,
    processorContext: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionRunOutcome> {
    const classified = safeProcessingFailure(error, authority.stage);
    if (
      classified.retryable &&
      RETRYABLE_TASK_ADMISSION_CAUSES.has(classified.causeCode) &&
      this.retryPolicy.canRetry(claim.attempt)
    ) {
      return this.settleClaim(claim, {
        state: 'retrying',
        stage: classified.stage,
        causeCode: classified.causeCode,
        availableAfterMs: this.retryPolicy.delayMs(
          claim.taskId,
          claim.attempt,
        ),
      }, authority);
    }
    const terminalFailure: TaskAdmissionTerminalFailure = {
      causeCode: classified.causeCode,
      stage: classified.stage,
    };
    if (this.processor.settleTerminalFailure) {
      const terminalFence = authority.beginTerminalFailureTransition();
      let settled: boolean;
      try {
        settled = await this.processor.settleTerminalFailure(
          processorContext,
          terminalFailure,
        );
      } catch (error) {
        // Keep the declared terminal successor visible to automatic renewal
        // until processClaim's outer finally has stopped it. Phase 1 may have
        // committed before exact sandbox cleanup failed.
        throw new TaskAdmissionCoordinationError(
          'checkpoint',
          claim.taskId,
          error,
        );
      }
      if (!settled) {
        authority.rollbackTransition();
        return leaseLostOutcome(claim);
      }
      authority.commitTransition(terminalFence);
      return {
        kind: 'failed',
        taskId: claim.taskId,
        attempt: claim.attempt,
      };
    }
    return this.settleClaim(claim, {
      state: 'failed',
      stage: terminalFailure.stage,
      causeCode: terminalFailure.causeCode,
    }, authority);
  }

  private async settleClaim(
    claim: TaskAdmissionClaim,
    settlement: TaskAdmissionSettlement,
    authority?: TaskAdmissionTaskAuthority,
  ): Promise<TaskAdmissionRunOutcome> {
    // A thrown database failure is intentionally allowed to escape. The row
    // remains running/leased and is recovered only after DB-time expiry.
    const settled = await this.store.settle({
      taskId: claim.taskId,
      leaseToken: claim.leaseToken,
      taskFences: [authority?.currentFence ?? taskFenceFromClaim(claim)],
      settlement,
    });
    if (!settled) return leaseLostOutcome(claim);
    return {
      kind: settlement.state,
      taskId: claim.taskId,
      attempt: claim.attempt,
    };
  }

  private registerParkedClaim(
    claim: TaskAdmissionClaim,
    job: TaskAdmissionParkedJobPort,
  ): void {
    // One admission-work row per task: a re-parked task replaces its entry.
    this.parkedClaims.set(claim.taskId, {
      taskId: claim.taskId,
      leaseToken: claim.leaseToken,
      job,
    });
    this.armParkedPolling();
  }

  private armParkedPolling(): void {
    // Deliberately not gated on `started`: a claim parked through a manual
    // runOnce() is still observed. stop() cancels the timer and clears the
    // watch set; durable recovery then rides parked lease expiry.
    if (this.parkedTimer || this.parkedTick || this.parkedClaims.size === 0) {
      return;
    }
    this.parkedTimer = this.scheduler.schedule(
      this.options.renewIntervalMs,
      () => {
        this.parkedTimer = null;
        const tick = this.runParkedTick().finally(() => {
          if (this.parkedTick === tick) this.parkedTick = null;
          this.armParkedPolling();
        });
        this.parkedTick = tick;
      },
    );
  }

  private async runParkedTick(): Promise<void> {
    for (const parked of [...this.parkedClaims.values()]) {
      if (this.parkedClaims.get(parked.taskId) !== parked) continue;
      await this.observeParkedClaim(parked);
    }
  }

  /**
   * One marker observation. Alive extends the parked lease and persists the
   * latest progress snapshot; exited/unknown hands the row back to the claim
   * path (exit marker = settlement proof, and only the claimed processor may
   * settle — success is never inferred here, least of all from silence).
   */
  private async observeParkedClaim(parked: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly job: TaskAdmissionParkedJobPort;
  }): Promise<void> {
    let observation;
    try {
      observation = await parked.job.probe();
    } catch (error) {
      // A transient probe failure keeps the entry; a persistent one lets the
      // parked lease expire so the claim path recovers the row durably.
      this.errorReporter?.report(error);
      return;
    }
    if (observation.kind === 'alive') {
      let alive: boolean;
      try {
        alive = await this.store.parkedHeartbeat({
          taskId: parked.taskId,
          leaseToken: parked.leaseToken,
          leaseDurationMs: this.options.leaseDurationMs,
          progress: observation.progress ?? null,
        });
      } catch (error) {
        this.errorReporter?.report(error);
        return;
      }
      // A refused heartbeat means the row was resumed or superseded; this
      // watcher must never resurrect it.
      if (!alive) this.parkedClaims.delete(parked.taskId);
      return;
    }
    try {
      await this.store.releaseParked({
        taskId: parked.taskId,
        leaseToken: parked.leaseToken,
      });
    } catch (error) {
      this.errorReporter?.report(error);
      return;
    }
    this.parkedClaims.delete(parked.taskId);
    // Re-entry happens only through the semaphore/worker claim path under a
    // new lease token; the parked loop performs no admission of its own.
    this.wake(parked.taskId);
  }

  private requestBackgroundDrain(): void {
    if (!this.started) return;
    this.cancelTimer('poll');
    if (this.backgroundDrain || this.kickTimer) return;
    const generation = this.lifecycleGeneration;
    this.kickTimer = this.scheduler.schedule(0, () => {
      this.kickTimer = null;
      this.launchBackgroundDrain(generation);
    });
  }

  private dispatchAudit(
    call: () => Promise<void> | undefined,
  ): void {
    let operation: Promise<void> | undefined;
    try {
      operation = call();
    } catch {
      this.reportAuditFailure();
      return;
    }
    // Progress follows the durable checkpoint. A slow or permanently pending
    // audit store must never hold the controlled provisioning action.
    void operation?.catch(() => this.reportAuditFailure());
  }

  private reportAuditFailure(): void {
    // Never include the rejected value: a non-conforming recorder could carry
    // provider or Git diagnostics. Durable work remains the source of truth.
    this.errorReporter?.report(
      new Error('task admission audit persistence failed'),
    );
  }

  private launchBackgroundDrain(generation: number): void {
    if (!this.isBackgroundGenerationActive(generation) || this.backgroundDrain) {
      return;
    }
    const operation = this.performBackgroundDrain(generation);
    this.backgroundDrain = operation;
    void operation.finally(() => {
      if (this.backgroundDrain === operation) this.backgroundDrain = null;
      if (this.isBackgroundGenerationActive(generation)) {
        if (this.drainRequested) this.requestBackgroundDrain();
        else this.armPollingFloor();
        return;
      }
      // A stop/start may create a new generation while the old claim call is
      // still returning. Its start request was blocked by backgroundDrain;
      // hand off only to the current generation after the old one is cleared.
      if (this.started && this.drainRequested) this.requestBackgroundDrain();
    });
  }

  private async performBackgroundDrain(generation: number): Promise<void> {
    try {
      do {
        this.drainRequested = false;
        const observedGeneration = this.wakeGeneration;
        await this.drainClaims(() =>
          this.isBackgroundGenerationActive(generation),
        );
        if (this.wakeGeneration !== observedGeneration) {
          this.drainRequested = true;
        }
      } while (
        this.isBackgroundGenerationActive(generation) &&
        this.drainRequested
      );
    } catch (error) {
      this.lastBackgroundFailure = error;
      this.errorReporter?.report(error);
      // The failed claim/lease remains authoritative in the database. A poll,
      // never a fabricated local success, will retry after it is claimable.
    }
  }

  private armPollingFloor(): void {
    if (!this.started || this.pollTimer) return;
    this.pollTimer = this.scheduler.schedule(this.options.pollIntervalMs, () => {
      this.pollTimer = null;
      this.drainRequested = true;
      this.requestBackgroundDrain();
    });
  }

  private isBackgroundGenerationActive(generation: number): boolean {
    return this.started && this.lifecycleGeneration === generation;
  }

  private cancelTimer(kind: 'kick' | 'poll'): void {
    const timer = kind === 'kick' ? this.kickTimer : this.pollTimer;
    timer?.cancel();
    if (kind === 'kick') this.kickTimer = null;
    else this.pollTimer = null;
  }
}

function safeProcessingFailure(
  error: unknown,
  fallbackStage: TaskProvisioningStage,
): {
  readonly causeCode: ProvisioningTaskFailureCode;
  readonly stage: TaskProvisioningStage;
  readonly retryable: boolean;
} {
  if (error instanceof TaskAdmissionProcessingError) {
    const parsedCode = TaskFailureCodeSchema.safeParse(error.causeCode);
    if (
      parsedCode.success &&
      parsedCode.data.startsWith('provisioning_')
    ) {
      return {
        causeCode: parsedCode.data as ProvisioningTaskFailureCode,
        stage: safeStageAtOrAfter(error.stage, fallbackStage),
        retryable: error.retryable === true,
      };
    }
  }
  return {
    causeCode: 'provisioning_unknown',
    stage: fallbackStage,
    retryable: false,
  };
}

function safeStageAtOrAfter(
  value: unknown,
  fallback: TaskProvisioningStage,
): TaskProvisioningStage {
  const parsed = TaskProvisioningStageSchema.safeParse(value);
  if (!parsed.success) return fallback;
  return TASK_ADMISSION_STAGE_ORDER.indexOf(parsed.data) >=
    TASK_ADMISSION_STAGE_ORDER.indexOf(fallback)
    ? parsed.data
    : fallback;
}

function positiveDelayOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function abortLease(controller: AbortController, reason: Error): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function assertLeaseSignal(signal: AbortSignal, taskId: string): void {
  if (signal.aborted) throw new TaskAdmissionLeaseLostError(taskId);
}

function leaseLostOutcome(
  claim: TaskAdmissionClaim,
): TaskAdmissionRunOutcome {
  return {
    kind: 'lease-lost',
    taskId: claim.taskId,
    attempt: claim.attempt,
  };
}

class TaskAdmissionTaskAuthority {
  private current: TaskAdmissionTaskFence;
  private transitionTargets: readonly TaskAdmissionTaskFence[] = [];
  private currentStage: TaskProvisioningStage;

  constructor(claim: TaskAdmissionClaim) {
    this.current = freezeTaskFence(taskFenceFromClaim(claim));
    this.currentStage = claim.stage;
  }

  get currentFence(): TaskAdmissionTaskFence {
    return this.current;
  }

  get acceptedFences(): readonly TaskAdmissionTaskFence[] {
    return Object.freeze([this.current, ...this.transitionTargets]);
  }

  get stage(): TaskProvisioningStage {
    return this.currentStage;
  }

  beginTransition(
    nextStatuses: readonly Extract<TaskStatus, 'queued' | 'running'>[],
  ): number {
    if (this.transitionTargets.length > 0) {
      throw new Error('Task admission lifecycle transition is already active');
    }
    const statuses = [...new Set(nextStatuses)];
    if (statuses.length === 0) {
      throw new Error('Task admission lifecycle transition requires a target');
    }
    for (const status of statuses) {
      if (!canTransition(this.current.status, status)) {
        throw new Error(
          `Task admission cannot declare ${this.current.status} -> ${status}`,
        );
      }
    }
    const nextVersion = this.current.lifecycleVersion + 1;
    this.transitionTargets = Object.freeze(
      statuses.map((status) =>
        freezeTaskFence({
          status,
          lifecycleVersion: nextVersion,
        }),
      ),
    );
    return nextVersion;
  }

  beginTerminalFailureTransition(): TaskAdmissionTaskFence {
    if (this.transitionTargets.length > 0) {
      throw new Error('Task admission lifecycle transition is already active');
    }
    if (!canTransition(this.current.status, 'failed')) {
      throw new Error(
        `Task admission cannot declare ${this.current.status} -> failed`,
      );
    }
    const target = freezeTaskFence({
      status: 'failed',
      lifecycleVersion: this.current.lifecycleVersion + 1,
    });
    this.transitionTargets = Object.freeze([target]);
    return target;
  }

  commitTransition(fence: TaskAdmissionTaskFence): void {
    const target = this.transitionTargets.find(
      (candidate) =>
        candidate.status === fence.status &&
        candidate.lifecycleVersion === fence.lifecycleVersion,
    );
    if (!target) {
      throw new Error('Task admission lifecycle CAS returned an undeclared fence');
    }
    this.current = target;
    this.transitionTargets = [];
  }

  rollbackTransition(): void {
    this.transitionTargets = [];
  }

  advanceStage(stage: TaskProvisioningStage): void {
    if (stageIndex(stage) > stageIndex(this.currentStage)) {
      this.currentStage = stage;
    }
  }
}

function taskFenceFromClaim(claim: TaskAdmissionClaim): TaskAdmissionTaskFence {
  return {
    status: claim.taskStatus,
    lifecycleVersion: claim.taskLifecycleVersion,
  };
}

function freezeTaskFence(
  fence: TaskAdmissionTaskFence,
): TaskAdmissionTaskFence {
  return Object.freeze({
    status: fence.status,
    lifecycleVersion: fence.lifecycleVersion,
  });
}

function stageIndex(stage: TaskProvisioningStage): number {
  return TASK_ADMISSION_STAGE_ORDER.indexOf(stage);
}
