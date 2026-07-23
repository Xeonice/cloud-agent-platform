import type {
  TaskProvisioningStage,
  TaskStatus,
} from '@cap/contracts';
import type { SandboxResourceSnapshot } from '@cap/sandbox';
import type { ProvisioningTaskFailureCode } from '../tasks/task-failure';

export type TaskAdmissionClaimSourceState =
  | 'accepted'
  | 'queued'
  | 'retrying'
  | 'running'
  /**
   * A detached workspace transfer released its worker slot while the clone
   * continues inside the sandbox. A parked row stays leased: the retained
   * lease owner is the parked ownership generation and lease expiry is the
   * recovery horizon, so resume and restart recovery both ride the existing
   * expired-lease claim branch. Claiming parked work never burns, increments,
   * or resets the attempt counter — parking is not a retry event.
   */
  | 'parked'
  /**
   * A normally launched durable task releases its provisioning lease while the
   * Task and generation-fenced SandboxRun continue running.  Once that Task is
   * terminal, the same work row is claimable again solely for exact-owner
   * cleanup recovery; it is never a new provisioning attempt.
   */
  | 'succeeded';

/** Secret-free work snapshot returned by one fenced database claim. */
export interface TaskAdmissionClaim {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly sourceState: TaskAdmissionClaimSourceState;
  readonly attempt: number;
  readonly stage: TaskProvisioningStage;
  /** Safe terminal cause persisted while two-phase sandbox cleanup is pending. */
  readonly causeCode?: ProvisioningTaskFailureCode | null;
  readonly resolvedBranch: string | null;
  readonly resourceSnapshot: SandboxResourceSnapshot;
  /** Nullable only for rolling/legacy rows created before the immutable policy. */
  readonly workspaceMaterializationDeadlineMs: number | null;
  readonly taskStatus: TaskStatus;
  readonly taskLifecycleVersion: number;
  /**
   * Present only when this claim resumed a parked row: the previous parked
   * ownership generation (the parking worker's lease token). Guardrails uses
   * it as the conditional compare value when re-stamping `ownerGeneration`
   * to this claim's new lease token, so exactly one waker can succeed.
   */
  readonly parkedLeaseToken?: string | null;
}

export interface TaskAdmissionClaimRequest {
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
}

export interface TaskAdmissionLeaseRequest {
  readonly taskId: string;
  readonly leaseToken: string;
}

/** One exact Task row state accepted by the durable admission authority. */
export interface TaskAdmissionTaskFence {
  readonly status: TaskStatus;
  readonly lifecycleVersion: number;
}

export interface TaskAdmissionAuthorityRequest
  extends TaskAdmissionLeaseRequest {
  /**
   * Usually one exact state. During the single admission lifecycle CAS the
   * current state plus its declared queued/running successor are accepted so a
   * concurrent renewal cannot mistake our own committed version increment for
   * supersession. No terminal successor is ever declared.
   */
  readonly taskFences: readonly TaskAdmissionTaskFence[];
}

export interface TaskAdmissionRenewRequest
  extends TaskAdmissionAuthorityRequest {
  readonly leaseDurationMs: number;
}

export interface TaskAdmissionCheckpointRequest
  extends TaskAdmissionAuthorityRequest {
  readonly stage: TaskProvisioningStage;
  /**
   * Optional transfer progress persisted with the checkpoint
   * (chunk-archive-injection-with-progress D2). Numeric-only like the parked
   * heartbeat path; omitted/null leaves the stored snapshot intact.
   */
  readonly progress?: TaskAdmissionTransferProgress | null;
}

export type TaskAdmissionSettlement =
  | {
      readonly state: 'succeeded';
      readonly stage: 'complete';
    }
  | {
      readonly state: 'queued';
      readonly stage: TaskProvisioningStage;
      readonly availableAfterMs: number;
    }
  | {
      readonly state: 'retrying';
      readonly stage: TaskProvisioningStage;
      /** Safe closed cause retained so the next claimed retry is observable. */
      readonly causeCode: ProvisioningTaskFailureCode;
      readonly availableAfterMs: number;
    }
  | {
      readonly state: 'failed';
      readonly stage: TaskProvisioningStage;
      readonly causeCode: ProvisioningTaskFailureCode;
    }
  | {
      readonly state: 'cancelled';
      readonly stage: TaskProvisioningStage;
    };

/**
 * The `parked` swimlane of the settlement union. Parked is the only
 * settlement that retains the lease pair (the settling worker's token becomes
 * the parked ownership generation), so it carries its own request shape and
 * travels through `TaskAdmissionStore.park` rather than the lease-releasing
 * `settle` states above. Parking never burns or resets the attempt counter.
 */
export interface TaskAdmissionParkedSettlement {
  readonly state: 'parked';
  readonly stage: TaskProvisioningStage;
  /**
   * Parked lease horizon; the parked poll loop extends it while the job is
   * provably alive, and its expiry is the recovery path through the existing
   * expired-lease claim branch.
   */
  readonly leaseDurationMs: number;
}

export interface TaskAdmissionParkRequest
  extends TaskAdmissionAuthorityRequest {
  readonly settlement: TaskAdmissionParkedSettlement;
}

