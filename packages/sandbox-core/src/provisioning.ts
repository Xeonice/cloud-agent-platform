import type { SandboxProviderCapability } from './capabilities.js';
import { missingCapabilities } from './capabilities.js';
import {
  SandboxProviderCapabilityError,
  SandboxProviderConfigurationError,
} from './errors.js';
import type { ExactHostGitCredential } from './git-credential.js';
import { exactHostGitCredentialMatchesRepository } from './git-credential.js';

/**
 * Provider-neutral, non-secret resources fixed at task admission time.
 *
 * The snapshot deliberately contains only resources understood by CAP. Provider
 * native create/request types belong in their adapters and must not leak into
 * orchestration.
 */
export interface SandboxResourceSnapshot {
  readonly diskSizeGb?: number;
}

/**
 * Provider-neutral provisioning policy resolved before a provider adapter is
 * invoked. The snapshot is deliberately non-secret and immutable so retries
 * cannot observe a different deployment fallback.
 */
export interface SandboxProvisioningPolicySnapshot {
  readonly resources?: SandboxResourceSnapshot;
  readonly workspaceMaterializationDeadlineMs?: number;
}

/** Kept aligned with the managed-environment wire contract. */
export const SANDBOX_DISK_SIZE_GB_MIN = 1;
export const SANDBOX_DISK_SIZE_GB_MAX = 1024;

export const SANDBOX_DISK_SIZE_CAPABILITY =
  'resource.disk-size-gb' as const satisfies SandboxProviderCapability;

/** Initial bounded workspace transfer policy; provider config may override it. */
export const DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS = 15 * 60_000;
export const SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN = 1_000;
export const SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX =
  24 * 60 * 60_000;

/**
 * Copy and freeze resolved resources so later changes to an environment record
 * or deployment fallback cannot change an already-prepared provision request.
 */
export function snapshotSandboxResources(
  resources: SandboxResourceSnapshot | null | undefined,
): SandboxResourceSnapshot | undefined {
  if (resources === null || resources === undefined) return undefined;

  const keys = Object.keys(resources);
  const unknown = keys.filter((key) => key !== 'diskSizeGb');
  if (unknown.length > 0) {
    throw new SandboxProviderConfigurationError(
      `Unsupported sandbox resource snapshot keys: ${unknown.join(', ')}`,
    );
  }

  const diskSizeGb = resources.diskSizeGb;
  if (
    diskSizeGb !== undefined &&
    (!Number.isSafeInteger(diskSizeGb) ||
      diskSizeGb < SANDBOX_DISK_SIZE_GB_MIN ||
      diskSizeGb > SANDBOX_DISK_SIZE_GB_MAX)
  ) {
    throw new SandboxProviderConfigurationError(
      `Sandbox resource diskSizeGb must be an integer from ${SANDBOX_DISK_SIZE_GB_MIN} to ${SANDBOX_DISK_SIZE_GB_MAX}`,
    );
  }

  return Object.freeze(
    diskSizeGb === undefined ? {} : { diskSizeGb },
  ) as SandboxResourceSnapshot;
}

/**
 * Resolve each explicit resource over its deployment fallback and freeze the
 * result. An empty explicit object therefore keeps fallback fields instead of
 * accidentally erasing them.
 */
export function resolveSandboxResources(args: {
  readonly explicit?: SandboxResourceSnapshot | null;
  readonly fallback?: SandboxResourceSnapshot | null;
}): SandboxResourceSnapshot | undefined {
  const explicit = snapshotSandboxResources(args.explicit);
  const fallback = snapshotSandboxResources(args.fallback);
  if (explicit === undefined && fallback === undefined) return undefined;
  return snapshotSandboxResources({
    ...(fallback?.diskSizeGb === undefined
      ? {}
      : { diskSizeGb: fallback.diskSizeGb }),
    ...(explicit?.diskSizeGb === undefined
      ? {}
      : { diskSizeGb: explicit.diskSizeGb }),
  });
}

export function snapshotSandboxProvisioningPolicy(
  policy: SandboxProvisioningPolicySnapshot,
): SandboxProvisioningPolicySnapshot {
  const resources = snapshotSandboxResources(policy.resources);
  const deadlineMs = policy.workspaceMaterializationDeadlineMs;
  if (
    deadlineMs !== undefined &&
    (!Number.isSafeInteger(deadlineMs) ||
      deadlineMs < SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN ||
      deadlineMs > SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX)
  ) {
    throw new SandboxProviderConfigurationError(
      `Sandbox workspace materialization deadline must be an integer from ${SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN} to ${SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX}`,
    );
  }
  return Object.freeze({
    ...(resources === undefined ? {} : { resources }),
    ...(deadlineMs === undefined
      ? {}
      : { workspaceMaterializationDeadlineMs: deadlineMs }),
  });
}

/** Capabilities a provider must advertise before receiving these resources. */
export function sandboxResourceRequiredCapabilities(
  resources: SandboxResourceSnapshot | null | undefined,
): readonly SandboxProviderCapability[] {
  if (resources?.diskSizeGb === undefined) return [];
  return [SANDBOX_DISK_SIZE_CAPABILITY];
}

