import type {
  SandboxCommandExecutionResult,
  SandboxWorkspaceCommandExecutionRequest,
} from './command-executor.js';
import type { SandboxDetachedJobLivenessPolicySnapshot } from './detached-jobs.js';
import type { SandboxSecretFilePort } from './git-credential.js';
import type {
  SandboxWorkspaceMaterializationPlan,
  SandboxWorkspaceMaterializationResult,
  SandboxWorkspaceProgressReporter,
  SandboxWorkspaceBoundaryGuard,
  SandboxWorkspaceTransferProgressSnapshot,
} from './provisioning.js';
import type { ExactHostGitCredential } from './git-credential.js';
import type { WorkspaceSource } from './workspace-source.js';
import type { SandboxProvisioningDiagnosticObserver } from './provisioning-diagnostics.js';

export const SANDBOX_GIT_COMMAND_STAGES = [
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'delivery_status',
  'delivery_commit',
  'delivery_push',
] as const;

export type SandboxGitCommandStage =
  (typeof SANDBOX_GIT_COMMAND_STAGES)[number];

/**
 * One secret-free guest command. Resolution is a process-settlement boundary:
 * after abort/timeout it MUST wait until the guest process is stopped (or the
 * whole sandbox is destroyed and confirmed absent).
 */
export interface SandboxGitStageExecution {
  readonly stage: SandboxGitCommandStage;
  readonly request: SandboxWorkspaceCommandExecutionRequest;
  readonly signal: AbortSignal;
  readonly remainingTimeoutMs: number;
}

export interface SandboxGitStageExecutor {
  execute(
    execution: SandboxGitStageExecution,
  ): Promise<SandboxCommandExecutionResult>;
}

/**
 * Detached workspace-transfer options. When present on the materialization
 * hook context, the `workspace_transfer` stage runs as a detached supervised
 * job (setsid launch + short polling execs through the same stage executor)
 * governed by dual-gate liveness instead of the single wall-clock deadline.
 * All other stages keep the existing deadline machinery.
 */
export interface SandboxDetachedTransferOptions {
  /** Dual-gate liveness knobs; defaults applied when omitted. */
  readonly liveness?: SandboxDetachedJobLivenessPolicySnapshot | null;
  /** Cadence of the short marker-probe polling execs. */
  readonly pollIntervalMs?: number;
  /** Test-only marker root override; defaults to the shared jobs root. */
  readonly markerRoot?: string;
}

/**
 * Marker evidence gathered for one detached workspace-transfer job through the
 * sandbox exec seam. Carries no output or command text. `progressObserved` is
 * deliberately part of the shape AND deliberately ignored by any triage: the
 * progress stream is never a settlement source.
 */
export interface SandboxDetachedWorkspaceTransferProbe {
  /** The pid marker names a process that is provably still alive. */
  readonly pidAlive: boolean;
  /** Recorded exit marker, the ONLY settlement proof a job can produce. */
  readonly exitMarker: { readonly exitCode: number } | null;
  /** Whether the progress marker showed any output. Never settlement input. */
  readonly progressObserved?: boolean;
}

/**
 * Three-way decision returned by the caller-owned resume triage:
 * exit marker -> settle the stage from its recorded code; pid alive -> the job
 * is still running (stay parked / keep observing); neither provable -> fail
 * the attempt. Success is never inferred from progress contents or silence.
 */
export type SandboxDetachedWorkspaceTransferTriage =
  | 'keep_parked'
  | 'settle_from_exit'
  | 'fail_attempt';

/** One cheap marker observation of a detached workspace-transfer job. */
export type SandboxDetachedWorkspaceTransferObservation =
  | {
      readonly kind: 'alive';
      readonly progress?: SandboxWorkspaceTransferProgressSnapshot | null;
    }
  | { readonly kind: 'exited' }
  | { readonly kind: 'unknown' };

/**
 * Probe/kill seam handed back by a detaching workspace transfer. Both
 * operations are short marker execs through the same sandbox exec channel the
 * materialization used — never long-held connections. `kill` targets the pid
 * marker and is idempotent. `probe` throws on transport failure (transient,
 * caller keeps observing) and returns `unknown` only when the exec succeeded
 * but neither pid liveness nor an exit marker was provable.
 */
export interface SandboxDetachedWorkspaceTransferJob {
  readonly taskId: string;
  readonly jobId: string;
  probe(): Promise<SandboxDetachedWorkspaceTransferObservation>;
  kill(): Promise<void>;
}

/**
 * Cooperative parking seam for the detached workspace transfer
 * (detach-workspace-clone D3). Threaded from the provision context through
 * both providers into the staged materialization hook context, so BoxLite and
 * AIO inherit identical semantics from the one shared implementation.
 *
 * - `park: true` — once the detached job is launched (or found still running
 *   on resume), the materialization raises
 *   {@link SandboxWorkspaceTransferDetachedSignal} carrying the job seam
 *   instead of entering the inline poll loop; the caller settles its claim as
 *   parked and observes the job through the seam.
 * - `resume` — present when the caller resumed previously parked work: the
 *   materialization gathers marker evidence and delegates the three-way
 *   decision to this caller-owned triage BEFORE any relaunch, so a finished
 *   clone settles from its exit marker and is never re-run from scratch, and
 *   an unprovable job fails the attempt.
 *
 * Callers that pass no detachment keep the existing blocking behavior: the
 * transfer still runs as a detached job under dual-gate liveness, awaited
 * inline (guardrails D11 keeps the legacy chain on exactly this mode).
 */
