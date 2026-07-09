import type {
  GitCloneSpec,
  SandboxCommandEndpointDescriptor,
  SandboxCommandExecutor,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxPreflightResult,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisionContext,
  SandboxReadoptionPort,
  SandboxRetentionPolicy,
  SandboxResolvedEnvironmentMetadata,
  SandboxSelectedRunPort,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  SandboxWorkspaceDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  defineCloudSandboxProvider,
  defineLocalSandboxProvider,
} from '@cap/sandbox-core';
import type {
  BoxLiteClient,
  BoxLiteSandbox,
} from './boxlite-client.js';
import { BoxLiteRestClient } from './boxlite-client.js';
import type { BoxLiteProviderConfig } from './boxlite-config.js';
import {
  readBoxLiteProviderConfig,
  resolveBoxLiteSandboxSource,
  type BoxLiteProviderEnv,
} from './boxlite-config.js';
import type {
  BoxLitePreStopCleanup,
  BoxLiteRuntimePreflight,
  BoxLiteRuntimeSetup,
} from './boxlite-hooks.js';
import { createBoxLiteCommandExecutor } from './boxlite-command.js';
import {
  createBoxLiteRuntimePreflight,
  requiredToolsForBoxLiteCapabilities,
} from './boxlite-preflight.js';
import {
  deliverGitWorkspaceChanges,
  materializeGitWorkspace,
  requireGitCloneSpec,
} from './boxlite-workspace.js';
import { buildBoxLiteTerminalDescriptor } from './boxlite-terminal.js';
import { buildBoxLiteRetentionPolicy } from './boxlite-retention.js';
import type { BoxLiteProvisionedRun } from './boxlite-types.js';

export interface BoxLiteProviderOptions {
  readonly config: BoxLiteProviderConfig;
  readonly client?: BoxLiteClient;
  readonly preflight?: BoxLiteRuntimePreflight;
  readonly runtimeSetup?: BoxLiteRuntimeSetup;
  readonly preStopCleanup?: BoxLitePreStopCleanup;
  readonly resolveEnvironment?: (args: {
    readonly taskId: string;
    readonly runtimeId?: string | null;
  }) => Promise<SandboxResolvedEnvironmentMetadata | null | undefined>;
}

export interface BoxLiteProviderDescriptorOptions extends BoxLiteProviderOptions {
  readonly id?: string;
}

export interface BoxLiteProviderDescriptorFromEnvOptions {
  readonly env?: BoxLiteProviderEnv;
  readonly client?: BoxLiteClient;
  readonly preflight?: BoxLiteRuntimePreflight;
}

export type BoxLiteProviderDescriptorFromEnvResult =
  | {
      readonly status: 'disabled';
      readonly reason: string;
    }
  | {
      readonly status: 'invalid';
      readonly errors: readonly string[];
    }
  | {
      readonly status: 'registered';
      readonly descriptor: SandboxProviderDescriptor<BoxLiteSandboxProvider>;
    };