export interface TaskAdmissionSettleRequest
  extends TaskAdmissionAuthorityRequest {
  readonly settlement: TaskAdmissionSettlement;
}

/**
 * Numeric-only workspace-transfer progress snapshot. `null` fields model an
 * indeterminate/unknown phase explicitly (AIP-151): unknown is never 0%.
 * Free-form text is deliberately impossible so raw git/provider diagnostics
 * can never become durable state.
 */
export interface TaskAdmissionTransferProgress {
  readonly percent: number | null;
  readonly receivedObjects: number | null;
  readonly totalObjects: number | null;
  readonly receivedBytes: number | null;
  readonly throughputBytesPerSecond: number | null;
}

/**
 * Marker observation of a parked detached job. The exit marker is the only
 * settlement proof: `exited` and `unknown` both hand the row back to the
 * admission claim path, which triages and settles; the parked loop itself
 * never settles provider work.
 */
export type TaskAdmissionParkedJobObservation =
  | {
      readonly kind: 'alive';
      readonly progress?: TaskAdmissionTransferProgress | null;
    }
  | { readonly kind: 'exited' }
  | { readonly kind: 'unknown' };

/**
 * Marker-probe seam a processor hands over when it parks a claim. Both
 * operations are cheap, short-lived marker interactions — never long-held
 * execs. `kill` targets the pid marker and must be idempotent: killing an
 * already-exited job is a safe no-op.
 */
export interface TaskAdmissionParkedJobPort {
  probe(): Promise<TaskAdmissionParkedJobObservation>;
  kill(): Promise<void>;
}

export interface TaskAdmissionParkedHeartbeatRequest {
  readonly taskId: string;
  /** The parked ownership generation (the token that settled `parked`). */
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  /** Latest snapshot to persist; omitted/null leaves the stored one intact. */
  readonly progress?: TaskAdmissionTransferProgress | null;
}

export interface TaskAdmissionParkedReleaseRequest {
  readonly taskId: string;
  /** The parked ownership generation (the token that settled `parked`). */
  readonly leaseToken: string;
}

/** Database authority for the admission worker. Every mutator is lease-fenced. */
export abstract class TaskAdmissionStore {
  abstract claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null>;

  /** Atomic Task status/version plus admission lease/DB-clock authority check. */
  abstract authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean>;

  /** False means the row was absent, expired, settled, or owned by another token. */
  abstract renew(request: TaskAdmissionRenewRequest): Promise<boolean>;

  /** False is a lost lease; callers must stop crossing external boundaries. */
  abstract checkpoint(
    request: TaskAdmissionCheckpointRequest,
  ): Promise<boolean>;

  /** False is a lost lease. A thrown write failure leaves the lease for recovery. */
  abstract settle(request: TaskAdmissionSettleRequest): Promise<boolean>;

  /**
   * Settle a running claim as `parked` while retaining the lease pair as the
   * parked ownership generation. False is a lost lease, exactly like
   * `settle`; a thrown write failure leaves the lease for recovery.
   *
   * Non-abstract for additive rollout: stores that support parking override
   * it. The fail-closed default can never strand a claim as silently parked.
   */
  park(_request: TaskAdmissionParkRequest): Promise<boolean> {
    return Promise.reject(
      new Error('Task admission store does not support parked work'),
    );
  }

  /**
   * Extend a live parked lease and persist the latest progress snapshot.
   * False means the parked row was resumed, superseded, or expired — the
   * caller must stop observing; it never resurrects an expired parked lease.
   *
   * Non-abstract for additive rollout: stores that support parking override
   * it. The fail-closed default keeps a non-parking store from ever
   * pretending a parked lease is alive.
   */
  parkedHeartbeat(
    _request: TaskAdmissionParkedHeartbeatRequest,
  ): Promise<boolean> {
    return Promise.reject(
      new Error('Task admission store does not support parked work'),
    );
  }

  /**
   * Hand a parked row back to the admission claim path by expiring its lease
   * in place. The row is then claimable through the existing expired-lease
   * branch only — this method performs no admission and no settlement.
   *
   * Non-abstract for additive rollout; see `parkedHeartbeat`.
   */
  releaseParked(
    _request: TaskAdmissionParkedReleaseRequest,
  ): Promise<boolean> {
    return Promise.reject(
      new Error('Task admission store does not support parked work'),
    );
  }
}

export type TaskAdmissionProcessResult =
  | { readonly kind: 'succeeded' }
  | {
      readonly kind: 'queued';
      readonly stage: TaskProvisioningStage;
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'cancelled';
      readonly stage?: TaskProvisioningStage;
    }
  | {
      /**
       * The workspace transfer continues as a detached job in the sandbox.
       * The worker settles the claim as `parked` (releasing its slot) and
       * registers `job` with the lightweight parked poll loop.
       */
      readonly kind: 'parked';
      readonly stage: TaskProvisioningStage;
      readonly job: TaskAdmissionParkedJobPort;
    };

/**
 * Lease controls exposed to a future 5.3 processor. They contain no provider
 * implementation and reserve no process-local/cross-replica capacity.
 */
