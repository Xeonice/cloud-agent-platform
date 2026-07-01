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
  buildSandboxCommandLine,
  normalizeSandboxCommandResult,
} from '@cap/sandbox-core';
import Docker from 'dockerode';
import {
  AioSandboxContainerController,
  type AioDockerClient,
  type AioFetch,
  type AioProviderControllerLogger,
} from './aio-provider-controller.js';
import {
  AIO_LOCAL_SANDBOX_PROVIDER_ID,
  AIO_SANDBOX_WORKSPACE_DIR,
  buildAioSandboxConnection,
  buildAioSandboxContainerName,
  defineAioLocalSandboxProvider,
} from './aio-local-provider.js';

type MaybePromise<T> = T | Promise<T>;

const AIO_WORKSPACE_DELIVERY_TIMEOUT_MS = 120_000;

export interface AioProvisionLookupHook<TCloneSpec, TRuntimeId> {
  getCloneSpec?(taskId: string): MaybePromise<TCloneSpec | null>;
  getRuntimeId?(taskId: string): MaybePromise<TRuntimeId | null | undefined>;
  getTaskPrompt?(taskId: string): MaybePromise<string | null | undefined>;
}

export interface AioProviderExecutionContext<TRuntimeId = string> {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly connection: SandboxConnection;
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly providerSandboxId: string;
  readonly containerName: string;
  readonly controller: AioSandboxContainerController;
}

export interface AioPromptAuthInjectionContext<TRuntimeId = string>
  extends AioProviderExecutionContext<TRuntimeId> {
  readonly prompt: string | null;
}

export interface AioPreStopTrimContext<TRuntimeId = string> {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly baseUrl: string;
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly controller: AioSandboxContainerController;
}

export interface AioTranscriptReadContext<TRuntimeId = string> {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly workspaceDir: string;
  readonly controller: AioSandboxContainerController;
}

export type AioRuntimePreflightHook<TRuntimeId = string> = (
  context: AioProviderExecutionContext<TRuntimeId>,
) => MaybePromise<SandboxPreflightResult | null | undefined>;

export type AioRuntimeSetupHook<TRuntimeId = string> = (
  context: AioPromptAuthInjectionContext<TRuntimeId>,
) => MaybePromise<void>;

export type AioPromptAuthInjectionHook<TRuntimeId = string> = (
  context: AioPromptAuthInjectionContext<TRuntimeId>,
) => MaybePromise<void>;

export type AioSkillPreinstallHook<TRuntimeId = string> = (
  context: AioProviderExecutionContext<TRuntimeId>,
) => MaybePromise<void>;

export type AioPreStopTrimHook<TRuntimeId = string> = (
  context: AioPreStopTrimContext<TRuntimeId>,
) => MaybePromise<void>;

export type AioTranscriptReadHook<
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> = (
  context: AioTranscriptReadContext<TRuntimeId>,
) => MaybePromise<TTranscriptSource | null>;

export interface AioSandboxProviderHooks<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> {
  readonly provisionLookup?: AioProvisionLookupHook<TCloneSpec, TRuntimeId>;
  readonly cloneSpecToGitCloneSpec?: (
    cloneSpec: TCloneSpec,
  ) => MaybePromise<GitCloneSpec | null>;
  readonly runtimePreflight?: AioRuntimePreflightHook<TRuntimeId>;
  readonly promptAuthInjection?: AioPromptAuthInjectionHook<TRuntimeId>;
  readonly runtimeSetup?: AioRuntimeSetupHook<TRuntimeId>;
  readonly skillPreinstall?: AioSkillPreinstallHook<TRuntimeId>;
  readonly transcriptRead?: AioTranscriptReadHook<TRuntimeId, TTranscriptSource>;
  readonly preStopTrim?: AioPreStopTrimHook<TRuntimeId>;
}

export interface AioSandboxProviderOptions<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> {
  readonly id?: string;
  readonly controller: AioSandboxContainerController;
  readonly hooks?: AioSandboxProviderHooks<TCloneSpec, TRuntimeId, TTranscriptSource>;
  readonly fetch?: AioFetch;
  readonly workspaceDir?: string;
  readonly capabilities?: readonly SandboxProviderCapability[];
  readonly sandboxMode?: SandboxExecutionMode;
  readonly now?: () => Date;
}