export class BoxLiteSandboxProvider<
    TCloneSpec = GitCloneSpec,
    TRuntimeId = string,
    TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
  >
  implements
    SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource>,
    SandboxSelectedRunPort,
    SandboxReadoptionPort
{
  private readonly config: BoxLiteProviderConfig;
  private readonly client: BoxLiteClient;
  private readonly preflight?: BoxLiteRuntimePreflight;
  private readonly runtimeSetup?: BoxLiteRuntimeSetup;
  private readonly preStopCleanup?: BoxLitePreStopCleanup;
  private readonly resolveEnvironmentHook?: BoxLiteProviderOptions['resolveEnvironment'];
  private readonly runs = new Map<string, BoxLiteProvisionedRun>();

  constructor(options: BoxLiteProviderOptions) {
    this.config = options.config;
    this.client =
      options.client ??
      new BoxLiteRestClient({
        baseUrl: options.config.endpoint,
        apiToken: options.config.apiToken,
        timeoutMs: options.config.timeoutMs,
        protocolMode: options.config.protocolMode,
        pathPrefix: options.config.pathPrefix,
      });
    this.preflight = options.preflight;
    this.runtimeSetup = options.runtimeSetup;
    this.preStopCleanup = options.preStopCleanup;
    this.resolveEnvironmentHook = options.resolveEnvironment;
    assertClientSupportsCapabilities(this.client, options.config.capabilities);
  }

  getSandboxMode(): SandboxExecutionMode {
    return this.config.sandboxMode;
  }

  getProviderId(): string {
    return this.config.providerId;
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    return this.config.capabilities;
  }

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    const existing = await this.resolveExistingRun(ctx.taskId);
    if (existing) return existing.connection;

    const sandboxId = this.sandboxIdForTask(ctx.taskId);
    const environment = await this.resolveEnvironment(ctx);
    const source = this.resolveSandboxSource(environment);
    const sandbox = await this.client.createSandbox({
      taskId: ctx.taskId,
      sandboxId,
      ...(source.kind === 'image'
        ? { image: source.value }
        : { rootfsPath: source.value }),
      location: this.config.location,
      env: nonEmptySandboxEnv(this.config.sandboxEnv),
      labels: {
        'cap.taskId': ctx.taskId,
        'cap.provider': this.config.providerId,
      },
      metadata: {
        provider: this.config.providerId,
        workspacePath: this.config.workspacePath,
        sandboxSourceKind: source.kind,
        sandboxEnvironmentId: environment?.environmentId ?? environment?.id,
        sandboxEnvironmentName: environment?.name,
        sandboxEnvironmentSourceKind: environment?.sourceKind,
        sandboxEnvironmentContractVersion: environment?.contractVersion,
      },
    });
    const connection = this.connectionForSandbox(ctx.taskId, sandbox);
    const executor = this.createCommandExecutor(sandbox.id);
    try {
      if (ctx.cloneSpec) {
        await materializeGitWorkspace({
          executor,
          workspacePath: this.config.workspacePath,
          cloneSpec: requireGitCloneSpec(ctx.cloneSpec),
        });
      }
      const preflight = await this.runPreflight(ctx.taskId, sandbox, null, environment);
      if (preflight.status === 'failed') {
        throw new Error(preflight.error ?? `BoxLite runtime preflight failed for task ${ctx.taskId}`);
      }
      await this.runtimeSetup?.({
        taskId: ctx.taskId,
        sandbox,
        executor,
        workspacePath: this.config.workspacePath,
      });
      const run: BoxLiteProvisionedRun = {
        taskId: ctx.taskId,
        sandbox,
        connection,
        preflight,
        environment,
      };
      this.runs.set(ctx.taskId, run);
      return connection;
    } catch (err) {
      await this.client.deleteSandbox(sandbox.id).catch(() => undefined);
      throw err;
    }
  }

  async preflightRuntime(args: {
    readonly taskId: string;
    readonly runtimeId?: string | null;
  }): Promise<SandboxPreflightResult> {
    const run = await this.requireRun(args.taskId);
    const preflight = await this.runPreflight(
      args.taskId,
      run.sandbox,
      args.runtimeId ?? null,
    );
    this.runs.set(args.taskId, { ...run, preflight });
    return preflight;
  }

  async teardownSandbox(taskId: string): Promise<void> {
    const run =
      this.runs.get(taskId) ??
      (await this.resolveExistingRun(taskId).catch(() => null));
    const sandboxId = run?.sandbox.id ?? this.sandboxIdForTask(taskId);
    if (run && this.preStopCleanup) {
      try {
        await this.preStopCleanup({
          taskId,
          sandbox: run.sandbox,
          executor: this.createCommandExecutor(run.sandbox.id),
          workspacePath: this.config.workspacePath,
        });
      } catch {
        // Cleanup is best-effort; deletion must still proceed.
      }
    }
    await this.client.deleteSandbox(sandboxId);
    this.runs.delete(taskId);
  }

  async readRolloutFromContainer(
    _taskId: string,
    _runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    return null;
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    const sandbox = await this.client.getSandbox(
      this.runs.get(taskId)?.sandbox.id ?? this.sandboxIdForTask(taskId),
    );
    return isUsableSandbox(sandbox);
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
    if (!this.hasCapability('workspace.git.deliver')) {
      return {
        hadChanges: false,
        commitSha: null,
        error: `BoxLite provider for task ${taskId} does not support git delivery`,
      };
    }
    const run = await this.requireRun(taskId);
    return deliverGitWorkspaceChanges({
      executor: this.createCommandExecutor(run.sandbox.id),
      workspacePath: this.config.workspacePath,
      args,
    });
  }

  async listReadoptable(): Promise<string[]> {
    return [...this.runs.keys()];
  }

  async reattach(taskId: string): Promise<SandboxConnection | null> {
    const run = await this.resolveExistingRun(taskId);
    return run?.connection ?? null;
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun | null> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return {
      taskId,
      providerId: this.config.providerId,
      providerSandboxId: run.sandbox.id,
      provider: this,
      capabilities: this.getProviderCapabilities(),
      connection: run.connection,
      terminal: (await this.getTerminalDescriptor(taskId)) ?? undefined,
      command: (await this.getCommandDescriptor(taskId)) ?? undefined,
      workspace: (await this.getWorkspaceDescriptor(taskId)) ?? undefined,
      retention: (await this.getRetentionPolicy(taskId)) ?? undefined,
      preflight: run.preflight,
      environment: run.environment ?? undefined,
    };
  }

  async getTerminalDescriptor(
    taskId: string,
  ): Promise<SandboxTerminalEndpointDescriptor | null> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return buildBoxLiteTerminalDescriptor({ config: this.config, run });
  }

  async getCommandDescriptor(
    taskId: string,
  ): Promise<SandboxCommandEndpointDescriptor | null> {
    if (!this.hasCapability('command.exec')) return null;
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return {
      protocol: 'boxlite-exec-v1',
      baseUrl: this.config.endpoint,
      workingDirectory: this.config.workspacePath,
      metadata: {
        provider: this.config.providerId,
        sandboxId: run.sandbox.id,
      },
    };
  }

  async getWorkspaceDescriptor(taskId: string): Promise<SandboxWorkspaceDescriptor | null> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return {
      mode: this.hasCapability('workspace.archive.transfer') ? 'archive' : 'none',
      path: this.config.workspacePath,
      git: {
        materialized: this.hasCapability('workspace.git.materialize'),
        deliverable: this.hasCapability('workspace.git.deliver'),
      },
      archive: this.hasCapability('workspace.archive.transfer')
        ? { upload: true, download: true }
        : undefined,
      metadata: {
        provider: this.config.providerId,
        sandboxId: run.sandbox.id,
      },
    };
  }

  async getRetentionPolicy(taskId: string): Promise<SandboxRetentionPolicy | null> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return buildBoxLiteRetentionPolicy({ config: this.config, run });
  }

  createCommandExecutor(sandboxId: string): SandboxCommandExecutor {
    return createBoxLiteCommandExecutor({
      client: this.client,
      sandboxId,
    });
  }

  async uploadWorkspaceArchive(args: {
    readonly taskId: string;
    readonly archive: Uint8Array;
    readonly path?: string;
  }): Promise<void> {
    if (!this.client.uploadArchive) {
      throw new Error('BoxLite client does not support archive upload');
    }
    const run = await this.requireRun(args.taskId);
    await this.client.uploadArchive({
      sandboxId: run.sandbox.id,
      path: args.path ?? this.config.workspacePath,
      archive: args.archive,
    });
  }

  async downloadWorkspaceArchive(args: {
    readonly taskId: string;
    readonly path?: string;
  }): Promise<Uint8Array | null> {
    if (!this.client.downloadArchive) {
      throw new Error('BoxLite client does not support archive download');
    }
    const run = await this.requireRun(args.taskId);
    return this.client.downloadArchive({
      sandboxId: run.sandbox.id,
      path: args.path ?? this.config.workspacePath,
    });
  }

  private async runPreflight(
    taskId: string,
    sandbox: BoxLiteSandbox,
    runtimeId: string | null,
    environment?: SandboxResolvedEnvironmentMetadata | null,
  ): Promise<SandboxPreflightResult> {
    if (!this.preflight) {
      return {
        status: 'skipped',
        checkedAt: new Date().toISOString(),
        image: sandbox.image ?? sandbox.rootfsPath,
        runtimeId: runtimeId ?? undefined,
        environment: environment ?? undefined,
      };
    }
    const preflight = await this.preflight({
      taskId,
      provider: this as unknown as BoxLiteSandboxProvider,
      sandbox,
      executor: this.createCommandExecutor(sandbox.id),
      runtimeId,
    });
    return environment && !preflight.environment
      ? { ...preflight, environment }
      : preflight;
  }

  private async requireRun(taskId: string): Promise<BoxLiteProvisionedRun> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) {
      throw new Error(`BoxLite sandbox for task ${taskId} is not available`);
    }
    return run;
  }

  private async resolveExistingRun(
    taskId: string,
  ): Promise<BoxLiteProvisionedRun | null> {
    const cached = this.runs.get(taskId);
    if (cached && isUsableSandbox(await this.client.getSandbox(cached.sandbox.id))) {
      return cached;
    }

    const sandbox = await this.client.getSandbox(
      cached?.sandbox.id ?? this.sandboxIdForTask(taskId),
    );
    if (!isUsableSandbox(sandbox)) {
      this.runs.delete(taskId);
      return null;
    }
    const connection = this.connectionForSandbox(taskId, sandbox);
    const run: BoxLiteProvisionedRun = {
      taskId,
      sandbox,
      connection,
      environment: cached?.environment,
      preflight:
        cached?.preflight ??
        {
          status: 'skipped',
          checkedAt: new Date().toISOString(),
          image: sandbox.image ?? sandbox.rootfsPath,
          environment: cached?.environment ?? undefined,
        },
    };
    this.runs.set(taskId, run);
    return run;
  }

  private connectionForSandbox(taskId: string, sandbox: BoxLiteSandbox): SandboxConnection {
    return {
      taskId,
      baseUrl:
        sandbox.baseUrl ??
        (this.config.protocolMode === 'native'
          ? `${this.config.endpoint}${nativeBoxPath(this.config.pathPrefix, sandbox.id)}`
          : `${this.config.endpoint}/v1/sandboxes/${encodeURIComponent(sandbox.id)}`),
      wsUrl:
        this.config.protocolMode === 'native'
          ? this.config.endpoint.replace(/^http/, 'ws')
          : sandbox.terminalUrl ??
            `${this.config.endpoint.replace(/^http/, 'ws')}/v1/sandboxes/${encodeURIComponent(sandbox.id)}/terminal`,
    };
  }

  private sandboxIdForTask(taskId: string): string {
    return `${this.config.sandboxIdPrefix}${taskId}`;
  }

  private async resolveEnvironment(
    ctx: SandboxProvisionContext<TCloneSpec>,
  ): Promise<SandboxResolvedEnvironmentMetadata | null> {
    if (ctx.environment !== undefined) return ctx.environment ?? null;
    return (await this.resolveEnvironmentHook?.({ taskId: ctx.taskId })) ?? null;
  }

  private resolveSandboxSource(
    environment: SandboxResolvedEnvironmentMetadata | null,
  ): { kind: 'image' | 'rootfs'; value: string } {
    if (!environment) return resolveBoxLiteSandboxSource({ config: this.config });
    if (environment.sourceKind === 'boxlite-image' && environment.sourceRef) {
      return { kind: 'image', value: environment.sourceRef };
    }
    throw new Error(
      `Sandbox environment ${environment.environmentId ?? environment.id ?? 'unknown'} source ${environment.sourceKind ?? 'unknown'} is not compatible with BoxLite`,
    );
  }

  private hasCapability(capability: SandboxProviderCapability): boolean {
    return this.config.capabilities.includes(capability);
  }
}

