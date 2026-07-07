import type { SandboxProviderCapability, SandboxProviderLocation } from './capabilities.js';
import { SandboxProviderConfigurationError } from './errors.js';

export interface GitCloneSpec {
  readonly url: string;
  readonly authHeader?: string;
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
  readonly providerFamily?: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string;
  readonly sourceKind?: SandboxEnvironmentSourceKind;
  readonly sourceRef?: string;
  readonly digest?: string;
  readonly checksum?: string;
  readonly validationId?: string;
  readonly validationVersion?: string;
  readonly contractVersion?: string;
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
}

export type SandboxRunOwnerStatus =
  | 'provisioning'
  | 'running'
  | 'terminal'
  | 'removed'
  | 'failed';

export interface SandboxRunOwnerRecord {
  readonly taskId: string;
  readonly providerId: string;
  readonly providerSandboxId?: string;
  readonly status: SandboxRunOwnerStatus;
  readonly connection?: SandboxConnection;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface RecordSandboxRunOwnerArgs {
  readonly taskId: string;
  readonly providerId: string;
  readonly providerSandboxId?: string;
  readonly connection?: SandboxConnection;
  readonly environment?: SandboxResolvedEnvironmentMetadata;
  readonly metadata?: SandboxDescriptorMetadata;
}

export interface SandboxRunOwnerStore {
  getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null>;
  listActiveSandboxRunOwners?(): Promise<readonly SandboxRunOwnerRecord[]>;
  recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void>;
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
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
  /**
   * `undefined`: caller did not pre-resolve workspace materialization.
   * `null`: caller resolved the task and no repository should be materialized.
   * object: exact selected workspace input the provider must use.
   */
  readonly cloneSpec?: TCloneSpec | null;
}

export interface SandboxDeliverWorkspaceArgs {
  readonly authHeader: string;
  readonly branch: string;
  readonly commitMessage: string;
}

export interface SandboxDeliverWorkspaceResult {
  readonly hadChanges: boolean;
  readonly commitSha: string | null;
  readonly error: string | null;
}

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

  teardownSandbox(taskId: string): Promise<void>;

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
  listReadoptable?(): Promise<string[]>;
  reattach?(taskId: string): Promise<SandboxConnection | null | undefined>;
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