export interface AioProviderDescriptorOptions<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> extends AioSandboxProviderOptions<TCloneSpec, TRuntimeId, TTranscriptSource> {
  readonly priority?: number;
}

export interface AioDockerProviderDescriptorOptions<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> extends Omit<
    AioProviderDescriptorOptions<TCloneSpec, TRuntimeId, TTranscriptSource>,
    'controller'
  > {
  readonly docker?: AioDockerClient<Docker.Container>;
  readonly logger?: AioProviderControllerLogger;
}

export interface AioHttpCommandExecutorOptions {
  readonly baseUrl: string;
  readonly fetch?: AioFetch;
}

interface AioProvisionedRun<TRuntimeId> {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly runtimeId?: TRuntimeId | null;
  readonly preflight?: SandboxPreflightResult;
}

export class AioSandboxProvider<
    TCloneSpec = GitCloneSpec,
    TRuntimeId = string,
    TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
  >
  implements
    SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource>,
    SandboxSelectedRunPort,
    SandboxReadoptionPort
{
  private readonly id: string;
  private readonly controller: AioSandboxContainerController;
  private readonly hooks: AioSandboxProviderHooks<TCloneSpec, TRuntimeId, TTranscriptSource>;
  private readonly fetch?: AioFetch;
  private readonly workspaceDir: string;
  private readonly capabilities: readonly SandboxProviderCapability[];
  private readonly sandboxMode: SandboxExecutionMode;
  private readonly now: () => Date;
  private readonly runs = new Map<string, AioProvisionedRun<TRuntimeId>>();

  constructor(
    options: AioSandboxProviderOptions<TCloneSpec, TRuntimeId, TTranscriptSource>,
  ) {
    this.id = options.id ?? AIO_LOCAL_SANDBOX_PROVIDER_ID;
    this.controller = options.controller;
    this.hooks = options.hooks ?? {};
    this.fetch = options.fetch;
    this.workspaceDir = options.workspaceDir ?? AIO_SANDBOX_WORKSPACE_DIR;
    this.capabilities =
      options.capabilities ?? [
        'terminal.websocket',
        'workspace.git.materialize',
        'workspace.git.deliver',
        'transcript.retained-read',
        'lifecycle.readopt',
      ];
    this.sandboxMode = options.sandboxMode ?? 'danger-full-access';
    this.now = options.now ?? (() => new Date());
  }

  getSandboxMode(): SandboxExecutionMode {
    return this.sandboxMode;
  }

  getProviderId(): string {
    return this.id;
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    return this.capabilities;
  }

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    const existing = this.controller.getConnection(ctx.taskId);
    if (existing) return existing;

    let connection: SandboxConnection | null = null;
    let runtimeId: TRuntimeId | null | undefined;

    try {
      const provisioned = await this.controller.createAndStart(ctx.taskId);
      const { spec } = provisioned;
      connection = provisioned.connection;
      runtimeId = await this.resolveRuntimeId(ctx.taskId);
      const executor = this.createCommandExecutor(connection.baseUrl);
      const executionContext: AioProviderExecutionContext<TRuntimeId> = {
        taskId: ctx.taskId,
        runtimeId,
        connection,
        executor,
        workspaceDir: this.workspaceDir,
        providerSandboxId: connection.taskId,
        containerName: spec.containerName,
        controller: this.controller,
      };
      await this.controller.waitForReadiness({
        baseUrl: connection.baseUrl,
        taskId: ctx.taskId,
        timeoutMs: spec.readinessTimeoutMs,
      });
      const preflight = await this.runRuntimePreflight(executionContext);
      if (preflight.status === 'failed') {
        throw new Error(preflight.error ?? `AIO runtime preflight failed for task ${ctx.taskId}`);
      }
      const prompt = await this.hooks.provisionLookup?.getTaskPrompt?.(ctx.taskId);
      const promptContext: AioPromptAuthInjectionContext<TRuntimeId> = {
        ...executionContext,
        prompt: prompt ?? null,
      };
      await this.hooks.promptAuthInjection?.(promptContext);
      await this.hooks.runtimeSetup?.(promptContext);
      await this.materializeWorkspace(ctx, executor);
      await this.hooks.skillPreinstall?.(executionContext);
      this.runs.set(ctx.taskId, {
        taskId: ctx.taskId,
        connection,
        runtimeId,
        preflight,
      });
    } catch (err) {
      this.runs.delete(ctx.taskId);
      await this.cleanupFailedProvision(ctx.taskId, runtimeId).catch(() => undefined);
      throw err;
    }

    if (!connection) {
      throw new Error(`AIO provision failed before creating a connection for task ${ctx.taskId}`);
    }
    return this.controller.registerConnection(connection);
  }

  private async cleanupFailedProvision(
    taskId: string,
    runtimeId: TRuntimeId | null | undefined,
  ): Promise<void> {
    await this.controller.teardownSandbox(taskId, {
      beforeStop: async ({ baseUrl }) => {
        if (runtimeId === undefined) return;
        const executor = this.createCommandExecutor(baseUrl);
        try {
          await this.hooks.preStopTrim?.({
            taskId,
            runtimeId,
            baseUrl,
            executor,
            workspaceDir: this.workspaceDir,
            controller: this.controller,
          });
        } catch {
          // Failed provisioning should still stop the container even if cleanup degrades.
        }
      },
    });
    this.runs.delete(taskId);
  }

  async teardownSandbox(taskId: string): Promise<void> {
    const run = this.runs.get(taskId);
    await this.controller.teardownSandbox(taskId, {
      beforeStop: async ({ baseUrl }) => {
        const executor = this.createCommandExecutor(baseUrl);
        await this.hooks.preStopTrim?.({
          taskId,
          runtimeId: run?.runtimeId ?? (await this.resolveRuntimeId(taskId)),
          baseUrl,
          executor,
          workspaceDir: this.workspaceDir,
          controller: this.controller,
        });
      },
    });
    this.runs.delete(taskId);
  }

  async removeSandbox(taskId: string): Promise<void> {
    await this.controller.removeSandbox(taskId);
    this.runs.delete(taskId);
  }

  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    return (
      (await this.hooks.transcriptRead?.({
        taskId,
        runtimeId: runtimeId ?? this.runs.get(taskId)?.runtimeId ?? null,
        workspaceDir: this.workspaceDir,
        controller: this.controller,
      })) ?? null
    );
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    return this.controller.sandboxExists(taskId);
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
    const baseUrl = this.controller.resolveBaseUrl(taskId);
    return deliverGitWorkspaceChanges({
      executor: this.createCommandExecutor(baseUrl),
      workspaceDir: this.workspaceDir,
      args,
    });
  }

  async listReadoptable(): Promise<string[]> {
    return this.controller.listReadoptable();
  }

  async reattach(taskId: string): Promise<SandboxConnection | null> {
    const connection = this.controller.reattach(taskId);
    if (!connection) return null;
    const runtimeId = await this.resolveRuntimeId(taskId);
    this.runs.set(taskId, {
      taskId,
      connection,
      runtimeId,
      preflight: this.skippedPreflight(runtimeId),
    });
    return connection;
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun | null> {
    const connection = this.connectionForTask(taskId);
    return {
      taskId,
      providerId: this.id,
      providerSandboxId: connection.taskId,
      provider: this,
      capabilities: this.getProviderCapabilities(),
      connection,
      terminal: this.getTerminalDescriptor(taskId),
      command: this.getCommandDescriptor(taskId),
      workspace: this.getWorkspaceDescriptor(taskId),
      retention: this.getRetentionPolicy(taskId),
      preflight: this.runs.get(taskId)?.preflight,
    };
  }

  getTerminalDescriptor(taskId: string): SandboxTerminalEndpointDescriptor {
    const connection = this.connectionForTask(taskId);
    return {
      protocol: 'aio-json-v1',
      wsUrl: connection.wsUrl,
      metadata: {
        provider: this.id,
        containerName: buildAioSandboxContainerName(taskId),
      },
    };
  }

  getCommandDescriptor(taskId: string): SandboxCommandEndpointDescriptor {
    const connection = this.connectionForTask(taskId);
    return {
      protocol: 'aio-http-exec-v1',
      baseUrl: connection.baseUrl,
      workingDirectory: this.workspaceDir,
      metadata: {
        provider: this.id,
        containerName: buildAioSandboxContainerName(taskId),
      },
    };
  }

  getWorkspaceDescriptor(_taskId: string): SandboxWorkspaceDescriptor {
    return {
      mode: 'git',
      path: this.workspaceDir,
      git: {
        materialized: this.capabilities.includes('workspace.git.materialize'),
        deliverable: this.capabilities.includes('workspace.git.deliver'),
      },
      metadata: { provider: this.id },
    };
  }

  getRetentionPolicy(_taskId: string): SandboxRetentionPolicy {
    return {
      mode: 'stop-retain',
      retainTranscript: this.capabilities.includes('transcript.retained-read'),
      cleanupEligible: true,
      metadata: { provider: this.id },
    };
  }

  createCommandExecutor(baseUrl: string): SandboxCommandExecutor {
    return createAioHttpCommandExecutor({
      baseUrl,
      fetch: this.fetch,
    });
  }

  releaseHandles(): void {
    this.controller.releaseHandles();
    this.runs.clear();
  }

  private async resolveRuntimeId(taskId: string): Promise<TRuntimeId | null> {
    return (await this.hooks.provisionLookup?.getRuntimeId?.(taskId)) ?? null;
  }

  private async resolveCloneSpec(
    ctx: SandboxProvisionContext<TCloneSpec>,
  ): Promise<TCloneSpec | null> {
    return ctx.cloneSpec === undefined
      ? (await this.hooks.provisionLookup?.getCloneSpec?.(ctx.taskId)) ?? null
      : ctx.cloneSpec;
  }

  private async materializeWorkspace(
    ctx: SandboxProvisionContext<TCloneSpec>,
    executor: SandboxCommandExecutor,
  ): Promise<void> {
    const cloneSpec = await this.resolveCloneSpec(ctx);
    if (!cloneSpec) return;
    const gitCloneSpec =
      (await this.hooks.cloneSpecToGitCloneSpec?.(cloneSpec)) ??
      requireGitCloneSpec(cloneSpec);
    await materializeGitWorkspace({
      executor,
      workspaceDir: this.workspaceDir,
      cloneSpec: gitCloneSpec,
    });
  }

  private async runRuntimePreflight(
    context: AioProviderExecutionContext<TRuntimeId>,
  ): Promise<SandboxPreflightResult> {
    return (
      (await this.hooks.runtimePreflight?.(context)) ??
      this.skippedPreflight(context.runtimeId ?? null)
    );
  }

  private skippedPreflight(runtimeId: TRuntimeId | null): SandboxPreflightResult {
    return {
      status: 'skipped',
      checkedAt: this.now().toISOString(),
      runtimeId: runtimeId === null ? undefined : String(runtimeId),
    };
  }

  private connectionForTask(taskId: string): SandboxConnection {
    return this.controller.getConnection(taskId) ?? buildAioSandboxConnection(taskId);
  }
}

