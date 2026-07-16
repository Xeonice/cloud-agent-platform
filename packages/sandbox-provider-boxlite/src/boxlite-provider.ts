import { createHash } from 'node:crypto';
import type {
  GitCloneSpec,
  SandboxCommandEndpointDescriptor,
  SandboxCommandExecutor,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxExternalBoundaryAction,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorization,
  SandboxTeardownResult,
  SandboxTeardownDisposition,
  SandboxPreflightResult,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisionContext,
  SandboxReadoptionTarget,
  SandboxReadoptionPort,
  SandboxRetentionPolicy,
  SandboxResolvedEnvironmentMetadata,
  SandboxResourceSnapshot,
  SandboxSelectedRunPort,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  SandboxWorkspaceDescriptor,
  SandboxWorkspaceDeliveryHook,
  SandboxWorkspaceMaterializationHook,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  assertSandboxProviderSupportsResources,
  defineCloudSandboxProvider,
  defineLocalSandboxProvider,
  isSandboxLegacyDeliverWorkspaceArgs,
  latchSandboxExternalBoundaryGuard,
  redactSandboxProvisioningStageFailure,
  reportSandboxProvisioningProgress,
  resourcesForSandboxProvision,
  runSandboxExternalBoundary,
  SandboxProvisioningCapacityError,
  SandboxProvisioningStageError,
  SandboxProviderConfigurationError,
  SandboxWorkspaceMaterializationError,
  snapshotSandboxProvisionContext,
} from '@cap/sandbox-core';
import type {
  BoxLiteClient,
  BoxLiteSandbox,
} from './boxlite-client.js';
import {
  BoxLitePartialCreateError,
  BoxLiteRestClient,
} from './boxlite-client.js';
import type { BoxLiteProviderConfig } from './boxlite-config.js';
import {
  readBoxLiteProviderConfig,
  resolveBoxLiteResourceSnapshot,
  resolveBoxLiteSandboxSource,
  type BoxLiteProviderEnv,
} from './boxlite-config.js';
import type {
  BoxLitePreStopCleanup,
  BoxLiteRuntimePreflight,
  BoxLiteRuntimeSetup,
  BoxLiteTranscriptRead,
} from './boxlite-hooks.js';
import { createBoxLiteCommandExecutor } from './boxlite-command.js';
import {
  createBoxLiteRuntimePreflight,
  requiredToolsForBoxLiteCapabilities,
} from './boxlite-preflight.js';
import { materializeGitWorkspace, requireGitCloneSpec } from './boxlite-workspace.js';
import { buildBoxLiteTerminalDescriptor } from './boxlite-terminal.js';
import { buildBoxLiteRetentionPolicy } from './boxlite-retention.js';
import type { BoxLiteProvisionedRun } from './boxlite-types.js';
import { probeBoxLiteDiskCapacity } from './boxlite-environment-validation.js';
import {
  createBoxLiteWorkspaceSecurityAdapter,
  deleteBoxLiteSandboxAndConfirm,
  resolveBoxLiteGitSecretDirectory,
} from './boxlite-workspace-security.js';

export interface BoxLiteProviderOptions<
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> {
  readonly config: BoxLiteProviderConfig;
  /** Effective registry id; descriptor aliases must use this at every CAS seam. */
  readonly providerId?: string;
  readonly client?: BoxLiteClient;
  readonly preflight?: BoxLiteRuntimePreflight;
  readonly runtimeSetup?: BoxLiteRuntimeSetup;
  readonly transcriptRead?: BoxLiteTranscriptRead<TRuntimeId, TTranscriptSource>;
  readonly preStopCleanup?: BoxLitePreStopCleanup;
  readonly resolveRuntimeId?: (
    taskId: string,
  ) => Promise<string | null | undefined> | string | null | undefined;
  readonly resolveEnvironment?: (args: {
    readonly taskId: string;
    readonly runtimeId?: string | null;
  }) => Promise<SandboxResolvedEnvironmentMetadata | null | undefined>;
  /** Injected shared engine; provider-specific secret/stage adapter lands in 3.3. */
  readonly workspaceMaterialization?: SandboxWorkspaceMaterializationHook;
  readonly workspaceDelivery?: SandboxWorkspaceDeliveryHook;
}