export interface SandboxWorkspaceTransferDetachment {
  readonly park?: boolean;
  readonly resume?: {
    triage(
      probe: SandboxDetachedWorkspaceTransferProbe,
    ): SandboxDetachedWorkspaceTransferTriage;
  };
}

/**
 * Typed control-flow signal, not a failure: the workspace transfer continues
 * as a detached job in the sandbox while provisioning unwinds without
 * settling the stage. Providers and the provider router MUST let this signal
 * pass through their provision failure funnels without sandbox cleanup,
 * quarantine, or fencing — the sandbox and its detached job survive parking.
 */
export class SandboxWorkspaceTransferDetachedSignal extends Error {
  constructor(readonly job: SandboxDetachedWorkspaceTransferJob) {
    super(
      `Sandbox workspace transfer for task ${job.taskId} detached without awaiting`,
    );
    this.name = 'SandboxWorkspaceTransferDetachedSignal';
  }
}

export function isSandboxWorkspaceTransferDetachedSignal(
  error: unknown,
): error is SandboxWorkspaceTransferDetachedSignal {
  return (
    error instanceof SandboxWorkspaceTransferDetachedSignal ||
    (error instanceof Error &&
      error.name === 'SandboxWorkspaceTransferDetachedSignal' &&
      typeof (error as SandboxWorkspaceTransferDetachedSignal).job?.probe ===
        'function' &&
      typeof (error as SandboxWorkspaceTransferDetachedSignal).job?.kill ===
        'function')
  );
}

/**
 * One streamed archive delivery into a running sandbox (add-repo-content-store
 * D4, archive variant). The provider owns the transport (BoxLite
 * `uploadArchive` today); the shared materialization engine owns what is sent
 * and where. `archive` is an async byte stream on purpose: a bare mirror is
 * never buffered wholesale in the API process.
 */
export interface SandboxWorkspaceArchiveUploadRequest {
  /** Absolute directory inside the sandbox the tar is unpacked into. */
  readonly path: string;
  readonly archive: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
  /**
   * Best-effort transfer feedback: invoked with the monotonically increasing
   * total of archive bytes the transport has delivered so far. Transports
   * batching the stream (e.g. body-limit-safe parts) report after each batch.
   * Never load-bearing — a throwing callback must not fail the upload.
   */
  readonly onBytesUploaded?: (uploadedBytes: number) => void;
}

export interface SandboxWorkspaceArchiveTransferPort {
  uploadArchive(request: SandboxWorkspaceArchiveUploadRequest): Promise<void>;
}

export interface SandboxWorkspaceMaterializationHookContext {
  readonly taskId: string;
  readonly plan: SandboxWorkspaceMaterializationPlan;
  readonly workspaceDir: string;
  readonly stageExecutor: SandboxGitStageExecutor;
  readonly secretFilePort?: SandboxSecretFilePort;
  /**
   * Typed workspace origin selected by orchestration (add-repo-content-store
   * D5). Absent/`git` keeps the legacy in-sandbox network clone; `volume` and
   * `archive` inject the Repo's stored bare mirror instead.
   */
  readonly source?: WorkspaceSource | null;
  /**
   * Provider-supplied archive transport, required by the `archive` variant.
   */
  readonly archiveTransfer?: SandboxWorkspaceArchiveTransferPort;
  readonly cancellationSignal?: AbortSignal;
  /** Task attempts persist through their emitter; probes use non-persisting. */
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly onProgress?: SandboxWorkspaceProgressReporter;
  readonly beforeBoundary?: SandboxWorkspaceBoundaryGuard;
  /**
   * Opt-in detached workspace-transfer execution. Absent contexts keep the
   * legacy single blocking transfer exec under the stage deadline.
   */
  readonly detachedTransfer?: SandboxDetachedTransferOptions;
  /**
   * Cooperative parking/resume seam for the detached transfer. Only
   * meaningful when `detachedTransfer` is active; absent callers keep the
   * inline (blocking) dual-gate await.
   */
  readonly detachment?: SandboxWorkspaceTransferDetachment;
}

export type SandboxWorkspaceMaterializationHook = (
  context: SandboxWorkspaceMaterializationHookContext,
) => Promise<SandboxWorkspaceMaterializationResult>;

export interface SandboxGitDeliveryPlan {
  readonly branch: string;
  readonly commitMessage: string;
  readonly credential: ExactHostGitCredential;
  readonly deadlineMs: number;
  readonly cancellationSignal?: AbortSignal;
}

export interface SandboxGitDeliveryResult {
  readonly hadChanges: boolean;
  readonly commitSha: string | null;
  /** Stable, secret-free failure code; raw provider/git output is excluded. */
  readonly error: string | null;
}

export interface SandboxWorkspaceDeliveryHookContext {
  readonly taskId: string;
  readonly plan: SandboxGitDeliveryPlan;
  readonly workspaceDir: string;
  readonly stageExecutor: SandboxGitStageExecutor;
  readonly secretFilePort: SandboxSecretFilePort;
}

export type SandboxWorkspaceDeliveryHook = (
  context: SandboxWorkspaceDeliveryHookContext,
) => Promise<SandboxGitDeliveryResult>;