export function defineAioSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: AioProviderDescriptorOptions<TCloneSpec, TRuntimeId, TTranscriptSource>,
): SandboxProviderDescriptor<AioSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>> {
  const provider = new AioSandboxProvider(options);
  return defineAioLocalSandboxProvider({
    id: provider.getProviderId(),
    provider,
    priority: options.priority,
    capabilities: provider.getProviderCapabilities(),
  });
}

export function defineAioSandboxProviderFromDocker<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: AioDockerProviderDescriptorOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
): SandboxProviderDescriptor<
  AioSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
> {
  const { docker, logger, ...providerOptions } = options;
  const controller = new AioSandboxContainerController<Docker.Container>({
    docker: (docker ?? new Docker()) as unknown as AioDockerClient<Docker.Container>,
    logger,
  });
  return defineAioSandboxProvider({
    ...providerOptions,
    controller,
  });
}

export function createAioHttpCommandExecutor(
  options: AioHttpCommandExecutorOptions,
): SandboxCommandExecutor {
  const fetchImpl =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init) as ReturnType<AioFetch>);
  return {
    async exec(request: SandboxCommandExecutionRequest) {
      const res = await fetchImpl(`${options.baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: buildSandboxCommandLine(request) }),
        signal:
          request.timeoutMs === undefined
            ? undefined
            : AbortSignal.timeout(request.timeoutMs),
      });
      if (!res.ok) {
        return {
          exitCode: Number.NaN,
          output: `/v1/shell/exec responded ${res.status}`,
          stdout: '',
          stderr: `/v1/shell/exec responded ${res.status}`,
          timedOut: false,
        };
      }
      return normalizeSandboxCommandResult(await res.json().catch(() => undefined));
    },
  };
}

async function materializeGitWorkspace(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly cloneSpec: GitCloneSpec;
}): Promise<void> {
  const parent = dirname(args.workspaceDir);
  const clone = await args.executor.exec({
    command: [
      `rm -rf ${shellQuote(args.workspaceDir)}`,
      `mkdir -p ${shellQuote(parent)}`,
      `git ${gitAuthOption(args.cloneSpec.authHeader)} clone --recursive -- ${shellQuote(
        args.cloneSpec.url,
      )} ${shellQuote(args.workspaceDir)}`,
    ].join(' && '),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`AIO git materialization failed: ${scrubOutput(clone.output)}`);
  }
}

async function deliverGitWorkspaceChanges(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly args: SandboxDeliverWorkspaceArgs;
}): Promise<SandboxDeliverWorkspaceResult> {
  const exec = (request: Pick<SandboxCommandExecutionRequest, 'command' | 'cwd'>) =>
    args.executor.exec({
      ...request,
      timeoutMs: AIO_WORKSPACE_DELIVERY_TIMEOUT_MS,
    });

  const status = await exec({
    command: 'git status --porcelain',
    cwd: args.workspaceDir,
  });
  if (status.exitCode !== 0) {
    return failure(`git status failed: ${status.output}`);
  }
  if (!status.output.trim()) {
    return { hadChanges: false, commitSha: null, error: null };
  }

  const add = await exec({
    command: 'git add -A',
    cwd: args.workspaceDir,
  });
  if (add.exitCode !== 0) {
    return failure(`git add failed: ${add.output}`, { hadChanges: true });
  }

  const msgPath = '/tmp/cap-commit-msg';
  const commitMessageB64 = Buffer.from(args.args.commitMessage, 'utf8').toString(
    'base64',
  );
  const writeMessage = await exec({
    command: `printf %s ${shellQuote(commitMessageB64)} | base64 -d > ${shellQuote(msgPath)}`,
  });
  if (writeMessage.exitCode !== 0) {
    return failure(`git commit message write failed: ${writeMessage.output}`, {
      hadChanges: true,
    });
  }

  const commit = await exec({
    command:
      `git -c ${shellQuote('user.name=cap-bot')} ` +
      `-c ${shellQuote('user.email=cap-bot@users.noreply.github.com')} ` +
      `commit -F ${shellQuote(msgPath)}`,
    cwd: args.workspaceDir,
  });
  if (commit.exitCode !== 0) {
    return failure(`git commit failed: ${commit.output}`, { hadChanges: true });
  }

  const sha = await exec({
    command: 'git rev-parse HEAD',
    cwd: args.workspaceDir,
  });
  if (sha.exitCode !== 0) {
    return failure(`git rev-parse failed: ${sha.output}`, { hadChanges: true });
  }

  const commitSha = sha.output.trim() || null;
  const push = await exec({
    command:
      `git -c ${shellQuote(`http.extraHeader=${args.args.authHeader}`)} ` +
      `push --force-with-lease origin ${shellQuote(`HEAD:${args.args.branch}`)}`,
    cwd: args.workspaceDir,
  });
  if (push.exitCode !== 0) {
    return failure(`git push failed: ${push.output}`, {
      hadChanges: true,
      commitSha,
    });
  }

  return {
    hadChanges: true,
    commitSha,
    error: null,
  };
}

function requireGitCloneSpec(raw: unknown): GitCloneSpec {
  if (!raw || typeof raw !== 'object' || typeof (raw as { url?: unknown }).url !== 'string') {
    throw new Error('AIO git materialization requires a clone spec with a url');
  }
  const record = raw as { readonly url: string; readonly authHeader?: unknown };
  return {
    url: record.url,
    authHeader: typeof record.authHeader === 'string' ? record.authHeader : undefined,
  };
}

function failure(
  error: string,
  options: { readonly hadChanges?: boolean; readonly commitSha?: string | null } = {},
): SandboxDeliverWorkspaceResult {
  return {
    hadChanges: options.hadChanges ?? false,
    commitSha: options.commitSha ?? null,
    error: scrubOutput(error),
  };
}

function scrubOutput(output: string): string {
  return output
    .replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***:***@')
    .replace(/(Authorization:\s*Basic\s+)\S+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitAuthOption(authHeader: string | undefined): string {
  return authHeader ? `-c http.extraHeader=${shellQuote(authHeader)}` : '';
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}