export interface BoxLiteProviderDescriptorOptions<
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> extends BoxLiteProviderOptions<TRuntimeId, TTranscriptSource> {
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
  private readonly providerId: string;
  private readonly client: BoxLiteClient;
  private readonly preflight?: BoxLiteRuntimePreflight;
  private readonly runtimeSetup?: BoxLiteRuntimeSetup;
  private readonly transcriptRead?: BoxLiteTranscriptRead<TRuntimeId, TTranscriptSource>;
  private readonly preStopCleanup?: BoxLitePreStopCleanup;
  private readonly resolveRuntimeIdHook?: BoxLiteProviderOptions<TRuntimeId>['resolveRuntimeId'];
  private readonly resolveEnvironmentHook?: BoxLiteProviderOptions<TRuntimeId>['resolveEnvironment'];
  private readonly workspaceMaterialization?: SandboxWorkspaceMaterializationHook;
  private readonly workspaceDelivery?: SandboxWorkspaceDeliveryHook;
  private readonly runs = new Map<string, BoxLiteProvisionedRun>();

  constructor(options: BoxLiteProviderOptions<TRuntimeId, TTranscriptSource>) {
    this.config = options.config;
    this.providerId = options.providerId ?? options.config.providerId;
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
    this.transcriptRead = options.transcriptRead;
    this.preStopCleanup = options.preStopCleanup;
    this.resolveRuntimeIdHook = options.resolveRuntimeId;
    this.resolveEnvironmentHook = options.resolveEnvironment;
    this.workspaceMaterialization = options.workspaceMaterialization;
    this.workspaceDelivery = options.workspaceDelivery;
    assertClientSupportsCapabilities(this.client, options.config.capabilities);
    if (
      options.config.capabilities.includes('transcript.retained-read') &&
      !this.transcriptRead
    ) {
      throw new Error(
        'BoxLite provider cannot advertise transcript.retained-read without a transcriptRead hook',
      );
    }
  }

  getSandboxMode(): SandboxExecutionMode {
    return this.config.sandboxMode;
  }

  getProviderId(): string {
    return this.providerId;
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    return this.config.capabilities;
  }

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    ctx = snapshotSandboxProvisionContext({
      ...ctx,
      externalBoundaryGuard: latchSandboxExternalBoundaryGuard(
        ctx.externalBoundaryGuard,
      ),
    });
    throwIfBoxLiteProvisionCancelled(ctx.cancellationSignal);
    if (
      ctx.workspace !== undefined &&
      ctx.workspace !== null &&
      !this.workspaceMaterialization
    ) {
      throw new SandboxProviderConfigurationError(
        'BoxLite canonical workspace materialization requires the staged workspace hook',
      );
    }
    const runtimeId = ctx.runtimeId;
    const environment = await this.runProvisionBoundary(
      ctx,
      'environment.resolve',
      () => this.resolveEnvironment(ctx, runtimeId),
    );
    const resources = resolveBoxLiteResourceSnapshot({
      config: this.config,
      resources: resourcesForSandboxProvision({
        resources: ctx.resources,
        environment,
      }),
    });
    assertSandboxProviderSupportsResources(
      this.getProviderCapabilities(),
      resources,
    );
    const wasCached = this.runs.has(ctx.taskId);
    const existing = await this.resolveExistingRun(
      ctx.taskId,
      ctx.ownership,
      ctx,
    );
    if (existing && wasCached) return existing.connection;

    if (existing) {
      try {
        const preflight = await this.initializeSandboxRun({
          ctx,
          sandbox: existing.sandbox,
          runtimeId,
          environment,
          resources,
        });
        this.runs.set(ctx.taskId, {
          ...existing,
          preflight,
          environment:
            environment === null
              ? null
              : Object.freeze({
                  ...(environment ?? {}),
                  resources,
                }),
        });
        return existing.connection;
      } catch (error) {
        this.forgetRun(ctx.taskId, existing.sandbox.id);
        await this.cleanupFailedSandbox(
          ctx,
          existing.sandbox.id,
          existing.sandbox,
        );
        throw error;
      }
    }

    throwIfBoxLiteProvisionCancelled(ctx.cancellationSignal);
    const sandboxId = this.sandboxIdForTask(ctx.taskId, ctx.ownership);
    const source = this.resolveSandboxSource(environment, runtimeId);
    const resolvedEnvironment =
      environment === null
        ? null
        : Object.freeze({
            ...(environment ?? {}),
            resources,
          });
    const runMetadata = Object.freeze({
      provider: this.providerId,
      workspacePath: this.config.workspacePath,
      sandboxSourceKind: source.kind,
      sandboxEnvironmentId: environment?.environmentId ?? environment?.id,
      sandboxEnvironmentName: environment?.name,
      sandboxEnvironmentSourceKind: environment?.sourceKind,
      sandboxEnvironmentContractVersion: environment?.contractVersion,
      resources,
      ...(ctx.ownership
        ? { resourceGeneration: ctx.ownership.resourceGeneration }
        : {}),
    });
    const createRequest = {
      taskId: ctx.taskId,
      sandboxId,
      ...(source.kind === 'image'
        ? { image: source.value }
        : { rootfsPath: source.value }),
      location: this.config.location,
      diskSizeGb: resources.diskSizeGb,
      env: nonEmptySandboxEnv({
        ...this.config.sandboxEnv,
        ...(ctx.ownership
          ? {
              CAP_RESOURCE_GENERATION:
                ctx.ownership.resourceGeneration,
            }
          : {}),
      }),
      labels: {
        'cap.taskId': ctx.taskId,
        'cap.provider': this.providerId,
        ...(ctx.ownership
          ? {
              'cap.resourceGeneration':
                ctx.ownership.resourceGeneration,
            }
          : {}),
      },
      metadata: runMetadata,
      externalBoundaryGuard: ctx.externalBoundaryGuard,
      onSandboxCreateObserved: ctx.onSandboxCreateObserved,
      cancellationSignal: ctx.cancellationSignal,
    } as const;
    let createdSandbox: BoxLiteSandbox;
    try {
      createdSandbox = await this.client.createSandbox(createRequest);
    } catch (error) {
      if (error instanceof BoxLitePartialCreateError) {
        await this.cleanupFailedSandbox(
          ctx,
          error.sandbox.id,
          Object.freeze({
            ...error.sandbox,
            metadata: Object.freeze({
              ...(error.sandbox.metadata ?? {}),
              ...runMetadata,
            }),
          }),
        );
        throw error;
      }
      if (!isBoxLiteCreateConflict(error)) throw error;
      const raced = await this.runProvisionBoundary(
        ctx,
        'sandbox.inspect',
        () => this.client.getSandbox(sandboxId),
      );
      if (!isUsableSandbox(raced)) throw error;
      await this.assertResourceGeneration(raced, ctx.ownership, ctx);
      createdSandbox = raced;
    }
    if (
      createdSandbox.diskSizeGb !== undefined &&
      createdSandbox.diskSizeGb !== resources.diskSizeGb
    ) {
      await this.cleanupFailedSandbox(ctx, createdSandbox.id, createdSandbox);
      throw new SandboxProvisioningCapacityError();
    }
    const sandbox = Object.freeze({
      ...createdSandbox,
      metadata: Object.freeze({
        ...(createdSandbox.metadata ?? {}),
        ...runMetadata,
      }),
    });
    const connection = this.connectionForSandbox(ctx.taskId, sandbox);
    try {
      const preflight = await this.initializeSandboxRun({
        ctx,
        sandbox,
        runtimeId,
        environment: resolvedEnvironment,
        resources,
      });
      const run: BoxLiteProvisionedRun = {
        taskId: ctx.taskId,
        sandbox,
        connection,
        preflight,
        environment: resolvedEnvironment,
      };
      this.runs.set(ctx.taskId, run);
      return connection;
    } catch (err) {
      this.forgetRun(ctx.taskId, sandbox.id);
      await this.cleanupFailedSandbox(ctx, sandbox.id, sandbox);
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

  async teardownSandbox(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      readonly providerSandboxId?: string;
      readonly disposition?: SandboxTeardownDisposition;
    } = {},
  ): Promise<SandboxTeardownResult> {
    const ownership = this.cleanupOwnershipFor(taskId, options);
    // Always resolve through the provider before destructive work.  A cached
    // object cannot distinguish a replaced resource. Generation-scoped ids
    // additionally ensure an old delete can never address a newer incarnation.
    const sandboxId =
      options.providerSandboxId ?? this.sandboxIdForTask(taskId, ownership);
    const run = await this.resolveExistingRun(
      taskId,
      ownership,
      undefined,
      sandboxId,
    );
    if (!run) return { kind: 'already-absent' };
    await this.assertResourceGeneration(run.sandbox, ownership);
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
    await deleteBoxLiteSandboxAndConfirm({
      client: this.client,
      sandboxId,
    });
    this.forgetRun(taskId, sandboxId);
    return { kind: 'found-and-cleaned' };
  }

  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    if (!this.transcriptRead) return null;
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return this.transcriptRead({
      taskId,
      runtimeId:
        runtimeId ??
        ((await this.resolveRuntimeId(taskId)) as TRuntimeId | null),
      sandbox: run.sandbox,
      executor: this.createCommandExecutor(run.sandbox.id),
      workspacePath: this.config.workspacePath,
    });
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
    if (isSandboxLegacyDeliverWorkspaceArgs(args)) {
      return {
        hadChanges: false,
        commitSha: null,
        error: 'Legacy raw-header Git delivery is disabled',
      };
    }
    if (!this.workspaceDelivery) {
      return {
        hadChanges: false,
        commitSha: null,
        error: 'Credentialed delivery requires the staged workspace hook',
      };
    }
    if (
      (args.beforeSandboxCleanup === undefined) !==
      (args.afterSandboxCleanup === undefined)
    ) {
      throw new SandboxProviderConfigurationError(
        'BoxLite delivery cleanup callbacks must be provided together',
      );
    }
    if (
      args.ownership &&
      (!args.beforeSandboxCleanup || !args.afterSandboxCleanup)
    ) {
      throw new SandboxProviderConfigurationError(
        'BoxLite durable delivery cleanup requires owner generation callbacks',
      );
    }

    const run = await this.requireRun(taskId, args.ownership);
    const adapter = createBoxLiteWorkspaceSecurityAdapter({
      client: this.client,
      sandboxId: run.sandbox.id,
      taskId,
      providerId: this.providerId,
      ownership: args.ownership,
      secretDirectory: resolveBoxLiteGitSecretDirectory(
        this.config.workspacePath,
      ),
      beforeSandboxCleanup: args.beforeSandboxCleanup,
      afterSandboxCleanup: args.afterSandboxCleanup,
    });
    let result: SandboxDeliverWorkspaceResult;
    try {
      result = await this.workspaceDelivery({
        taskId,
        plan: Object.freeze({
          branch: args.branch,
          commitMessage: args.commitMessage,
          credential: args.credential,
          deadlineMs: args.deadlineMs ?? this.config.gitCloneTimeoutMs,
          ...(args.cancellationSignal === undefined
            ? {}
            : { cancellationSignal: args.cancellationSignal }),
        }),
        workspaceDir: this.config.workspacePath,
        stageExecutor: adapter.stageExecutor,
        secretFilePort: adapter.secretFilePort,
      });
    } finally {
      try {
        await adapter.settleCredentialSafety();
      } finally {
        if (adapter.wasSandboxFenced()) this.forgetRun(taskId, run.sandbox.id);
      }
    }
    if (adapter.wasSandboxFenced() && result.error === null) {
      throw new SandboxProviderConfigurationError(
        'BoxLite workspace delivery cannot retain a fenced sandbox',
      );
    }
    return result;
  }

  async listReadoptable(): Promise<string[]> {
    return [...this.runs.keys()];
  }

  async reattach(
    taskId: string,
    target?: SandboxReadoptionTarget,
  ): Promise<SandboxConnection | null> {
    const run = await this.resolveExistingRun(
      taskId,
      target?.ownership,
      undefined,
      target?.providerSandboxId,
    );
    return run?.connection ?? null;
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun | null> {
    const run = await this.resolveExistingRun(taskId);
    if (!run) return null;
    return {
      taskId,
      providerId: this.providerId,
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
        provider: this.providerId,
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
        provider: this.providerId,
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

  private createProvisionCommandExecutor(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandboxId: string,
  ): SandboxCommandExecutor {
    const executor = this.createCommandExecutor(sandboxId);
    return {
      exec: (request) => this.runProvisionBoundary(
        ctx,
        'command.execute',
        () => executor.exec(request),
      ),
    };
  }

  private runProvisionBoundary<T>(
    ctx: SandboxProvisionContext<TCloneSpec>,
    action: SandboxExternalBoundaryAction,
    run: () => Promise<T>,
  ): Promise<T> {
    return runSandboxExternalBoundary({
      taskId: ctx.taskId,
      action,
      guard: ctx.externalBoundaryGuard,
      signal: ctx.cancellationSignal,
      run,
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

  private async initializeSandboxRun(args: {
    readonly ctx: SandboxProvisionContext<TCloneSpec>;
    readonly sandbox: BoxLiteSandbox;
    readonly runtimeId: string | null;
    readonly environment: SandboxResolvedEnvironmentMetadata | null;
    readonly resources: SandboxResourceSnapshot;
  }): Promise<SandboxPreflightResult> {
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    reportSandboxProvisioningProgress(args.ctx.onProvisioningProgress, {
      status: 'started',
      stage: 'readiness',
    });
    const diskSizeGb = args.resources.diskSizeGb;
    if (diskSizeGb !== undefined) {
      const capacityProbe = await this.runProvisionBoundary(
        args.ctx,
        'sandbox.readiness',
        () => probeBoxLiteDiskCapacity({
          client: this.client,
          sandboxId: args.sandbox.id,
          diskSizeGb,
          cwd: this.config.workspacePath,
        }),
      );
      if (!capacityProbe.ok) {
        throw new SandboxProvisioningCapacityError();
      }
    }

    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    const preflight = await this.runProvisionBoundary(
      args.ctx,
      'runtime.preflight',
      async () => {
        try {
          return await this.runPreflight(
            args.ctx.taskId,
            args.sandbox,
            args.runtimeId,
            args.environment,
            args.ctx,
          );
        } catch (error) {
          throw redactSandboxProvisioningStageFailure(
            'runtime_setup',
            error,
          );
        }
      },
    );
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    if (preflight.status === 'failed') {
      throw new SandboxProvisioningStageError('runtime_setup');
    }

    await this.runProvisionBoundary(
      args.ctx,
      'workspace.materialize',
      () => this.materializeWorkspace(args.ctx, args.sandbox),
    );
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    await args.ctx.beforeProvisioningBoundary?.({ stage: 'runtime_setup' });
    reportSandboxProvisioningProgress(args.ctx.onProvisioningProgress, {
      status: 'started',
      stage: 'runtime_setup',
    });
    const runtimeSetup = this.runtimeSetup;
    if (runtimeSetup) {
      await this.runProvisionBoundary(
        args.ctx,
        'runtime.setup',
        async () => {
          try {
            await runtimeSetup({
              taskId: args.ctx.taskId,
              modelIntent: args.ctx.modelIntent,
              executionMode: args.ctx.executionMode,
              sandbox: args.sandbox,
              executor: this.createProvisionCommandExecutor(
                args.ctx,
                args.sandbox.id,
              ),
              workspacePath: this.config.workspacePath,
              runtimeId: args.runtimeId,
            });
          } catch (error) {
            throw redactSandboxProvisioningStageFailure(
              'runtime_setup',
              error,
            );
          }
        },
      );
    }
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    return preflight;
  }

  private async materializeWorkspace(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandbox: BoxLiteSandbox,
  ): Promise<void> {
    if (ctx.workspace !== undefined) {
      if (ctx.workspace === null) return;
      const hook = this.workspaceMaterialization;
      if (!hook) {
        throw new SandboxProviderConfigurationError(
          'BoxLite canonical workspace materialization requires the staged workspace hook',
        );
      }

      const plan = ctx.workspace;
      if (
        ctx.ownership &&
        (!ctx.beforeSandboxCleanup || !ctx.afterSandboxCleanup)
      ) {
        throw new SandboxProviderConfigurationError(
          'BoxLite durable workspace cleanup requires owner generation callbacks',
        );
      }
      const adapter = createBoxLiteWorkspaceSecurityAdapter({
        client: this.client,
        sandboxId: sandbox.id,
        taskId: ctx.taskId,
        providerId: this.providerId,
        ownership: ctx.ownership,
        secretDirectory: resolveBoxLiteGitSecretDirectory(
          this.config.workspacePath,
        ),
        beforeSandboxCleanup: ctx.beforeSandboxCleanup,
        afterSandboxCleanup: ctx.afterSandboxCleanup,
      });
      const result = await (async () => {
        try {
          return await hook({
            taskId: ctx.taskId,
            plan,
            workspaceDir: this.config.workspacePath,
            stageExecutor: adapter.stageExecutor,
            secretFilePort: adapter.secretFilePort,
            ...(ctx.cancellationSignal === undefined
              ? {}
              : { cancellationSignal: ctx.cancellationSignal }),
            ...(ctx.onWorkspaceProgress === undefined
              ? {}
              : { onProgress: ctx.onWorkspaceProgress }),
            ...(ctx.beforeWorkspaceBoundary === undefined
              ? {}
              : { beforeBoundary: ctx.beforeWorkspaceBoundary }),
          });
        } finally {
          await adapter.settleCredentialSafety();
        }
      })();

      if (result.status !== 'succeeded') {
        throw new SandboxWorkspaceMaterializationError(result);
      }
      if (adapter.wasSandboxFenced()) {
        throw new SandboxProviderConfigurationError(
          'BoxLite workspace materialization cannot retain a fenced sandbox',
        );
      }
      return;
    }

    if (!ctx.cloneSpec) return;
    await materializeGitWorkspace({
      executor: this.createProvisionCommandExecutor(ctx, sandbox.id),
      workspacePath: this.config.workspacePath,
      cloneSpec: requireGitCloneSpec(ctx.cloneSpec),
    });
  }

  private async cleanupFailedSandbox(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandboxId: string,
    knownSandbox?: BoxLiteSandbox,
  ): Promise<void> {
    let cleanupAuthorization: SandboxRunCleanupAuthorization | undefined;
    let cleanupOwnership = ctx.ownership;
    if (ctx.ownership) {
      if (!ctx.beforeSandboxCleanup || !ctx.afterSandboxCleanup) {
        throw new SandboxProviderConfigurationError(
          'BoxLite durable cleanup requires owner generation callbacks',
        );
      }
      cleanupAuthorization =
        (await ctx.beforeSandboxCleanup()) ?? undefined;
      if (!cleanupAuthorization) return;
      cleanupOwnership = this.cleanupOwnershipFor(ctx.taskId, {
        ownership: ctx.ownership,
        cleanupAuthorization,
      });
      if (!cleanupOwnership) {
        throw new SandboxProviderConfigurationError(
          'BoxLite durable cleanup requires a generation authorization',
        );
      }
      const sandbox = knownSandbox ?? await this.client.getSandbox(sandboxId);
      if (isUsableSandbox(sandbox)) {
        await this.assertResourceGeneration(sandbox, cleanupOwnership);
      }
    }
    try {
      await deleteBoxLiteSandboxAndConfirm({
        client: this.client,
        sandboxId,
      });
    } catch {
      if (ctx.workspace !== undefined && ctx.workspace !== null) {
        throw new SandboxProviderConfigurationError(
          'BoxLite staged workspace cleanup could not be confirmed',
        );
      }
      if (ctx.ownership) {
        throw new SandboxProviderConfigurationError(
          'BoxLite sandbox cleanup could not be confirmed',
        );
      }
      throw new SandboxProviderConfigurationError(
        'BoxLite sandbox deletion could not be confirmed',
      );
    }
    if (cleanupAuthorization) {
      await ctx.afterSandboxCleanup?.(cleanupAuthorization);
    }
  }

  private async runPreflight(
    taskId: string,
    sandbox: BoxLiteSandbox,
    runtimeId: string | null,
    environment?: SandboxResolvedEnvironmentMetadata | null,
    ctx?: SandboxProvisionContext<TCloneSpec>,
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
      executor: ctx
        ? this.createProvisionCommandExecutor(ctx, sandbox.id)
        : this.createCommandExecutor(sandbox.id),
      runtimeId,
    });
    return environment && !preflight.environment
      ? { ...preflight, environment }
      : preflight;
  }

  private async requireRun(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<BoxLiteProvisionedRun> {
    const run = await this.resolveExistingRun(taskId, ownership);
    if (!run) {
      throw new Error(`BoxLite sandbox for task ${taskId} is not available`);
    }
    return run;
  }

  private async resolveExistingRun(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    ctx?: SandboxProvisionContext<TCloneSpec>,
    providerSandboxId?: string,
  ): Promise<BoxLiteProvisionedRun | null> {
    const stored = this.runs.get(taskId);
    const cached =
      stored &&
      (providerSandboxId === undefined || stored.sandbox.id === providerSandboxId)
        ? stored
        : undefined;
    if (cached) {
      const refreshed = ctx
        ? await this.runProvisionBoundary(
            ctx,
            'sandbox.inspect',
            () => this.client.getSandbox(cached.sandbox.id),
          )
        : await this.client.getSandbox(cached.sandbox.id);
      if (isUsableSandbox(refreshed)) {
        await this.assertResourceGeneration(refreshed, ownership, ctx);
        if (refreshed === cached.sandbox) return cached;
        const run: BoxLiteProvisionedRun = {
          ...cached,
          sandbox: refreshed,
          connection: this.connectionForSandbox(taskId, refreshed),
        };
        this.runs.set(taskId, run);
        return run;
      }
    }
    const sandboxId =
      providerSandboxId ??
      cached?.sandbox.id ??
      this.sandboxIdForTask(taskId, ownership);
    const sandbox = ctx
      ? await this.runProvisionBoundary(
          ctx,
          'sandbox.inspect',
          () => this.client.getSandbox(sandboxId),
        )
      : await this.client.getSandbox(sandboxId);
    if (!isUsableSandbox(sandbox)) {
      if (!stored || stored.sandbox.id === sandboxId) {
        this.runs.delete(taskId);
      }
      return null;
    }
    await this.assertResourceGeneration(sandbox, ownership, ctx);
    if (cached && sandbox === cached.sandbox) return cached;
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

  private sandboxIdForTask(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): string {
    if (!ownership) return `${this.config.sandboxIdPrefix}${taskId}`;
    const taskHint = taskId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 8) || 'task';
    const resourceDigest = createHash('sha256')
      .update(taskId)
      .update('\0')
      .update(ownership.resourceGeneration)
      .digest('hex')
      .slice(0, 32);
    return `${this.config.sandboxIdPrefix}${taskHint}-g-${resourceDigest}`;
  }

  private forgetRun(taskId: string, providerSandboxId: string): void {
    if (this.runs.get(taskId)?.sandbox.id === providerSandboxId) {
      this.runs.delete(taskId);
    }
  }

  private cleanupOwnershipFor(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
    },
  ): SandboxOwnershipFence | undefined {
    const authorization = options.cleanupAuthorization;
    if (!authorization) return options.ownership;
    if (
      authorization.taskId !== taskId ||
      authorization.providerId !== this.providerId
    ) {
      throw new Error('BoxLite cleanup authorization target mismatch');
    }
    if (authorization.kind === 'legacy') {
      if (options.ownership) {
        throw new Error('BoxLite legacy cleanup cannot carry generation ownership');
      }
      return undefined;
    }
    if (
      options.ownership &&
      options.ownership.resourceGeneration !==
        authorization.ownership.resourceGeneration
    ) {
      throw new Error('BoxLite cleanup authorization resource generation mismatch');
    }
    return authorization.ownership;
  }

  private async assertResourceGeneration(
    sandbox: BoxLiteSandbox,
    ownership: SandboxOwnershipFence | undefined,
    ctx?: SandboxProvisionContext<TCloneSpec>,
  ): Promise<void> {
    if (!ownership) return;
    if (sandbox.metadata?.resourceGeneration !== undefined) {
      if (
        sandbox.metadata.resourceGeneration !== ownership.resourceGeneration
      ) {
        throw new Error('BoxLite sandbox resource generation mismatch');
      }
      return;
    }
    const probeRequest = {
      sandboxId: sandbox.id,
      command:
        `test "$CAP_RESOURCE_GENERATION" = ` +
        shellQuote(ownership.resourceGeneration),
      timeoutMs: this.config.timeoutMs,
    } as const;
    const probe = ctx
      ? await this.runProvisionBoundary(
          ctx,
          'command.execute',
          () => this.client.exec(probeRequest),
        )
      : await this.client.exec(probeRequest);
    if (probe.exitCode !== 0) {
      throw new Error('BoxLite sandbox resource generation mismatch');
    }
  }

  private async resolveEnvironment(
    ctx: SandboxProvisionContext<TCloneSpec>,
    runtimeId: string | null,
  ): Promise<SandboxResolvedEnvironmentMetadata | null> {
    if (ctx.environment !== undefined) return ctx.environment ?? null;
    return (
      (await this.resolveEnvironmentHook?.({
        taskId: ctx.taskId,
        runtimeId,
      })) ?? null
    );
  }

  private async resolveRuntimeId(taskId: string): Promise<string | null> {
    return (await this.resolveRuntimeIdHook?.(taskId)) ?? null;
  }

  private resolveSandboxSource(
    environment: SandboxResolvedEnvironmentMetadata | null,
    runtimeId: string | null,
  ): { kind: 'image' | 'rootfs'; value: string } {
    if (!environment) {
      return resolveBoxLiteSandboxSource({ config: this.config, runtimeId });
    }
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
  options: BoxLiteProviderDescriptorOptions<TRuntimeId, TTranscriptSource>,
): SandboxProviderDescriptor<BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>> {
  const id = options.id ?? options.config.providerId;
  const provider = new BoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>(
    {
      ...options,
      providerId: id,
      preflight:
        options.preflight ??
        createBoxLiteRuntimePreflight({
          requiredTools: requiredToolsForBoxLiteCapabilities(options.config.capabilities),
          workspacePath: options.config.workspacePath,
        }),
    },
  );
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

function throwIfBoxLiteProvisionCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('BoxLite provisioning was cancelled');
  error.name = 'AbortError';
  throw error;
}

function isBoxLiteCreateConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly message?: unknown;
  };
  return (
    candidate.status === 409 ||
    candidate.statusCode === 409 ||
    (typeof candidate.message === 'string' &&
      /(?:^|\s)HTTP 409(?:\s|$)/u.test(candidate.message))
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function nativeApiPath(pathPrefix: string): string {
  return pathPrefix ? `/v1/${pathPrefix}` : '/v1';
}

function nativeBoxPath(pathPrefix: string, sandboxId: string): string {
  return `${nativeApiPath(pathPrefix)}/boxes/${encodeURIComponent(sandboxId)}`;
}