export function defineBoxLiteSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: BoxLiteProviderDescriptorOptions,
): SandboxProviderDescriptor<BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>> {
  const provider = new BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>(
    {
      ...options,
      preflight:
        options.preflight ??
        createBoxLiteRuntimePreflight({
          requiredTools: requiredToolsForBoxLiteCapabilities(options.config.capabilities),
          workspacePath: options.config.workspacePath,
        }),
    },
  );
  const id = options.id ?? options.config.providerId;
  const args = {
    id,
    provider,
    priority: options.config.priority,
    capabilities: options.config.capabilities,
  };
  return options.config.location === 'local'
    ? defineLocalSandboxProvider(args)
    : defineCloudSandboxProvider(args);
}

export function defineBoxLiteSandboxProviderFromEnv(
  options: BoxLiteProviderDescriptorFromEnvOptions = {},
): BoxLiteProviderDescriptorFromEnvResult {
  const result = readBoxLiteProviderConfig(options.env);
  if (result.status === 'disabled' || result.status === 'invalid') return result;
  return {
    status: 'registered',
    descriptor: defineBoxLiteSandboxProvider({
      config: result.config,
      client: options.client,
      preflight: options.preflight,
    }),
  };
}

function assertClientSupportsCapabilities(
  client: BoxLiteClient,
  capabilities: readonly SandboxProviderCapability[],
): void {
  if (
    capabilities.includes('workspace.archive.transfer') &&
    (!client.uploadArchive || !client.downloadArchive)
  ) {
    throw new Error(
      'BoxLite provider cannot advertise workspace.archive.transfer without archive client methods',
    );
  }
}

function isUsableSandbox(sandbox: BoxLiteSandbox | null): sandbox is BoxLiteSandbox {
  if (!sandbox) return false;
  const state = sandbox.state?.toLowerCase();
  return state !== 'deleted' && state !== 'terminated' && state !== 'removed';
}

function nonEmptySandboxEnv(
  sandboxEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  return Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined;
}

function nativeApiPath(pathPrefix: string): string {
  return pathPrefix ? `/v1/${pathPrefix}` : '/v1';
}

function nativeBoxPath(pathPrefix: string, sandboxId: string): string {
  return `${nativeApiPath(pathPrefix)}/boxes/${encodeURIComponent(sandboxId)}`;
}
