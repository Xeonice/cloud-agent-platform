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
  | 'running';

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
}

export type TaskAdmissionSettlement =
  | {
      readonly state: 'succeeded';
      readonly stage: 'complete';
    }
  | {
      readonly state: 'queued' | 'retrying';
      readonly stage: TaskProvisioningStage;
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

export interface TaskAdmissionSettleRequest
  extends TaskAdmissionAuthorityRequest {
  readonly settlement: TaskAdmissionSettlement;
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
        | 'failed'
        | 'cancelled'
        | 'lease-lost';
      readonly taskId: string;
      readonly attempt: number;
    };
