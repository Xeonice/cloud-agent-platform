import type { SandboxProviderCapability, SandboxProviderLocation } from './capabilities.js';
import { SandboxProviderConfigurationError } from './errors.js';
import type { ExactHostGitCredential } from './git-credential.js';
import type { TaskModelIntent } from './model-material.js';
import type { SandboxExternalBoundaryGuard } from './external-boundary.js';
import type {
  SandboxResourceSnapshot,
  SandboxProvisioningBoundaryGuard,
  SandboxProvisioningProgressReporter,
  SandboxWorkspaceMaterializationPlan,
  SandboxWorkspaceProgressReporter,
  SandboxWorkspaceBoundaryGuard,
} from './provisioning.js';
import type { SandboxGitDeliveryResult } from './workspace-git.js';
import {
  snapshotSandboxResources,
  snapshotSandboxWorkspacePlan,
} from './provisioning.js';

/**
 * @deprecated Compatibility contract for providers not yet migrated to the
 * canonical staged workspace plan. Do not add new fields to this shape.
 */
export interface GitCloneSpec {
  readonly url: string;
  /**
   * @deprecated Compatibility-only for the pre-staged clone path. New
   * orchestration must use SandboxWorkspaceMaterializationPlan.credential.
   */
  readonly authHeader?: string;
  /** Prevent accidental mixing of the canonical descriptor into the legacy path. */
  readonly credential?: never;
}

export interface SandboxCapabilitySource {
  getSandboxMode(): string;
  getProviderCapabilities?(): readonly SandboxProviderCapability[];
}

export type SandboxExecutionMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export const SANDBOX_EXECUTION_MODES: readonly SandboxExecutionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

/**
 * Addressable handle returned by a provisioned sandbox.
 *
 * The control plane can use `baseUrl` for provider-specific HTTP operations and
 * `wsUrl` for interactive terminal attachment when `terminal.websocket` is
 * declared.
 */
export interface SandboxConnection {
  readonly taskId: string;
  readonly baseUrl: string;
  readonly wsUrl: string;
}

export type SandboxTerminalProtocol =
  | 'aio-json-v1'
  | 'boxlite-v1'
  | 'provider-native'
  | (string & {});

export type SandboxCommandProtocol =
  | 'aio-http-exec-v1'
  | 'boxlite-exec-v1'
  | 'provider-native'
  | (string & {});

export type SandboxWorkspaceMaterializationMode =
  | 'none'
  | 'git'
  | 'archive'
  | 'provider-native'
  | (string & {});

export type SandboxRetentionMode =
  | 'none'
  | 'stop-retain'
  | 'snapshot'
  | 'provider-native'
  | (string & {});

export interface SandboxDescriptorMetadata {
  readonly [key: string]: unknown;
}

