import type {
  SandboxCommandExecutionResult,
  SandboxWorkspaceCommandExecutionRequest,
} from './command-executor.js';
import type { SandboxSecretFilePort } from './git-credential.js';
import type {
  SandboxWorkspaceMaterializationPlan,
  SandboxWorkspaceMaterializationResult,
  SandboxWorkspaceProgressReporter,
  SandboxWorkspaceBoundaryGuard,
} from './provisioning.js';
import type { ExactHostGitCredential } from './git-credential.js';
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

export interface SandboxWorkspaceMaterializationHookContext {
  readonly taskId: string;
  readonly plan: SandboxWorkspaceMaterializationPlan;
  readonly workspaceDir: string;
  readonly stageExecutor: SandboxGitStageExecutor;
  readonly secretFilePort?: SandboxSecretFilePort;
  readonly cancellationSignal?: AbortSignal;
  /** Task attempts persist through their emitter; probes use non-persisting. */
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
  readonly onProgress?: SandboxWorkspaceProgressReporter;
  readonly beforeBoundary?: SandboxWorkspaceBoundaryGuard;
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
