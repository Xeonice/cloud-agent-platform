import type {
  GitCloneSpec,
  SandboxCommandEndpointDescriptor,
  SandboxCommandExecutionRequest,
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
  SandboxSelectedRunPort,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  SandboxWorkspaceDescriptor,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  createSandboxCommandExecutor,
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
  resolveBoxLiteImage,
  type BoxLiteProviderEnv,
} from './boxlite-config.js';

export interface BoxLiteProviderOptions {
  readonly config: BoxLiteProviderConfig;
  readonly client?: BoxLiteClient;
  readonly preflight?: BoxLiteRuntimePreflight;
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

export interface BoxLiteRuntimePreflightContext {
  readonly provider: BoxLiteSandboxProvider;
  readonly sandbox: BoxLiteSandbox;
  readonly executor: SandboxCommandExecutor;
  readonly runtimeId?: string | null;
}

export type BoxLiteRuntimePreflight = (
  context: BoxLiteRuntimePreflightContext,
) => Promise<SandboxPreflightResult> | SandboxPreflightResult;

export interface BoxLiteRuntimePreflightOptions {
  readonly requiredTools: readonly string[];
  readonly commandTimeoutMs?: number;
  readonly cache?: Map<string, SandboxPreflightResult>;
  readonly now?: () => Date;
}

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
  private readonly runs = new Map<string, BoxLiteProvisionedRun>();

  constructor(options: BoxLiteProviderOptions) {
    this.config = options.config;
    this.client =
      options.client ??
      new BoxLiteRestClient({
        baseUrl: options.config.endpoint,
        apiToken: options.config.apiToken,
        timeoutMs: options.config.timeoutMs,
      });
    this.preflight = options.preflight;
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
    const image = resolveBoxLiteImage({ config: this.config });
    const sandbox = await this.client.createSandbox({
      taskId: ctx.taskId,
      sandboxId,
      image,
      location: this.config.location,
      labels: {
        'cap.taskId': ctx.taskId,
        'cap.provider': this.config.providerId,
      },
      metadata: {
        provider: this.config.providerId,
        workspacePath: this.config.workspacePath,
      },
    });
    const connection = this.connectionForSandbox(ctx.taskId, sandbox);
    const preflight = await this.runPreflight(ctx.taskId, sandbox, null);
    if (preflight.status === 'failed') {
      await this.client.deleteSandbox(sandbox.id).catch(() => undefined);
      throw new Error(preflight.error ?? `BoxLite runtime preflight failed for task ${ctx.taskId}`);
    }
    const run: BoxLiteProvisionedRun = {
      taskId: ctx.taskId,
      sandbox,
      connection,
      preflight,
    };
    this.runs.set(ctx.taskId, run);
    return connection;
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
    const sandboxId = this.runs.get(taskId)?.sandbox.id ?? this.sandboxIdForTask(taskId);
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
    };
  }

  async getTerminalDescriptor(
    taskId: string,
  ): Promise<SandboxTerminalEndpointDescriptor | null> {
    if (!this.hasCapability('terminal.interactive') || this.config.terminalMode !== 'pty') {
      return null;
    }
    const run = await this.resolveExistingRun(taskId);
    if (!run?.sandbox.terminalUrl) return null;
    return {
      protocol: 'boxlite-v1',
      wsUrl: run.sandbox.terminalUrl,
      metadata: {
        provider: this.config.providerId,
        sandboxId: run.sandbox.id,
      },
    };
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
    return {
      mode: this.hasCapability('lifecycle.snapshot')
        ? 'snapshot'
        : this.hasCapability('lifecycle.sleep')
          ? 'provider-native'
          : 'none',
      retainTranscript: this.hasCapability('transcript.retained-source'),
      cleanupEligible: true,
      metadata: {
        provider: this.config.providerId,
        sandboxId: run.sandbox.id,
      },
    };
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
  ): Promise<SandboxPreflightResult> {
    if (!this.preflight) {
      return {
        status: 'skipped',
        checkedAt: new Date().toISOString(),
        image: sandbox.image,
        runtimeId: runtimeId ?? undefined,
      };
    }
    return this.preflight({
      provider: this as unknown as BoxLiteSandboxProvider,
      sandbox,
      executor: this.createCommandExecutor(sandbox.id),
      runtimeId,
    });
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
      preflight:
        cached?.preflight ??
        {
          status: 'skipped',
          checkedAt: new Date().toISOString(),
          image: sandbox.image,
        },
    };
    this.runs.set(taskId, run);
    return run;
  }

  private connectionForSandbox(taskId: string, sandbox: BoxLiteSandbox): SandboxConnection {
    return {
      taskId,
      baseUrl: sandbox.baseUrl ?? `${this.config.endpoint}/v1/sandboxes/${encodeURIComponent(sandbox.id)}`,
      wsUrl:
        sandbox.terminalUrl ??
        `${this.config.endpoint.replace(/^http/, 'ws')}/v1/sandboxes/${encodeURIComponent(sandbox.id)}/terminal`,
    };
  }

  private sandboxIdForTask(taskId: string): string {
    return `${this.config.sandboxIdPrefix}${taskId}`;
  }

  private hasCapability(capability: SandboxProviderCapability): boolean {
    return this.config.capabilities.includes(capability);
  }
}