/**
 * Direct-adapter enforcement companion to scheduler capability selection.
 * Providers call this before creating native sandbox state.
 */
export function assertSandboxProviderSupportsResources(
  declared: readonly SandboxProviderCapability[] | undefined,
  resources: SandboxResourceSnapshot | null | undefined,
): void {
  const missing = missingCapabilities(
    declared,
    sandboxResourceRequiredCapabilities(resources),
  );
  if (missing.length === 0) return;
  throw new SandboxProviderCapabilityError(
    `Sandbox provider cannot enforce resolved resources; missing capabilities: ${missing.join(', ')}`,
    missing,
  );
}

/** Stable workspace stages shared by providers and admission progress mapping. */
export const SANDBOX_WORKSPACE_MATERIALIZATION_STAGES = [
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'complete',
] as const;
export type SandboxWorkspaceMaterializationStage =
  (typeof SANDBOX_WORKSPACE_MATERIALIZATION_STAGES)[number];

/** Secret-free causes returned by provider workspace implementations. */
export const SANDBOX_WORKSPACE_FAILURE_CAUSES = [
  'capacity_exhausted',
  'timeout',
  'authentication',
  'tls_network',
  'ref_not_found',
  'unknown',
] as const;
export type SandboxWorkspaceFailureCause =
  (typeof SANDBOX_WORKSPACE_FAILURE_CAUSES)[number];

/**
 * Immutable checkout intent resolved before provider selection.
 *
 * `callerBranch` preserves the request fact (null means omitted), while
 * `resolvedBranch` is the exact ref providers must fetch and check out.
 */
export interface SandboxWorkspaceMaterializationPlan {
  readonly repositoryUrl: string;
  readonly callerBranch: string | null;
  readonly resolvedBranch: string;
  readonly deadlineMs: number;
  /** Canonical provider-only auth path; absent for public repositories. */
  readonly credential?: ExactHostGitCredential;
}

export function snapshotSandboxWorkspacePlan(
  plan: SandboxWorkspaceMaterializationPlan | null | undefined,
): SandboxWorkspaceMaterializationPlan | null | undefined {
  if (plan === null || plan === undefined) return plan;
  if (
    plan.repositoryUrl.length === 0 ||
    plan.repositoryUrl !== plan.repositoryUrl.trim()
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must be non-empty without surrounding whitespace',
    );
  }
  const repositoryUrl = normalizeSandboxRepositoryUrl(plan.repositoryUrl);
  if (
    plan.resolvedBranch.trim().length === 0 ||
    plan.resolvedBranch !== plan.resolvedBranch.trim()
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace resolvedBranch must be non-empty without surrounding whitespace',
    );
  }
  if (
    plan.callerBranch !== null &&
    (plan.callerBranch.trim().length === 0 ||
      plan.callerBranch !== plan.callerBranch.trim())
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace callerBranch must be null or non-empty without surrounding whitespace',
    );
  }
  if (!Number.isSafeInteger(plan.deadlineMs) || plan.deadlineMs <= 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace deadlineMs must be a positive safe integer',
    );
  }
  if (
    plan.credential !== undefined &&
    !exactHostGitCredentialMatchesRepository(plan.credential, repositoryUrl)
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace credential must match the normalized repository scheme and host',
    );
  }
  return Object.freeze({
    repositoryUrl,
    callerBranch: plan.callerBranch,
    resolvedBranch: plan.resolvedBranch,
    deadlineMs: plan.deadlineMs,
    ...(plan.credential === undefined
      ? {}
      : { credential: plan.credential }),
  });
}

function normalizeSandboxRepositoryUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must be a valid HTTP(S) URL',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must use HTTP or HTTPS',
    );
  }
  if (parsed.hostname.length === 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must include a host',
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must not contain userinfo',
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0 || /[?#]/.test(value)) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must not contain a query or fragment',
    );
  }
  if (parsed.pathname === '/' || parsed.pathname.length === 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox workspace repositoryUrl must include a repository path',
    );
  }
  return parsed.toString();
}

export type SandboxWorkspaceMaterializationResult =
  | {
      readonly status: 'succeeded';
      readonly stage: 'complete';
    }
  | {
      readonly status: 'failed';
      readonly stage: Exclude<SandboxWorkspaceMaterializationStage, 'complete'>;
      readonly cause: SandboxWorkspaceFailureCause;
      readonly retryable: boolean;
    }
  | {
      readonly status: 'cancelled';
      readonly stage: Exclude<SandboxWorkspaceMaterializationStage, 'complete'>;
    };

/**
 * Numeric-only clone transfer progress. `null` models an explicitly unknown /
 * indeterminate value (AIP-151): pre-"Receiving objects" phases report
 * `percent: null`, never 0%, so consumers can distinguish indeterminate from
 * zero.
 */
