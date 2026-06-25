import type { SandboxProviderCapability, SandboxProviderLocation } from './capabilities.js';

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

export interface SandboxProvisionContext<TCloneSpec = GitCloneSpec> {
  readonly taskId: string;
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
    throw new Error(`Sandbox provider descriptor "${args.id}" requires declared capabilities`);
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