export function createBoxLiteCommandExecutor(args: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
}): SandboxCommandExecutor {
  return createSandboxCommandExecutor((request: SandboxCommandExecutionRequest) =>
    args.client.exec({
      sandboxId: args.sandboxId,
      command: request.command,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    }),
  );
}

export function createBoxLiteRuntimePreflight(
  options: BoxLiteRuntimePreflightOptions,
): BoxLiteRuntimePreflight {
  const cache = options.cache ?? new Map<string, SandboxPreflightResult>();
  const now = options.now ?? (() => new Date());
  return async (context) => {
    const tools = [...options.requiredTools].sort();
    const cacheKey = [
      context.provider.getProviderId(),
      context.sandbox.image ?? 'unknown-image',
      context.runtimeId ?? 'default-runtime',
      tools.join(','),
    ].join('|');
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const probes = [];
    for (const tool of tools) {
      const command = `command -v ${shellQuote(tool)}`;
      const result = await context.executor.exec({
        command,
        timeoutMs: options.commandTimeoutMs,
      });
      probes.push({
        name: tool,
        command,
        ok: result.exitCode === 0,
        output: result.output,
      });
    }
    const failed = probes.filter((probe) => !probe.ok);
    const preflight: SandboxPreflightResult = {
      status: failed.length === 0 ? 'passed' : 'failed',
      checkedAt: now().toISOString(),
      image: context.sandbox.image,
      runtimeId: context.runtimeId ?? undefined,
      probes,
      error:
        failed.length === 0
          ? undefined
          : `BoxLite image missing required tools: ${failed.map((probe) => probe.name).join(', ')}`,
    };
    cache.set(cacheKey, preflight);
    return preflight;
  };
}

export function defineBoxLiteSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: BoxLiteProviderDescriptorOptions,
): SandboxProviderDescriptor<BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>> {
  const provider = new BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>(
    options,
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

async function deliverGitWorkspaceChanges(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly args: SandboxDeliverWorkspaceArgs;
}): Promise<SandboxDeliverWorkspaceResult> {
  const status = await args.executor.exec({
    command: 'git status --porcelain',
    cwd: args.workspacePath,
  });
  if (status.exitCode !== 0) {
    return failure(`git status failed: ${status.output}`);
  }
  if (!status.output.trim()) {
    return { hadChanges: false, commitSha: null, error: null };
  }

  const add = await args.executor.exec({
    command: 'git add -A',
    cwd: args.workspacePath,
  });
  if (add.exitCode !== 0) return failure(`git add failed: ${add.output}`);

  const commit = await args.executor.exec({
    command: `git commit -m ${shellQuote(args.args.commitMessage)}`,
    cwd: args.workspacePath,
  });
  if (commit.exitCode !== 0) return failure(`git commit failed: ${commit.output}`);

  const sha = await args.executor.exec({
    command: 'git rev-parse HEAD',
    cwd: args.workspacePath,
  });
  if (sha.exitCode !== 0) return failure(`git rev-parse failed: ${sha.output}`);

  const push = await args.executor.exec({
    command: `git -c http.extraHeader=${shellQuote(args.args.authHeader)} push origin HEAD:${shellQuote(args.args.branch)}`,
    cwd: args.workspacePath,
  });
  if (push.exitCode !== 0) return failure(`git push failed: ${push.output}`);

  return {
    hadChanges: true,
    commitSha: sha.output.trim() || null,
    error: null,
  };
}

function failure(error: string): SandboxDeliverWorkspaceResult {
  return { hadChanges: false, commitSha: null, error };
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface BoxLiteProvisionedRun {
  readonly taskId: string;
  readonly sandbox: BoxLiteSandbox;
  readonly connection: SandboxConnection;
  readonly preflight?: SandboxPreflightResult;
}