export interface SandboxTerminalEndpointDescriptor {
  readonly protocol: SandboxTerminalProtocol;
  readonly url?: string;
  readonly wsUrl?: string;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxCommandEndpointDescriptor {
  readonly protocol: SandboxCommandProtocol;
  readonly baseUrl?: string;
  readonly workingDirectory?: string;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxWorkspaceDescriptor {
  readonly mode: SandboxWorkspaceMaterializationMode;
  readonly path?: string;
  readonly git?: {
    readonly materialized?: boolean;
    readonly deliverable?: boolean;
  };
  readonly archive?: {
    readonly upload?: boolean;
    readonly download?: boolean;
  };
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxRetentionPolicy {
  readonly mode: SandboxRetentionMode;
  readonly retainTranscript?: boolean;
  readonly cleanupEligible?: boolean;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxPreflightProbeResult {
  readonly name: string;
  readonly command?: string;
  readonly ok: boolean;
  readonly output?: string;
}

export type SandboxEnvironmentProviderFamily =
  | 'aio'
  | 'boxlite'
  | 'cloud-http'
  | (string & {});

export type SandboxEnvironmentSourceKind =
  | 'aio-docker-image'
  | 'boxlite-image'
  | (string & {});

export interface SandboxResolvedEnvironmentMetadata {
  readonly id?: string;
  readonly environmentId?: string;
  readonly name?: string;
  /** Exact registered provider descriptor id selected during catalog preflight. */
  readonly providerId?: string;
  readonly providerFamily?: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string;
  readonly sourceKind?: SandboxEnvironmentSourceKind;
  readonly sourceRef?: string;
  readonly digest?: string;
  readonly checksum?: string;
  readonly runtimeArtifactChecksums?: Readonly<Record<string, string>>;
  /** @deprecated Use runtimeArtifactChecksums for multi-runtime evidence. */
  readonly cliArtifactChecksum?: string;
  readonly validationId?: string;
  readonly validationVersion?: string;
  readonly contractVersion?: string;
  /** Immutable, non-secret resources resolved before provider selection. */
  readonly resources?: SandboxResourceSnapshot;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxPreflightResult {
  readonly status: 'skipped' | 'passed' | 'failed';
  readonly checkedAt?: string;
  readonly image?: string;
  readonly runtimeId?: string;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly probes?: readonly SandboxPreflightProbeResult[];
  readonly error?: string;
  readonly metadata?: SandboxDescriptorMetadata;
}

export type SandboxRunOwnerStatus =
  | 'provisioning'
  | 'running'
  | 'deleting'
  | 'terminal'
  | 'removed'
  | 'failed';

/**
 * Durable create linearization state. `entered` means a provider create request
 * may still produce a late physical resource; `idle` proves no create is in
 * flight for the current resource attempt.
 */
export type SandboxRunCreateState = 'idle' | 'entered';

/**
 * Double fence for one control-plane owner and one physical sandbox
 * incarnation. The owner generation may transfer on lease recovery while the
 * resource generation remains stable when the same sandbox is readopted.
 */
export interface SandboxOwnershipFence {
  readonly ownerGeneration: string;
  readonly resourceGeneration: string;
}

/**
 * Persisted provider identity used to readopt one exact physical sandbox after
 * a control-plane restart. Providers that use generation-scoped physical ids
 * must prefer providerSandboxId over a task-derived legacy id.
 */
export interface SandboxReadoptionTarget {
  readonly providerSandboxId?: string;
  readonly ownership?: SandboxOwnershipFence;
}

/**
 * Durable authorization for one cleanup attempt.  Generation-fenced sandboxes
 * carry the current control-plane owner and immutable physical incarnation;
 * pre-generation rows use the explicit legacy variant and are serialized by
 * the persisted deleting state before an unfenced provider cleanup is issued.
 */
export type SandboxRunCleanupAuthorization =
  | {
      readonly kind: 'generation';
      readonly taskId: string;
      readonly providerId: string;
      readonly ownership: SandboxOwnershipFence;
    }
  | {
      readonly kind: 'legacy';
      readonly taskId: string;
      readonly providerId: string;
    };

/** Provider proof used to distinguish a completed delete from an unsafe 404. */
export type SandboxTeardownResult =
  | { readonly kind: 'found-and-cleaned' }
  | { readonly kind: 'already-absent' };

/** Business disposition is independent from the cleanup authorization token. */
export type SandboxTeardownDisposition =
  | 'terminal-retain'
  | 'superseded-remove';

export interface SandboxRunOwnerRecord {
  readonly taskId: string;
  readonly providerId: string;
  readonly providerSandboxId?: string;
  readonly ownership?: SandboxOwnershipFence;
  readonly createState?: SandboxRunCreateState;
  readonly status: SandboxRunOwnerStatus;
  readonly connection?: SandboxConnection;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface RecordSandboxRunOwnerArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly providerSandboxId?: string;
  readonly ownership?: SandboxOwnershipFence;
  readonly status?: Extract<SandboxRunOwnerStatus, 'provisioning' | 'running'>;
  readonly connection?: SandboxConnection;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface AcquireSandboxRunOwnerArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly ownerGeneration: string;
  readonly proposedResourceGeneration: string;
}

export interface BeginSandboxRunCreateArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly ownership: SandboxOwnershipFence;
}

export interface ObserveSandboxRunCreateArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly resourceGeneration: string;
  readonly providerSandboxId?: string;
}

export type SandboxCreateObservation =
  | {
      readonly kind: 'created';
      readonly providerSandboxId?: string;
    }
  | { readonly kind: 'not-created' };

export type AcquireSandboxRunOwnerResult =
  | {
      readonly kind: 'acquired';
      readonly ownership: SandboxOwnershipFence;
      readonly previousOwner?: SandboxRunOwnerRecord;
    }
  | {
      readonly kind: 'cleanup-required' | 'conflict';
      readonly owner: SandboxRunOwnerRecord;
    };

export type BeginSandboxRunCleanupResult =
  | {
      readonly kind: 'authorized';
      readonly owner: SandboxRunOwnerRecord;
      readonly authorization: SandboxRunCleanupAuthorization;
    }
  | { readonly kind: 'absent' | 'stale' };

export type ClaimSandboxRunCleanupResult =
  | {
      readonly kind: 'authorized';
      readonly owner: SandboxRunOwnerRecord;
      readonly authorization: SandboxRunCleanupAuthorization;
    }
  | { readonly kind: 'absent' | 'conflict' };

export interface JoinSandboxRunCleanupArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly ownership: SandboxOwnershipFence;
}

export type JoinSandboxRunCleanupResult =
  | {
      readonly kind: 'authorized';
      readonly owner: SandboxRunOwnerRecord;
      readonly authorization: Extract<
        SandboxRunCleanupAuthorization,
        { readonly kind: 'generation' }
      >;
    }
  | { readonly kind: 'absent' | 'stale' | 'conflict' };

export interface SandboxRunOwnerStore {
  getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null>;
  listActiveSandboxRunOwners?(): Promise<readonly SandboxRunOwnerRecord[]>;
  recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void>;
  acquireSandboxRunOwner?(
    args: AcquireSandboxRunOwnerArgs,
  ): Promise<AcquireSandboxRunOwnerResult>;
  /**
   * Linearize immediately before the provider's physical create boundary.
   * Returns false when the task/provider/owner/resource is no longer current.
   */
  beginSandboxRunCreate?(args: BeginSandboxRunCreateArgs): Promise<boolean>;
  /**
   * Persist that the provider received a definitive create response. This is
   * resource-scoped because cleanup authority may transfer while the request is
   * in flight.
   */
  observeSandboxRunCreate?(args: ObserveSandboxRunCreateArgs): Promise<boolean>;
  /**
   * Transfers cleanup authority to a durable admission lease while preserving
   * the physical resource generation.  Unlike provisioning acquisition this
   * may take over a deleting row so an expired cleanup can be resumed.
   */
  claimSandboxRunCleanup?(
    taskId: string,
    ownerGeneration: string,
  ): Promise<ClaimSandboxRunCleanupResult>;
  /**
   * Join cleanup for the same physical generation after a stale create returns.
   * A superseded owner may join only once the durable row is already deleting.
   */
  joinSandboxRunCleanup?(
    args: JoinSandboxRunCleanupArgs,
  ): Promise<JoinSandboxRunCleanupResult>;
  beginSandboxRunCleanup?(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<BeginSandboxRunCleanupResult>;
  /**
   * Settle after the provider proved the exact physical generation cleaned.
   * Owner generation is an action-before fence; completion is atomically
   * resource-scoped so an authority transfer during delete cannot strand the
   * deleting tombstone. A deleting row blocks every newer resource generation.
   */
  completeSandboxRunCleanup?(
    authorization: SandboxRunCleanupAuthorization,
    status: Extract<SandboxRunOwnerStatus, 'removed' | 'terminal' | 'failed'>,
  ): Promise<boolean>;
  markSandboxRunOwnerStatus?(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void>;
}

export interface SelectedSandboxRun<TProvider extends SandboxCapabilitySource = SandboxCapabilitySource> {
  readonly taskId: string;
  readonly providerId: string;
  readonly provider: TProvider;
  readonly providerSandboxId?: string;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly connection: SandboxConnection;
  readonly terminal?: SandboxTerminalEndpointDescriptor;
  readonly command?: SandboxCommandEndpointDescriptor;
  readonly workspace?: SandboxWorkspaceDescriptor;
  readonly retention?: SandboxRetentionPolicy;
  readonly preflight?: SandboxPreflightResult;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly owner?: SandboxRunOwnerRecord;
}

export interface SandboxProvisionContext<TCloneSpec = GitCloneSpec> {
  readonly taskId: string;
  /** Required persisted intent. Lookup failure must never be represented as default. */
  readonly modelIntent: TaskModelIntent;
  readonly runtimeId: string;
  readonly executionMode: 'interactive-pty' | 'headless-exec';
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
  /**
   * Immutable resources selected for this provision attempt. New callers set
   * this explicitly; environment.resources remains the compatibility source.
   */
  readonly resources?: SandboxResourceSnapshot;
  /**
   * Canonical deterministic workspace intent. It coexists with cloneSpec while
   * existing providers migrate to the staged materialization contract.
   */
  readonly workspace?: SandboxWorkspaceMaterializationPlan | null;
  /** Cancels provider work at external boundaries, including long transfers. */
  readonly cancellationSignal?: AbortSignal;
  /** Provider-neutral progress callback for durable admission projection. */
  readonly onWorkspaceProgress?: SandboxWorkspaceProgressReporter;
  /** Best-effort audit progress for provider-composite setup/readiness phases. */
  readonly onProvisioningProgress?: SandboxProvisioningProgressReporter;
  /** Load-bearing canonical checkpoint, separate from best-effort progress. */
  readonly beforeProvisioningBoundary?: SandboxProvisioningBoundaryGuard;
  /** Load-bearing task/lease fence checked around workspace external actions. */
  readonly beforeWorkspaceBoundary?: SandboxWorkspaceBoundaryGuard;
  /**
   * Load-bearing authority guard around provider external actions. This is
   * deliberately separate from progress/checkpoint reporting.
   */
  readonly externalBoundaryGuard?: SandboxExternalBoundaryGuard;
  /** Called inside the provider create closure immediately after its response. */
  readonly onSandboxCreateObserved?: (
    observation: SandboxCreateObservation,
  ) => Promise<void>;
  /** Exact control-plane and physical-resource fence for durable admission. */
  readonly ownership?: SandboxOwnershipFence;
  /** Provider-internal failure cleanup must obtain this current DB token first. */
  readonly beforeSandboxCleanup?: () => Promise<SandboxRunCleanupAuthorization | null>;
  /** Called only after provider cleanup of the token's exact resource was confirmed. */
  readonly afterSandboxCleanup?: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
  /**
   * `undefined`: caller did not pre-resolve workspace materialization.
   * `null`: caller resolved the task and no repository should be materialized.
   * object: exact selected workspace input the provider must use.
   */
  readonly cloneSpec?: TCloneSpec | null;
}

/** Resolve the explicit provision snapshot before the environment fallback. */
export function resourcesForSandboxProvision(
  context: Pick<SandboxProvisionContext<unknown>, 'resources' | 'environment'>,
): SandboxResourceSnapshot | undefined {
  return context.resources ?? context.environment?.resources;
}

/** New workspace plans and legacy clone specs both require materialization. */
export function hasSandboxWorkspaceMaterialization(
  context: Pick<SandboxProvisionContext<unknown>, 'workspace' | 'cloneSpec'>,
): boolean {
  if (context.workspace !== undefined) return context.workspace !== null;
  return context.cloneSpec !== undefined && context.cloneSpec !== null;
}

/**
 * Normalize mutable caller input at the provider boundary while preserving all
 * legacy optional fields and clone-spec semantics.
 */
export function snapshotSandboxProvisionContext<TCloneSpec>(
  context: SandboxProvisionContext<TCloneSpec>,
): SandboxProvisionContext<TCloneSpec> {
  const resources = snapshotSandboxResources(resourcesForSandboxProvision(context));
  const workspace = snapshotSandboxWorkspacePlan(context.workspace);
  const environment =
    context.environment === null || context.environment === undefined
      ? context.environment
      : Object.freeze({
          ...context.environment,
          ...(resources === undefined ? {} : { resources }),
        });
  return Object.freeze({
    ...context,
    ...(environment === undefined ? {} : { environment }),
    ...(resources === undefined ? {} : { resources }),
    ...(workspace === undefined ? {} : { workspace }),
  });
}

interface SandboxDeliverWorkspaceBaseArgs {
  readonly branch: string;
  readonly commitMessage: string;
}

/** Canonical delivery input consumed by the provider secret-file path. */
export interface SandboxCredentialedDeliverWorkspaceArgs
  extends SandboxDeliverWorkspaceBaseArgs {
  readonly credential: ExactHostGitCredential;
  readonly authHeader?: never;
  readonly cancellationSignal?: AbortSignal;
  readonly deadlineMs?: number;
  /** Exact durable owner selected by the provider center for safety fencing. */
  readonly ownership?: SandboxOwnershipFence;
  /** Provider-internal fencing must win this exact owner CAS before deletion. */
  readonly beforeSandboxCleanup?: () => Promise<SandboxRunCleanupAuthorization | null>;
  /** Settle the durable cleanup only after physical absence is confirmed. */
  readonly afterSandboxCleanup?: (
    authorization: SandboxRunCleanupAuthorization,
  ) => Promise<void>;
}

/**
 * @deprecated Compatibility-only until staged clone/push migration completes.
 * Providers must never copy this value into new ordinary command/exec types.
 */
export interface SandboxLegacyDeliverWorkspaceArgs
  extends SandboxDeliverWorkspaceBaseArgs {
  readonly authHeader: string;
  readonly credential?: never;
  readonly cancellationSignal?: never;
  readonly deadlineMs?: never;
  readonly ownership?: never;
  readonly beforeSandboxCleanup?: never;
  readonly afterSandboxCleanup?: never;
}

export type SandboxDeliverWorkspaceArgs =
  | SandboxCredentialedDeliverWorkspaceArgs
  | SandboxLegacyDeliverWorkspaceArgs;

export function isSandboxLegacyDeliverWorkspaceArgs(
  args: SandboxDeliverWorkspaceArgs,
): args is SandboxLegacyDeliverWorkspaceArgs {
  return typeof args.authHeader === 'string';
}

export type SandboxDeliverWorkspaceResult = SandboxGitDeliveryResult;

export interface SandboxTranscriptSourceBase {
  readonly format: string;
  readonly jsonl: string;
}

export interface SandboxProviderPort<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> {
  getSandboxMode(): SandboxExecutionMode;

  getProviderCapabilities?(): readonly SandboxProviderCapability[];

  provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection>;

  teardownSandbox(
    taskId: string,
    options?: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly providerSandboxId?: string;
      readonly disposition?: SandboxTeardownDisposition;
    },
  ): Promise<void | SandboxTeardownResult>;

  /** Claim the persisted owner for an exact, retryable durable cleanup. */
  claimSandboxCleanupOwnership?(
    taskId: string,
    ownerGeneration: string,
  ): Promise<SandboxRunCleanupAuthorization | null>;

  readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null>;

  sandboxExists(taskId: string): Promise<boolean>;

  deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult>;
}

export interface SandboxSelectedRunPort<TProvider extends SandboxCapabilitySource = SandboxCapabilitySource> {
  getSelectedSandboxRun?(taskId: string): Promise<SelectedSandboxRun<TProvider> | null>;
}

export interface SandboxTerminalDescriptorPort {
  getTerminalDescriptor?(
    taskId: string,
  ): Promise<SandboxTerminalEndpointDescriptor | null>;
}

export interface SandboxCommandDescriptorPort {
  getCommandDescriptor?(
    taskId: string,
  ): Promise<SandboxCommandEndpointDescriptor | null>;
}

export interface SandboxWorkspaceDescriptorPort {
  getWorkspaceDescriptor?(taskId: string): Promise<SandboxWorkspaceDescriptor | null>;
}

export interface SandboxRetentionDescriptorPort {
  getRetentionPolicy?(taskId: string): Promise<SandboxRetentionPolicy | null>;
}

export interface SandboxReadoptionPort {
  getSandboxMode(): string;
  getProviderCapabilities?(): readonly SandboxProviderCapability[];
  /**
   * Read-only inventory of running sandboxes whose agent session is
   * authoritatively live and can therefore be re-adopted. Providers must not
   * stop or remove resources while answering this query.
   */
  listReadoptable?(): Promise<string[]>;
  /**
   * Explicit startup reconciliation after the control plane has correlated
   * provider inventory with durable task/admission state. Only running
   * provider resources outside `protectedTaskIds` are eligible for reaping;
   * stopped retained history must remain untouched.
   */
  reconcileSandboxInventory?(
    input: SandboxInventoryReconcileInput,
  ): Promise<SandboxInventoryReconcileResult>;
  reattach?(
    taskId: string,
    target?: SandboxReadoptionTarget,
  ): Promise<SandboxConnection | null | undefined>;
}

export interface SandboxInventoryReconcileInput {
  readonly protectedTaskIds: readonly string[];
  /**
   * Revalidate durable ownership for each freshly inspected running candidate.
   * Providers must not reap a candidate unless this callback resolves true.
   * A missing callback or a callback failure is an authorization failure.
   */
  readonly canReap: (
    candidate: SandboxInventoryReconcileCandidate,
  ) => boolean | Promise<boolean>;
}

export interface SandboxInventoryReconcileCandidate {
  readonly taskId: string;
  /** Immutable provider resource identity observed by the fresh inspection. */
  readonly providerSandboxId: string;
}

export interface SandboxInventoryReconcileResult {
  /** Number of running provider resources examined. */
  readonly inspected: number;
  /** Number of still-running unprotected provider resources removed. */
  readonly reaped: number;
}

export interface SandboxProviderDescriptor<TProvider extends SandboxCapabilitySource> {
  readonly id: string;
  readonly provider: TProvider;
  readonly location: SandboxProviderLocation;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly priority?: number;
}

export type SandboxProviderDescriptorInput<TProvider extends SandboxCapabilitySource> = Omit<
  SandboxProviderDescriptor<TProvider>,
  'capabilities'
> & {
  readonly capabilities?: readonly SandboxProviderCapability[];
};

export function describeSandboxProvider<TProvider extends SandboxCapabilitySource>(
  args: SandboxProviderDescriptorInput<TProvider>,
): SandboxProviderDescriptor<TProvider> {
  const capabilities = args.capabilities ?? args.provider.getProviderCapabilities?.();
  if (!capabilities) {
    throw new SandboxProviderConfigurationError(
      `Sandbox provider descriptor "${args.id}" requires declared capabilities`,
    );
  }
  return {
    id: args.id,
    provider: args.provider,
    location: args.location,
    capabilities,
    priority: args.priority,
  };
}

export function defineLocalSandboxProvider<TProvider extends SandboxCapabilitySource>(
  args: Omit<SandboxProviderDescriptorInput<TProvider>, 'location'>,
): SandboxProviderDescriptor<TProvider> {
  return describeSandboxProvider({
    ...args,
    location: 'local',
  });
}

export function defineCloudSandboxProvider<TProvider extends SandboxCapabilitySource>(
  args: Omit<SandboxProviderDescriptorInput<TProvider>, 'location'>,
): SandboxProviderDescriptor<TProvider> {
  return describeSandboxProvider({
    ...args,
    location: 'cloud',
  });
}