export interface SandboxWorkspaceTransferProgressSnapshot {
  readonly percent: number | null;
  readonly receivedObjects: number | null;
  readonly totalObjects: number | null;
  readonly receivedBytes: number | null;
  readonly throughputBytesPerSecond: number | null;
}

const SANDBOX_WORKSPACE_TRANSFER_PROGRESS_FIELDS = [
  'percent',
  'receivedObjects',
  'totalObjects',
  'receivedBytes',
  'throughputBytesPerSecond',
] as const;

/**
 * Validate and freeze a numeric-only transfer progress snapshot. Progress is
 * an output stream, never a settlement source: durable admission state stays
 * authoritative regardless of these values.
 */
export function snapshotSandboxWorkspaceTransferProgress(
  progress: SandboxWorkspaceTransferProgressSnapshot,
): SandboxWorkspaceTransferProgressSnapshot {
  const unknown = Object.keys(progress).filter(
    (key) =>
      !(SANDBOX_WORKSPACE_TRANSFER_PROGRESS_FIELDS as readonly string[]).includes(
        key,
      ),
  );
  if (unknown.length > 0) {
    throw new SandboxProviderConfigurationError(
      `Unsupported sandbox transfer progress keys: ${unknown.join(', ')}`,
    );
  }
  for (const field of SANDBOX_WORKSPACE_TRANSFER_PROGRESS_FIELDS) {
    const value = progress[field];
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new SandboxProviderConfigurationError(
        `Sandbox transfer progress ${field} must be null or a non-negative finite number`,
      );
    }
  }
  if (progress.percent !== null && progress.percent > 100) {
    throw new SandboxProviderConfigurationError(
      'Sandbox transfer progress percent must be null or within 0-100',
    );
  }
  return Object.freeze({
    percent: progress.percent,
    receivedObjects: progress.receivedObjects,
    totalObjects: progress.totalObjects,
    receivedBytes: progress.receivedBytes,
    throughputBytesPerSecond: progress.throughputBytesPerSecond,
  });
}

export type SandboxWorkspaceProgressEvent =
  | {
      readonly status: 'started' | 'succeeded';
      readonly stage: Exclude<SandboxWorkspaceMaterializationStage, 'complete'>;
    }
  | {
      /** Additive clone-progress variant; best-effort, audit/UX only. */
      readonly status: 'progress';
      readonly stage: 'workspace_transfer';
      readonly progress: SandboxWorkspaceTransferProgressSnapshot;
    }
  | SandboxWorkspaceMaterializationResult;

export type SandboxWorkspaceProgressReporter = (
  event: SandboxWorkspaceProgressEvent,
) => void | Promise<void>;

/**
 * Dispatch workspace progress without letting reporter latency or failure
 * block or fail the materialization: a dropped progress write is never an
 * error; durable work state stays authoritative.
 */
export function reportSandboxWorkspaceProgress(
  reporter: SandboxWorkspaceProgressReporter | undefined,
  event: SandboxWorkspaceProgressEvent,
): void {
  if (!reporter) return;
  try {
    void Promise.resolve(reporter(Object.freeze({ ...event }))).catch(
      () => undefined,
    );
  } catch {
    // Progress is best-effort; durable admission work remains authoritative.
  }
}

/**
 * Composite provider phases whose physical order may differ by provider.
 * These events are audit hints only: orchestration must not derive durable
 * lease authority or monotonic admission checkpoints from them.
 */
export type SandboxProvisioningProgressStage = 'runtime_setup' | 'readiness';

export interface SandboxProvisioningProgressEvent {
  readonly status: 'started';
  readonly stage: SandboxProvisioningProgressStage;
}

export type SandboxProvisioningProgressReporter = (
  event: SandboxProvisioningProgressEvent,
) => void | Promise<void>;

/**
 * Load-bearing checkpoint used only when a provider reaches a composite phase
 * in canonical durable order. Providers whose physical order differs keep
 * using the audit-only progress reporter instead of regressing durable state.
 */
export type SandboxProvisioningBoundaryGuard = (
  event: Readonly<{ stage: SandboxProvisioningProgressStage }>,
) => void | Promise<void>;

/**
 * Dispatch provider progress without allowing audit latency or recorder
 * failure to block the controlled provisioning action.
 */
export function reportSandboxProvisioningProgress(
  reporter: SandboxProvisioningProgressReporter | undefined,
  event: SandboxProvisioningProgressEvent,
): void {
  if (!reporter) return;
  try {
    void Promise.resolve(reporter(Object.freeze({ ...event }))).catch(
      () => undefined,
    );
  } catch {
    // Progress is best-effort; durable admission work remains authoritative.
  }
}

/**
 * Load-bearing orchestration authority check. Unlike progress reporting, an
 * exception from this callback MUST propagate and stop the next external
 * workspace action.
 */
export interface SandboxWorkspaceBoundaryEvent {
  readonly stage: Exclude<SandboxWorkspaceMaterializationStage, 'complete'>;
  readonly position: 'before' | 'after';
}

export type SandboxWorkspaceBoundaryGuard = (
  event: SandboxWorkspaceBoundaryEvent,
) => void | Promise<void>;