export interface TaskAdmissionLeaseControls {
  /** Current exact Task fence used by every provider/runtime boundary. */
  currentTaskFence(): TaskAdmissionTaskFence;
  /**
   * Declare the only nonterminal successor(s) an admission CAS may commit.
   * Returns the lifecycle version every declared target must use.
   */
  beginTaskTransition(
    nextStatuses: readonly Extract<TaskStatus, 'queued' | 'running'>[],
  ): number;
  /** Commit one of the declared successors after its database CAS succeeds. */
  commitTaskTransition(fence: TaskAdmissionTaskFence): void;
  /** Remove declared successors after a non-committing/failed CAS. */
  rollbackTaskTransition(): void;
  /** Atomically assert lease ownership, DB-clock validity and current Task fence. */
  authorize(): Promise<void>;
  renew(): Promise<void>;
  checkpoint(stage: TaskProvisioningStage): Promise<void>;
  /**
   * Best-effort transfer-progress write for the CURRENT stage. Unlike
   * `checkpoint`, a failed or fenced write never aborts the lease: progress is
   * an output stream, durable admission state stays authoritative.
   */
  transferProgress(
    stage: TaskProvisioningStage,
    progress: TaskAdmissionTransferProgress,
  ): Promise<void>;
}

export interface TaskAdmissionProcessorContext {
  readonly claim: TaskAdmissionClaim;
  readonly lease: TaskAdmissionLeaseControls;
  /** Aborted before shutdown or whenever DB lease authority becomes uncertain. */
  readonly signal: AbortSignal;
}

export interface TaskAdmissionProcessor {
  process(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionProcessResult>;

  /**
   * Optional atomic Task+work failure finalizer. The production binding uses it
   * so retry exhaustion cannot leave canonical Task and admission work split.
   */
  settleTerminalFailure?(
    context: TaskAdmissionProcessorContext,
    failure: TaskAdmissionTerminalFailure,
  ): Promise<boolean>;

  /** Recover cleanup after Task terminalization committed before work settled. */
  recoverTerminal?(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery>;
}

export type TaskAdmissionTerminalRecovery =
  | {
      readonly state: 'succeeded';
      readonly stage: 'complete';
    }
  | {
      readonly state: 'failed';
      readonly stage: TaskProvisioningStage;
      readonly causeCode: ProvisioningTaskFailureCode;
    }
  | {
      readonly state: 'cancelled';
      readonly stage: TaskProvisioningStage;
    };

export interface TaskAdmissionTerminalFailure {
  readonly causeCode: ProvisioningTaskFailureCode;
  readonly stage: TaskProvisioningStage;
}

export const TASK_ADMISSION_PROCESSOR_TOKEN = Symbol(
  'TASK_ADMISSION_PROCESSOR',
);

/** Same-process fast cancellation; DB fence renewal remains cross-replica floor. */
export interface TaskAdmissionCancellationPort {
  abortTask(taskId: string): void;
  /**
   * Parked-aware stop seam for the tasks layer: kill the parked detached job
   * via its pid marker (idempotent) and hand the row back to the claim path
   * so the fence/cleanup chain settles it. Returns false when this process
   * observes no parked claim for the task (another replica, or recovery will
   * ride the expired-lease branch); stop must then rely on durable state.
   */
  killParkedTask(taskId: string): Promise<boolean>;
}

export const TASK_ADMISSION_CANCELLATION_TOKEN = Symbol(
  'TASK_ADMISSION_CANCELLATION',
);

/**
 * Only this typed error opts into retry. Unknown exceptions are classified as
 * terminal `provisioning_unknown`; raw provider diagnostics are never copied.
 */
export class TaskAdmissionProcessingError extends Error {
  constructor(
    readonly causeCode: ProvisioningTaskFailureCode,
    readonly stage: TaskProvisioningStage,
    readonly retryable: boolean,
  ) {
    super(`Task admission failed with safe cause ${causeCode}`);
    this.name = 'TaskAdmissionProcessingError';
  }
}

export class TaskAdmissionLeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`Task admission lease lost for ${taskId}`);
    this.name = 'TaskAdmissionLeaseLostError';
  }
}

/** Indeterminate coordination failure: never settle or claim success locally. */
export class TaskAdmissionCoordinationError extends Error {
  constructor(
    readonly operation: 'renew' | 'checkpoint',
    readonly taskId: string,
    readonly cause?: unknown,
  ) {
    super(`Task admission ${operation} is indeterminate for ${taskId}`);
    this.name = 'TaskAdmissionCoordinationError';
  }
}

/** No processor binding is a recoverable coordination outage, not task failure. */
export class TaskAdmissionProcessorUnavailableError extends Error {
  constructor() {
    super('Task admission processor is unavailable');
    this.name = 'TaskAdmissionProcessorUnavailableError';
  }
}

export type TaskAdmissionRunOutcome =
  | { readonly kind: 'idle' }
  | {
      readonly kind:
        | 'succeeded'
        | 'queued'
        | 'retrying'
        | 'parked'
        | 'failed'
        | 'cancelled'
        | 'lease-lost';
      readonly taskId: string;
      readonly attempt: number;
    };
