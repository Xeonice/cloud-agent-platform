import type {
  GitCloneSpec,
  SandboxCommandEndpointDescriptor,
  SandboxCommandExecutionRequest,
  SandboxCommandExecutor,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxExternalBoundaryAction,
  SandboxExternalBoundaryGuard,
  SandboxInventoryReconcileInput,
  SandboxInventoryReconcileResult,
  SandboxPreflightResult,
  SandboxOwnershipFence,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisionContext,
  SandboxReadoptionPort,
  SandboxReadoptionTarget,
  SandboxRetentionPolicy,
  SandboxResolvedEnvironmentMetadata,
  SandboxRunCleanupAuthorization,
  SandboxSelectedRunPort,
  SandboxTeardownDisposition,
  SandboxTeardownResult,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  TaskModelIntent,
  SandboxWorkspaceDescriptor,
  SandboxWorkspaceDeliveryHook,
  SandboxWorkspaceMaterializationHook,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  assertSandboxProviderSupportsResources,
  buildSandboxCommandLine,
  isSandboxLegacyDeliverWorkspaceArgs,
  latchSandboxExternalBoundaryGuard,
  normalizeSandboxCommandResult,
  redactSandboxProvisioningStageFailure,
  reportSandboxProvisioningProgress,
  resourcesForSandboxProvision,
  runSandboxExternalBoundary,
  SandboxProvisioningStageError,
  SandboxProviderConfigurationError,
  SandboxWorkspaceMaterializationError,
  snapshotSandboxProvisionContext,
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
import { createAioWorkspaceSecurityAdapter } from './aio-workspace-security.js';

type MaybePromise<T> = T | Promise<T>;

const AIO_WORKSPACE_DELIVERY_TIMEOUT_MS = 120_000;

export interface AioProvisionLookupHook<TCloneSpec, TRuntimeId> {
  getCloneSpec?(taskId: string): MaybePromise<TCloneSpec | null>;
  getRuntimeId?(taskId: string): MaybePromise<TRuntimeId | null | undefined>;
  getTaskPrompt?(taskId: string): MaybePromise<string | null | undefined>;
  getResolvedEnvironment?(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): MaybePromise<SandboxResolvedEnvironmentMetadata | null | undefined>;
}

export interface AioProviderExecutionContext<TRuntimeId = string> {
  readonly taskId: string;
  readonly modelIntent: TaskModelIntent;
  readonly executionMode: 'interactive-pty' | 'headless-exec';
  readonly runtimeId?: TRuntimeId | null;
  readonly connection: SandboxConnection;
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly providerSandboxId: string;
  readonly containerName: string;
  readonly controller: AioSandboxContainerController;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
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
  readonly workspaceMaterialization?: SandboxWorkspaceMaterializationHook;
  readonly workspaceDelivery?: SandboxWorkspaceDeliveryHook;
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
  readonly taskId?: string;
  readonly externalBoundaryGuard?: SandboxExternalBoundaryGuard;
  readonly signal?: AbortSignal;
}

interface AioCommandBoundaryContext {
  readonly taskId: string;
  readonly guard?: SandboxExternalBoundaryGuard;
  readonly signal?: AbortSignal;
}

interface AioProvisionedRun<TRuntimeId> {
  readonly taskId: string;
  readonly connection: SandboxConnection;
  readonly providerSandboxId?: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly preflight?: SandboxPreflightResult;
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
  readonly ownership?: SandboxOwnershipFence;
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
    ctx = snapshotSandboxProvisionContext({
      ...ctx,
      externalBoundaryGuard: latchSandboxExternalBoundaryGuard(
        ctx.externalBoundaryGuard,
      ),
    });
    if (
      !ctx.ownership &&
      (ctx.beforeSandboxCleanup !== undefined ||
        ctx.afterSandboxCleanup !== undefined)
    ) {
      throw new SandboxProviderConfigurationError(
        'AIO sandbox cleanup callbacks require an ownership fence',
      );
    }
    if (ctx.workspace !== undefined && ctx.workspace !== null && !this.hooks.workspaceMaterialization) {
      throw new SandboxProviderConfigurationError(
        'AIO canonical workspace materialization requires the staged workspace hook',
      );
    }
    assertSandboxProviderSupportsResources(
      this.getProviderCapabilities(),
      resourcesForSandboxProvision(ctx),
    );
    let connection: SandboxConnection | null = null;
    let runtimeId: TRuntimeId | null | undefined;
    let environment: SandboxResolvedEnvironmentMetadata | null | undefined;

    try {
      runtimeId = ctx.runtimeId as TRuntimeId;
      environment = await this.runProvisionBoundary(
        ctx,
        'environment.resolve',
        () => this.resolveEnvironment(ctx, runtimeId),
      );
      const provisioned = await this.controller.createAndStart(
        ctx.taskId,
        environment,
        undefined,
        {
          signal: ctx.cancellationSignal,
          ownership: ctx.ownership,
          externalBoundaryGuard: ctx.externalBoundaryGuard,
          onSandboxCreateObserved: ctx.onSandboxCreateObserved,
        },
      );
      const { spec, providerSandboxId } = provisioned;
      connection = provisioned.connection;
      const rawWorkspaceExecutor = this.createCommandExecutor(
        connection.baseUrl,
        {
          taskId: ctx.taskId,
          signal: ctx.cancellationSignal,
        },
      );
      const guardedHookExecutor = this.createCommandExecutor(connection.baseUrl, {
        taskId: ctx.taskId,
        guard: ctx.externalBoundaryGuard,
        signal: ctx.cancellationSignal,
      });
      const executionContext: AioProviderExecutionContext<TRuntimeId> = {
        taskId: ctx.taskId,
        modelIntent: ctx.modelIntent,
        executionMode: ctx.executionMode,
        runtimeId,
        connection,
        executor: guardedHookExecutor,
        workspaceDir: this.workspaceDir,
        providerSandboxId,
        containerName: spec.containerName,
        controller: this.controller,
        environment,
      };
      reportSandboxProvisioningProgress(ctx.onProvisioningProgress, {
        status: 'started',
        stage: 'readiness',
      });
      await this.controller.waitForReadiness({
        baseUrl: executionContext.connection.baseUrl,
        taskId: ctx.taskId,
        timeoutMs: spec.readinessTimeoutMs,
        signal: ctx.cancellationSignal,
        externalBoundaryGuard: ctx.externalBoundaryGuard,
      });
      reportSandboxProvisioningProgress(ctx.onProvisioningProgress, {
        status: 'started',
        stage: 'runtime_setup',
      });
      const preflight = await this.runProvisionBoundary(
        ctx,
        'runtime.preflight',
        async () => {
          try {
            return await this.runRuntimePreflight(executionContext);
          } catch (error) {
            throw redactSandboxProvisioningStageFailure(
              'runtime_setup',
              error,
            );
          }
        },
      );
      if (preflight.status === 'failed') {
        throw new SandboxProvisioningStageError('runtime_setup');
      }
      const prompt = await this.runProvisionBoundary(
        ctx,
        'prompt.lookup',
        () => this.hooks.provisionLookup?.getTaskPrompt?.(ctx.taskId),
      );
      const promptContext: AioPromptAuthInjectionContext<TRuntimeId> = {
        ...executionContext,
        prompt: prompt ?? null,
      };
      await this.runProvisionBoundary(ctx, 'prompt-auth.inject', () =>
        this.hooks.promptAuthInjection?.(promptContext),
      );
      await this.runProvisionBoundary(ctx, 'runtime.setup', async () => {
        try {
          await this.hooks.runtimeSetup?.(promptContext);
        } catch (error) {
          throw redactSandboxProvisioningStageFailure(
            'runtime_setup',
            error,
          );
        }
      });
      await this.runProvisionBoundary(ctx, 'workspace.materialize', () =>
        this.materializeWorkspace(ctx, rawWorkspaceExecutor),
      );
      await this.runProvisionBoundary(ctx, 'skills.preinstall', () =>
        this.hooks.skillPreinstall?.(executionContext),
      );
      this.runs.set(ctx.taskId, {
        taskId: ctx.taskId,
        connection,
        providerSandboxId,
        runtimeId,
        preflight: this.withEnvironment(preflight, environment),
        environment,
        ownership: ctx.ownership,
      });
    } catch (err) {
      this.runs.delete(ctx.taskId);
      const cleanupAuthorization = ctx.beforeSandboxCleanup
        ? await ctx.beforeSandboxCleanup()
        : null;
      if (ctx.beforeSandboxCleanup && !cleanupAuthorization) throw err;
      if (ctx.ownership && !cleanupAuthorization) throw err;
      if (cleanupAuthorization) {
        assertAioCleanupAuthorization(
          cleanupAuthorization,
          ctx.taskId,
          this.id,
        );
        if (
          ctx.ownership &&
          (cleanupAuthorization.kind !== 'generation' ||
            cleanupAuthorization.ownership.resourceGeneration !==
              ctx.ownership.resourceGeneration)
        ) {
          throw new SandboxProviderConfigurationError(
            'AIO cleanup authorization changed physical resource generation',
          );
        }
      }
      const cleanupOwnership =
        cleanupAuthorization?.kind === 'generation'
          ? cleanupAuthorization.ownership
          : undefined;
      let cleanupResult: SandboxTeardownResult | null = null;
      try {
        if (
          ctx.workspace?.credential !== undefined ||
          cleanupAuthorization?.kind === 'generation'
        ) {
          cleanupResult = await this.controller.removeSandboxAndConfirm(
            ctx.taskId,
            cleanupOwnership,
          );
        } else {
          cleanupResult = await this.cleanupFailedProvision(
            ctx.taskId,
            runtimeId,
            cleanupOwnership,
          );
        }
      } catch {
        if (ctx.workspace?.credential !== undefined) {
          throw new SandboxProviderConfigurationError(
            'AIO credentialed workspace cleanup could not be confirmed',
          );
        }
        if (cleanupAuthorization?.kind === 'generation') {
          throw new SandboxProviderConfigurationError(
            'AIO sandbox cleanup could not be confirmed',
          );
        }
        // Legacy provisioning cleanup remains best-effort for compatibility.
      }
      if (
        cleanupAuthorization &&
        cleanupResult?.kind === 'found-and-cleaned'
      ) {
        await ctx.afterSandboxCleanup?.(cleanupAuthorization);
      }
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
    ownership?: SandboxOwnershipFence,
  ): Promise<SandboxTeardownResult> {
    const result = await this.controller.teardownSandbox(taskId, {
      ownership,
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
    return result;
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
    const run = this.runs.get(taskId);
    if (options.cleanupAuthorization) {
      assertAioCleanupAuthorization(
        options.cleanupAuthorization,
        taskId,
        this.id,
      );
    }
    const ownership =
      options.cleanupAuthorization?.kind === 'generation'
        ? options.cleanupAuthorization.ownership
        : options.cleanupAuthorization?.kind === 'legacy'
          ? undefined
          : options.ownership ?? run?.ownership;
    const providerSandboxId =
      options.providerSandboxId ??
      run?.providerSandboxId ??
      this.controller.getProviderSandboxId(taskId);
    const result = options.disposition === 'superseded-remove'
      ? await this.controller.removeSandboxAndConfirm(
          taskId,
          ownership,
          providerSandboxId,
        )
      : await this.controller.teardownSandbox(taskId, {
          ownership,
          providerSandboxId,
          beforeStop: async ({ baseUrl }) => {
            const executor = this.createCommandExecutor(baseUrl);
            await this.hooks.preStopTrim?.({
              taskId,
              runtimeId:
                run?.runtimeId ?? (await this.resolveRuntimeId(taskId)),
              baseUrl,
              executor,
              workspaceDir: this.workspaceDir,
              controller: this.controller,
            });
          },
        });
    this.runs.delete(taskId);
    return result;
  }

  async removeSandbox(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly providerSandboxId?: string;
    } = {},
  ): Promise<void> {
    await this.controller.removeSandbox(taskId, {
      ownership: options.ownership ?? this.runs.get(taskId)?.ownership,
      providerSandboxId:
        options.providerSandboxId ??
        this.runs.get(taskId)?.providerSandboxId ??
        this.controller.getProviderSandboxId(taskId),
    });
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
    if (isSandboxLegacyDeliverWorkspaceArgs(args)) {
      return failure('Legacy raw-header Git delivery is disabled');
    }
    if (!this.hooks.workspaceDelivery) {
      return failure('Credentialed delivery requires the staged workspace hook');
    }
    if (
      (args.beforeSandboxCleanup === undefined) !==
      (args.afterSandboxCleanup === undefined)
    ) {
      throw new SandboxProviderConfigurationError(
        'AIO delivery cleanup callbacks must be provided together',
      );
    }
    if (
      args.ownership &&
      (!args.beforeSandboxCleanup || !args.afterSandboxCleanup)
    ) {
      throw new SandboxProviderConfigurationError(
        'AIO durable delivery cleanup requires owner generation callbacks',
      );
    }
    const deliveryRun = this.runs.get(taskId);
    const baseUrl = this.controller.resolveBaseUrl(taskId);
    const executor = this.createCommandExecutor(baseUrl);
    const adapter = createAioWorkspaceSecurityAdapter({
      taskId,
      providerId: this.id,
      controller: this.controller,
      executor,
      ownership: args.ownership,
      beforeSandboxCleanup: args.beforeSandboxCleanup,
      afterSandboxCleanup: args.afterSandboxCleanup,
    });
    let result: SandboxDeliverWorkspaceResult;
    try {
      result = await this.hooks.workspaceDelivery({
        taskId,
        plan: {
          branch: args.branch,
          commitMessage: args.commitMessage,
          credential: args.credential,
          deadlineMs: args.deadlineMs ?? AIO_WORKSPACE_DELIVERY_TIMEOUT_MS,
          ...(args.cancellationSignal === undefined
            ? {}
            : { cancellationSignal: args.cancellationSignal }),
        },
        workspaceDir: this.workspaceDir,
        stageExecutor: adapter.stageExecutor,
        secretFilePort: adapter.secretFilePort,
      });
    } finally {
      if (adapter.wasSandboxFenced()) {
        this.forgetFencedDeliveryRun(taskId, deliveryRun);
      }
    }
    if (adapter.wasSandboxFenced() && result.error === null) {
      throw new SandboxProviderConfigurationError(
        'AIO workspace delivery cannot retain a fenced sandbox',
      );
    }
    return result;
  }

  private forgetFencedDeliveryRun(
    taskId: string,
    deliveryRun: AioProvisionedRun<TRuntimeId> | undefined,
  ): void {
    if (!deliveryRun) return;
    const current = this.runs.get(taskId);
    if (!current) return;
    const providerSandboxId = deliveryRun.providerSandboxId;
    const resourceGeneration =
      deliveryRun.ownership?.resourceGeneration;
    if (providerSandboxId === undefined && resourceGeneration === undefined) {
      if (current === deliveryRun) this.runs.delete(taskId);
      return;
    }
    if (
      (providerSandboxId !== undefined &&
        current.providerSandboxId !== providerSandboxId) ||
      (resourceGeneration !== undefined &&
        current.ownership?.resourceGeneration !== resourceGeneration)
    ) {
      return;
    }
    this.runs.delete(taskId);
  }

  async listReadoptable(): Promise<string[]> {
    return this.controller.listReadoptable();
  }

  async reconcileSandboxInventory(
    input: SandboxInventoryReconcileInput,
  ): Promise<SandboxInventoryReconcileResult> {
    return this.controller.reconcileSandboxInventory(input);
  }

  async reattach(
    taskId: string,
    target?: SandboxReadoptionTarget,
  ): Promise<SandboxConnection | null> {
    const reattachRun = this.runs.get(taskId);
    const connection = await this.controller.reattach(taskId, target);
    if (!connection) {
      this.forgetFailedReattachRun(taskId, reattachRun, target);
      return null;
    }
    const runtimeId = await this.resolveRuntimeId(taskId);
    const providerSandboxId =
      this.controller.getProviderSandboxId(taskId) ??
      target?.providerSandboxId;
    this.runs.set(taskId, {
      taskId,
      connection,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      runtimeId,
      preflight: this.skippedPreflight(runtimeId),
      ownership: target?.ownership,
    });
    return connection;
  }

  private forgetFailedReattachRun(
    taskId: string,
    reattachRun: AioProvisionedRun<TRuntimeId> | undefined,
    target: SandboxReadoptionTarget | undefined,
  ): void {
    if (!reattachRun || this.runs.get(taskId) !== reattachRun) return;
    if (
      target?.providerSandboxId !== undefined &&
      reattachRun.providerSandboxId !== target.providerSandboxId
    ) {
      return;
    }
    if (
      target?.ownership !== undefined &&
      (reattachRun.ownership?.ownerGeneration !==
        target.ownership.ownerGeneration ||
        reattachRun.ownership.resourceGeneration !==
          target.ownership.resourceGeneration)
    ) {
      return;
    }
    this.runs.delete(taskId);
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun | null> {
    const connection = this.connectionForTask(taskId);
    return {
      taskId,
      providerId: this.id,
      ...(this.runs.get(taskId)?.providerSandboxId === undefined
        ? {}
        : { providerSandboxId: this.runs.get(taskId)?.providerSandboxId }),
      provider: this,
      capabilities: this.getProviderCapabilities(),
      connection,
      terminal: this.getTerminalDescriptor(taskId),
      command: this.getCommandDescriptor(taskId),
      workspace: this.getWorkspaceDescriptor(taskId),
      retention: this.getRetentionPolicy(taskId),
      preflight: this.runs.get(taskId)?.preflight,
      environment: this.runs.get(taskId)?.environment ?? undefined,
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

  createCommandExecutor(
    baseUrl: string,
    boundary?: AioCommandBoundaryContext,
  ): SandboxCommandExecutor {
    return createAioHttpCommandExecutor({
      baseUrl,
      fetch: this.fetch,
      taskId: boundary?.taskId,
      externalBoundaryGuard: boundary?.guard,
      signal: boundary?.signal,
    });
  }

  releaseHandles(): void {
    this.controller.releaseHandles();
    this.runs.clear();
  }

  private runProvisionBoundary<T>(
    ctx: SandboxProvisionContext<TCloneSpec>,
    action: SandboxExternalBoundaryAction,
    run: () => MaybePromise<T>,
  ): Promise<T> {
    return runSandboxExternalBoundary({
      taskId: ctx.taskId,
      action,
      guard: ctx.externalBoundaryGuard,
      signal: ctx.cancellationSignal,
      run: async () => run(),
    });
  }

  private async resolveRuntimeId(taskId: string): Promise<TRuntimeId | null> {
    return (await this.hooks.provisionLookup?.getRuntimeId?.(taskId)) ?? null;
  }

  private async resolveEnvironment(
    ctx: SandboxProvisionContext<TCloneSpec>,
    runtimeId: TRuntimeId | null | undefined,
  ): Promise<SandboxResolvedEnvironmentMetadata | null> {
    if (ctx.environment !== undefined) return ctx.environment ?? null;
    return (
      (await this.hooks.provisionLookup?.getResolvedEnvironment?.(
        ctx.taskId,
        runtimeId,
      )) ?? null
    );
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
    if (ctx.workspace !== undefined) {
      if (ctx.workspace === null) return;
      const hook = this.hooks.workspaceMaterialization;
      if (!hook) {
        throw new SandboxProviderConfigurationError(
          'AIO canonical workspace materialization requires the staged workspace hook',
        );
      }
      const adapter = createAioWorkspaceSecurityAdapter({
        taskId: ctx.taskId,
        providerId: this.id,
        controller: this.controller,
        executor,
        ownership: ctx.ownership,
        beforeSandboxCleanup: ctx.beforeSandboxCleanup,
        afterSandboxCleanup: ctx.afterSandboxCleanup,
      });
      const result = await hook({
        taskId: ctx.taskId,
        plan: ctx.workspace,
        workspaceDir: this.workspaceDir,
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
      if (result.status !== 'succeeded') {
        throw new SandboxWorkspaceMaterializationError(result);
      }
      return;
    }
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

  private withEnvironment(
    preflight: SandboxPreflightResult,
    environment: SandboxResolvedEnvironmentMetadata | null | undefined,
  ): SandboxPreflightResult {
    return environment && !preflight.environment
      ? { ...preflight, environment }
      : preflight;
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
  if (options.externalBoundaryGuard && !options.taskId) {
    throw new SandboxProviderConfigurationError(
      'AIO guarded command executor requires a task id',
    );
  }
  const fetchImpl =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init) as ReturnType<AioFetch>);
  return {
    async exec(request: SandboxCommandExecutionRequest) {
      const signal = combineAioCommandSignals(
        options.signal,
        request.signal,
        request.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(request.timeoutMs),
      );
      return runSandboxExternalBoundary({
        taskId: options.taskId ?? 'unscoped-aio-command',
        action: 'command.execute',
        guard: options.externalBoundaryGuard,
        signal,
        run: async () => {
          const res = await fetchImpl(`${options.baseUrl}/v1/shell/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command: buildSandboxCommandLine(request) }),
            signal,
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
          return normalizeSandboxCommandResult(
            await res.json().catch(() => undefined),
          );
        },
      });
    },
  };
}

function combineAioCommandSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const defined = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

function assertAioCleanupAuthorization(
  authorization: SandboxRunCleanupAuthorization,
  taskId: string,
  providerId: string,
): void {
  if (
    authorization.taskId !== taskId ||
    authorization.providerId !== providerId
  ) {
    throw new SandboxProviderConfigurationError(
      'AIO sandbox cleanup authorization does not match the selected run',
    );
  }
}

async function materializeGitWorkspace(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspaceDir: string;
  readonly cloneSpec: GitCloneSpec;
}): Promise<void> {
  if (args.cloneSpec.authHeader !== undefined) {
    throw new SandboxProviderConfigurationError(
      'Legacy raw-header Git clone is disabled',
    );
  }
  const parent = dirname(args.workspaceDir);
  const clone = await args.executor.exec({
    command: [
      `rm -rf ${shellQuote(args.workspaceDir)}`,
      `mkdir -p ${shellQuote(parent)}`,
      `git clone --recursive -- ${shellQuote(
        args.cloneSpec.url,
      )} ${shellQuote(args.workspaceDir)}`,
    ].join(' && '),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`AIO git materialization failed: ${scrubOutput(clone.output)}`);
  }
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

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}
