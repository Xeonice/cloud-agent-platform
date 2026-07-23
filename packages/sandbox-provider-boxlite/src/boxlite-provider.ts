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
  SandboxPhysicalCleanupResult,
  SandboxRunCleanupAuthorization,
  SandboxTeardownResult,
  SandboxTeardownDisposition,
  SandboxPreflightResult,
  SandboxProviderCapability,
  SandboxProviderDescriptor,
  SandboxProviderPort,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticObserver,
  SandboxProvisionContext,
  SandboxReadoptionTarget,
  SandboxReadoptionPort,
  SandboxRetentionPolicy,
  SandboxResolvedEnvironmentMetadata,
  SandboxResourceSnapshot,
  SandboxSelectedRunPort,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
  SandboxWorkspaceArchiveTransferPort,
  SandboxWorkspaceDescriptor,
  SandboxWorkspaceDeliveryHook,
  SandboxWorkspaceMaterializationHook,
  SandboxWorkspaceMaterializationResult,
  SelectedSandboxRun,
} from '@cap/sandbox-core';
import {
  assertSandboxProviderSupportsResources,
  assertSandboxProviderSupportsWorkspaceSource,
  defineCloudSandboxProvider,
  defineLocalSandboxProvider,
  isSandboxLegacyDeliverWorkspaceArgs,
  isSandboxRuntimeCommandExecutionError,
  latchSandboxExternalBoundaryGuard,
  redactSandboxProvisioningStageFailure,
  reportSandboxProvisioningProgress,
  resourcesForSandboxProvision,
  runSandboxExternalBoundary,
  sandboxCommandExecutionDiagnosticFields,
  isSandboxCleanupCoordinationPendingError,
  isSandboxWorkspaceTransferDetachedSignal,
  SandboxCleanupCoordinationPendingError,
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
  startBoxLiteNativeExecutionDiagnosticSession,
  startBoxLiteProvisioningDiagnostic,
  type BoxLiteNativeExecutionDiagnosticSession,
} from './boxlite-provisioning-diagnostics.js';
import {
  createBoxLiteRuntimePreflight,
  requiredToolsForBoxLiteCapabilities,
} from './boxlite-preflight.js';
import { uploadBoxLiteArchiveInParts } from './boxlite-archive-parts.js';
import { materializeGitWorkspace, requireGitCloneSpec } from './boxlite-workspace.js';
import { buildBoxLiteTerminalDescriptor } from './boxlite-terminal.js';
import { buildBoxLiteRetentionPolicy } from './boxlite-retention.js';
import type { BoxLiteProvisionedRun } from './boxlite-types.js';
import { probeBoxLiteDiskCapacity } from './boxlite-environment-validation.js';
import {
  attemptDeleteBoxLiteSandboxAndConfirm,
  createBoxLiteWorkspaceSecurityAdapter,
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
  private readonly declaredCapabilities: readonly SandboxProviderCapability[];
  private readonly runs = new Map<string, BoxLiteProvisionedRun>();
  /** Credential safety is unresolved; only exact cleanup may observe this run. */
  private readonly quarantinedRuns = new Map<string, string>();

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
    this.declaredCapabilities = resolveBoxLiteDeclaredCapabilities({
      configured: options.config.capabilities,
      client: this.client,
      hasWorkspaceMaterialization: this.workspaceMaterialization !== undefined,
    });
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
    return this.declaredCapabilities;
  }

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    ctx.diagnostics?.bindProviderFamily('boxlite');
    ctx = snapshotSandboxProvisionContext({
      ...ctx,
      externalBoundaryGuard: latchSandboxExternalBoundaryGuard(
        ctx.externalBoundaryGuard,
      ),
    });
    if (this.quarantinedRuns.has(ctx.taskId)) {
      throw new SandboxCleanupCoordinationPendingError();
    }
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
    // Fail closed on an injection variant this provider cannot perform, before
    // any sandbox exists (add-repo-content-store D5).
    assertSandboxProviderSupportsWorkspaceSource(
      this.getProviderCapabilities(),
      ctx.workspaceSource,
    );
    const wasCached = this.runs.has(ctx.taskId);
    const existingReadinessDiagnostics =
      startBoxLiteNativeExecutionDiagnosticSession(
        ctx.diagnostics,
        'readiness',
      );
    let existing: BoxLiteProvisionedRun | null;
    try {
      existing = await this.resolveExistingRun(
        ctx.taskId,
        ctx.ownership,
        ctx,
        undefined,
        false,
        existingReadinessDiagnostics,
      );
    } catch (error) {
      existingReadinessDiagnostics.finish();
      throw error;
    }
    if (existing && wasCached) {
      existingReadinessDiagnostics.finish();
      return existing.connection;
    }

    if (existing) {
      try {
        const preflight = await this.initializeSandboxRun({
          ctx,
          sandbox: existing.sandbox,
          runtimeId,
          environment,
          resources,
          readinessDiagnosticSession: existingReadinessDiagnostics,
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
        // A detaching workspace transfer is a control-flow signal, not a
        // provisioning failure: the sandbox and its detached clone job MUST
        // survive parking, so no cleanup/quarantine funnel may run.
        if (isSandboxWorkspaceTransferDetachedSignal(error)) throw error;
        this.forgetRun(ctx.taskId, existing.sandbox.id);
        return this.rethrowAfterFailedSandboxCleanup(
          error,
          ctx,
          existing.sandbox.id,
          existing.sandbox,
        );
      } finally {
        existingReadinessDiagnostics.finish();
      }
    }
    existingReadinessDiagnostics.finish();

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
      diagnostics: ctx.diagnostics,
      diagnosticScope: boxLiteDiagnosticScope(ctx),
    } as const;
    let createdSandbox: BoxLiteSandbox;
    let conflictReadinessDiagnostics:
      | BoxLiteNativeExecutionDiagnosticSession
      | undefined;
    try {
      createdSandbox = await this.client.createSandbox(createRequest);
    } catch (error) {
      if (error instanceof BoxLitePartialCreateError) {
        return this.rethrowAfterFailedSandboxCleanup(
          error,
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
      }
      if (!isBoxLiteCreateConflict(error)) {
        throw error;
      }
      const raced = await this.runProvisionBoundary(
        ctx,
        'sandbox.inspect',
        () => this.client.getSandbox(sandboxId, {
          diagnostics: ctx.diagnostics,
          cancellationSignal: ctx.cancellationSignal,
          diagnosticKey: 'sandbox.inspect.conflict',
          diagnosticScope: boxLiteDiagnosticScope(ctx),
        }),
      );
      if (!isUsableSandbox(raced)) {
        throw error;
      }
      conflictReadinessDiagnostics =
        startBoxLiteNativeExecutionDiagnosticSession(
          ctx.diagnostics,
          'readiness',
        );
      try {
        await this.assertResourceGeneration(
          raced,
          ctx.ownership,
          ctx,
          conflictReadinessDiagnostics,
        );
      } catch (generationError) {
        conflictReadinessDiagnostics.finish();
        throw generationError;
      }
      createdSandbox = raced;
    }
    if (
      createdSandbox.diskSizeGb !== undefined &&
      createdSandbox.diskSizeGb !== resources.diskSizeGb
    ) {
      conflictReadinessDiagnostics?.finish();
      const primary = new SandboxProvisioningCapacityError();
      const diagnostic = startBoxLiteProvisioningDiagnostic(ctx.diagnostics, {
        stage: 'readiness',
        operation: 'runtime_preflight',
        channel: 'primary',
      });
      diagnostic.settle({
        outcome: 'failed',
        cause: 'capacity_exhausted',
        retryable: true,
      });
      return this.rethrowAfterFailedSandboxCleanup(
        primary,
        ctx,
        createdSandbox.id,
        createdSandbox,
      );
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
        ...(conflictReadinessDiagnostics === undefined
          ? {}
          : {
              readinessDiagnosticSession:
                conflictReadinessDiagnostics,
            }),
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
      // A detaching workspace transfer is a control-flow signal, not a
      // provisioning failure: the sandbox and its detached clone job MUST
      // survive parking, so no cleanup/quarantine funnel may run. Resume
      // re-enters provision and readopts this sandbox via resolveExistingRun.
      if (isSandboxWorkspaceTransferDetachedSignal(err)) throw err;
      this.forgetRun(ctx.taskId, sandbox.id);
      return this.rethrowAfterFailedSandboxCleanup(
        err,
        ctx,
        sandbox.id,
        sandbox,
      );
    } finally {
      conflictReadinessDiagnostics?.finish();
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
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    } = {},
  ): Promise<SandboxTeardownResult | SandboxPhysicalCleanupResult> {
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
      true,
    );
    if (!run) {
      this.confirmRunAbsent(taskId, sandboxId);
      return { kind: 'already-absent' };
    }
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
    const physical = await attemptDeleteBoxLiteSandboxAndConfirm({
      client: this.client,
      sandboxId,
      diagnostics: options.diagnostics,
    });
    if (physical.outcome === 'succeeded') {
      this.confirmRunAbsent(taskId, sandboxId);
      return { kind: physical.proof };
    } else {
      this.quarantineRun(taskId, sandboxId);
    }
    return physical;
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
      this.quarantinedRuns.get(taskId) ??
        this.runs.get(taskId)?.sandbox.id ??
        this.sandboxIdForTask(taskId),
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
    const workspaceDelivery = this.workspaceDelivery;
    if (
      (args.beforeSandboxCleanup === undefined) !==
      (args.afterSandboxCleanup === undefined &&
        args.settleSandboxCleanupAttempt === undefined)
    ) {
      throw new SandboxProviderConfigurationError(
        'BoxLite delivery cleanup callbacks must be provided together',
      );
    }
    if (
      args.ownership &&
      (!args.beforeSandboxCleanup ||
        (!args.afterSandboxCleanup &&
          !args.settleSandboxCleanupAttempt))
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
      settleSandboxCleanupAttempt: args.settleSandboxCleanupAttempt,
    });
    let result: SandboxDeliverWorkspaceResult;
    try {
      result = await runWithCredentialSafetySettlement({
        run: () =>
          workspaceDelivery({
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
          }),
        settleCredentialSafety: () => adapter.settleCredentialSafety(),
        primaryFailure: (candidate) =>
          candidate.error === null ? null : candidate,
        isCredentialSafetyConfirmed: () => adapter.wasSandboxFenced(),
        isCleanupCoordinationAcknowledged: () =>
          adapter.wasSandboxCleanupAcknowledged(),
        onSettlementFailure: () =>
          this.quarantineRun(taskId, run.sandbox.id),
      });
    } finally {
      if (
        adapter.wasSandboxFenced() &&
        adapter.wasSandboxCleanupAcknowledged()
      ) {
        this.confirmRunAbsent(taskId, run.sandbox.id);
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
    return [...this.runs.keys()].filter(
      (taskId) => !this.quarantinedRuns.has(taskId),
    );
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
    commandKind?: SandboxProvisioningDiagnosticCommandKind,
    diagnostics: SandboxProvisioningDiagnosticObserver | undefined =
      ctx.diagnostics,
  ): SandboxCommandExecutor {
    const executor = createBoxLiteCommandExecutor({
      client: this.client,
      sandboxId,
      diagnostics,
      commandKind,
    });
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
    readonly readinessDiagnosticSession?: BoxLiteNativeExecutionDiagnosticSession;
  }): Promise<SandboxPreflightResult> {
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    reportSandboxProvisioningProgress(args.ctx.onProvisioningProgress, {
      status: 'started',
      stage: 'readiness',
    });
    const ownsReadinessDiagnosticSession =
      args.readinessDiagnosticSession === undefined;
    const readinessDiagnostics =
      args.readinessDiagnosticSession ??
      startBoxLiteNativeExecutionDiagnosticSession(
        args.ctx.diagnostics,
        'readiness',
      );
    let preflight: SandboxPreflightResult;
    try {
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
            diagnostics: readinessDiagnostics.diagnostics,
          }),
        );
        if (!capacityProbe.ok) {
          throw new SandboxProvisioningCapacityError();
        }
      }

      throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
      preflight = await this.runProvisionBoundary(
        args.ctx,
        'runtime.preflight',
        async () => {
          const preflightDiagnostic = startBoxLiteProvisioningDiagnostic(
            args.ctx.diagnostics,
            {
              key: 'runtime.preflight',
              scope: boxLiteDiagnosticScope(args.ctx),
              stage: 'readiness',
              operation: 'runtime_preflight',
              channel: 'primary',
              commandKind: 'runtime_preflight',
            },
          );
          try {
            const result = await this.runPreflight(
              args.ctx.taskId,
              args.sandbox,
              args.runtimeId,
              args.environment,
              args.ctx,
              readinessDiagnostics.diagnostics,
            );
            if (result.status === 'failed') {
              preflightDiagnostic.settle({
                outcome: 'failed',
                cause: 'command_failed',
                retryable: false,
              });
            } else {
              preflightDiagnostic.succeed();
            }
            return result;
          } catch (error) {
            if (isSandboxRuntimeCommandExecutionError(error)) {
              preflightDiagnostic.settle(
                sandboxCommandExecutionDiagnosticFields(
                  error.classification,
                ),
              );
            } else {
              preflightDiagnostic.fail(error, {
                signal: args.ctx.cancellationSignal,
                cause: 'unknown',
                retryable: false,
              });
            }
            throw redactSandboxProvisioningStageFailure(
              'runtime_setup',
              error,
            );
          }
        },
      );
    } finally {
      if (ownsReadinessDiagnosticSession) {
        readinessDiagnostics.finish();
      }
    }
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    if (preflight.status === 'failed') {
      throw new SandboxProvisioningStageError('runtime_setup');
    }

    await this.materializeWorkspaceWithDiagnostic(args.ctx, args.sandbox);
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    await args.ctx.beforeProvisioningBoundary?.({ stage: 'runtime_setup' });
    reportSandboxProvisioningProgress(args.ctx.onProvisioningProgress, {
      status: 'started',
      stage: 'runtime_setup',
    });
    const runtimeSetup = this.runtimeSetup;
    if (runtimeSetup) {
      const runtimeDiagnostics = startBoxLiteNativeExecutionDiagnosticSession(
        args.ctx.diagnostics,
        'runtime_setup',
      );
      try {
        await this.runProvisionBoundary(
          args.ctx,
          'runtime.setup',
          async () => {
            const runtimeSetupDiagnostic = startBoxLiteProvisioningDiagnostic(
              args.ctx.diagnostics,
              {
                key: 'runtime.setup',
                scope: boxLiteDiagnosticScope(args.ctx),
                stage: 'runtime_setup',
                operation: 'runtime_setup',
                channel: 'primary',
                commandKind: 'runtime_setup',
              },
            );
            try {
              await runtimeSetup({
                taskId: args.ctx.taskId,
                modelIntent: args.ctx.modelIntent,
                executionMode: args.ctx.executionMode,
                sandbox: args.sandbox,
                executor: this.createProvisionCommandExecutor(
                  args.ctx,
                  args.sandbox.id,
                  'runtime_setup',
                  runtimeDiagnostics.diagnostics,
                ),
                workspacePath: this.config.workspacePath,
                runtimeId: args.runtimeId,
              });
              runtimeSetupDiagnostic.succeed();
            } catch (error) {
              if (isSandboxRuntimeCommandExecutionError(error)) {
                runtimeSetupDiagnostic.settle(
                  sandboxCommandExecutionDiagnosticFields(
                    error.classification,
                  ),
                );
              } else {
                runtimeSetupDiagnostic.fail(error, {
                  signal: args.ctx.cancellationSignal,
                  cause: 'unknown',
                  retryable: false,
                });
              }
              throw redactSandboxProvisioningStageFailure(
                'runtime_setup',
                error,
              );
            }
          },
        );
      } finally {
        runtimeDiagnostics.finish();
      }
    }
    throwIfBoxLiteProvisionCancelled(args.ctx.cancellationSignal);
    return preflight;
  }

  /**
   * Provider-side transport for the `archive` workspace source: the shared
   * materialization engine decides what to send and where, this only moves the
   * bytes through BoxLite's archive-upload contract. The stream is passed
   * straight through so a large mirror is never buffered in memory.
   */
  private createArchiveTransferPort(
    sandboxId: string,
  ): SandboxWorkspaceArchiveTransferPort {
    return {
      uploadArchive: async (request) => {
        const upload = this.client.uploadArchive;
        if (!upload) {
          throw new SandboxProviderConfigurationError(
            'BoxLite archive workspace injection requires archive upload support',
          );
        }
        // Delivered as ordered body-limit-safe parts and reassembled in-box
        // (chunk-archive-injection-with-progress D1): the daemon buffers each
        // upload wholesale under a ~2MB body limit, so one streamed PUT can
        // never carry a real repo mirror.
        await uploadBoxLiteArchiveInParts({
          client: {
            uploadArchive: (part) => upload.call(this.client, part),
            exec: (exec) => this.client.exec(exec),
          },
          sandboxId,
          path: request.path,
          archive: request.archive,
          partBytes: this.config.archivePartBytes,
          execTimeoutMs: this.config.timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.onBytesUploaded === undefined
            ? {}
            : { onBytesUploaded: request.onBytesUploaded }),
        });
      },
    };
  }

  private async materializeWorkspace(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandbox: BoxLiteSandbox,
    nativeDiagnostics: SandboxProvisioningDiagnosticObserver | undefined =
      ctx.diagnostics,
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
        (!ctx.beforeSandboxCleanup ||
          (!ctx.afterSandboxCleanup &&
            !ctx.settleSandboxCleanupAttempt))
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
        settleSandboxCleanupAttempt: ctx.settleSandboxCleanupAttempt,
        diagnostics: nativeDiagnostics,
      });
      let result: SandboxWorkspaceMaterializationResult;
      try {
        try {
          result = await runWithCredentialSafetySettlement({
            run: () =>
              hook({
                taskId: ctx.taskId,
                plan,
                workspaceDir: this.config.workspacePath,
                stageExecutor: adapter.stageExecutor,
                secretFilePort: adapter.secretFilePort,
                // add-repo-content-store D4: an `archive` source streams the
                // Repo's bare mirror through the archive-upload contract and
                // then clones locally inside the box — no network clone.
                ...(ctx.workspaceSource === undefined
                  ? {}
                  : { source: ctx.workspaceSource }),
                archiveTransfer: this.createArchiveTransferPort(sandbox.id),
                ...(ctx.diagnostics === undefined
                  ? {}
                  : { diagnostics: ctx.diagnostics }),
                ...(ctx.cancellationSignal === undefined
                  ? {}
                  : { cancellationSignal: ctx.cancellationSignal }),
                ...(ctx.onWorkspaceProgress === undefined
                  ? {}
                  : { onProgress: ctx.onWorkspaceProgress }),
                ...(ctx.beforeWorkspaceBoundary === undefined
                  ? {}
                  : { beforeBoundary: ctx.beforeWorkspaceBoundary }),
                ...(ctx.workspaceTransferDetachment === undefined
                  ? {}
                  : { detachment: ctx.workspaceTransferDetachment }),
              }),
            settleCredentialSafety: () => adapter.settleCredentialSafety(),
            primaryFailure: (candidate) =>
              candidate.status === 'succeeded'
                ? null
                : new SandboxWorkspaceMaterializationError(candidate),
            isCredentialSafetyConfirmed: () => adapter.wasSandboxFenced(),
            isCleanupCoordinationAcknowledged: () =>
              adapter.wasSandboxCleanupAcknowledged(),
            onSettlementFailure: () =>
              this.quarantineRun(ctx.taskId, sandbox.id),
          });
        } catch (error) {
          if (adapter.wasSandboxCleanupAttempted()) {
            throw new BoxLiteProvisioningCleanupAlreadyAttemptedError(error);
          }
          throw error;
        }
      } finally {
        if (
          adapter.wasSandboxFenced() &&
          adapter.wasSandboxCleanupAcknowledged()
        ) {
          this.confirmRunAbsent(ctx.taskId, sandbox.id);
        }
      }

      if (result.status !== 'succeeded') {
        const primary = new SandboxWorkspaceMaterializationError(result);
        if (adapter.wasSandboxCleanupAttempted()) {
          throw new BoxLiteProvisioningCleanupAlreadyAttemptedError(primary);
        }
        throw primary;
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
      executor: this.createProvisionCommandExecutor(
        ctx,
        sandbox.id,
        undefined,
        nativeDiagnostics,
      ),
      workspacePath: this.config.workspacePath,
      cloneSpec: requireGitCloneSpec(ctx.cloneSpec),
    });
  }

  private async materializeWorkspaceWithDiagnostic(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandbox: BoxLiteSandbox,
  ): Promise<void> {
    const hasCanonicalWorkspace =
      ctx.workspace !== undefined && ctx.workspace !== null;
    const hasLegacyClone =
      ctx.workspace === undefined && ctx.cloneSpec !== undefined;
    const hasWorkspaceWork = hasCanonicalWorkspace || hasLegacyClone;
    if (!hasWorkspaceWork) {
      await this.materializeWorkspace(ctx, sandbox);
      return;
    }
    const nativeDiagnostics = startBoxLiteNativeExecutionDiagnosticSession(
      ctx.diagnostics,
      'workspace',
    );
    try {
      await this.runProvisionBoundary(
        ctx,
        'workspace.materialize',
        async () => {
          // The canonical staged workspace engine already emits its six
          // primary/cleanup semantic stages. An extra primary wrapper would
          // misclassify a cleanup-only credential failure. The legacy clone
          // bridge has no shared stage observer, so it retains one outer pair.
          const diagnostic = hasLegacyClone
            ? startBoxLiteProvisioningDiagnostic(ctx.diagnostics, {
                key: 'workspace.materialize',
                scope: boxLiteDiagnosticScope(ctx),
                stage: 'workspace_transfer',
                operation: 'workspace_materialize',
                channel: 'primary',
              })
            : undefined;
          try {
            await this.materializeWorkspace(
              ctx,
              sandbox,
              nativeDiagnostics.diagnostics,
            );
            diagnostic?.succeed();
          } catch (error) {
            diagnostic?.fail(error, {
              signal: ctx.cancellationSignal,
              cause: 'unknown',
              retryable: false,
            });
            throw error;
          }
        },
      );
    } finally {
      nativeDiagnostics.finish();
    }
  }

  private async cleanupFailedSandbox(
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandboxId: string,
    knownSandbox?: BoxLiteSandbox,
  ): Promise<SandboxPhysicalCleanupResult> {
    let cleanupAuthorization: SandboxRunCleanupAuthorization | undefined;
    let cleanupOwnership = ctx.ownership;
    if (ctx.ownership) {
      if (
        !ctx.beforeSandboxCleanup ||
        (!ctx.afterSandboxCleanup && !ctx.settleSandboxCleanupAttempt)
      ) {
        throw new SandboxProviderConfigurationError(
          'BoxLite durable cleanup requires owner generation callbacks',
        );
      }
      cleanupAuthorization =
        (await ctx.beforeSandboxCleanup()) ?? undefined;
      if (!cleanupAuthorization) {
        throw new SandboxCleanupCoordinationPendingError();
      }
      cleanupOwnership = this.cleanupOwnershipFor(ctx.taskId, {
        ownership: ctx.ownership,
        cleanupAuthorization,
      });
      if (!cleanupOwnership) {
        throw new SandboxProviderConfigurationError(
          'BoxLite durable cleanup requires a generation authorization',
        );
      }
      const sandbox =
        knownSandbox ??
        (await this.client.getSandbox(sandboxId, {
          diagnostics: ctx.diagnostics,
          channel: 'cleanup',
          cancellationSignal: ctx.cancellationSignal,
        }));
      if (isUsableSandbox(sandbox)) {
        await this.assertResourceGeneration(sandbox, cleanupOwnership);
      }
    }
    const physical = await attemptDeleteBoxLiteSandboxAndConfirm({
      client: this.client,
      sandboxId,
      diagnostics: ctx.diagnostics,
    });
    if (physical.outcome !== 'succeeded') {
      this.quarantineRun(ctx.taskId, sandboxId);
    }
    if (cleanupAuthorization) {
      try {
        if (ctx.settleSandboxCleanupAttempt) {
          await ctx.settleSandboxCleanupAttempt(
            cleanupAuthorization,
            physical,
          );
        } else if (physical.outcome === 'succeeded') {
          await ctx.afterSandboxCleanup?.(cleanupAuthorization);
        } else {
          throw new SandboxCleanupCoordinationPendingError();
        }
      } catch (error) {
        this.quarantineRun(ctx.taskId, sandboxId);
        throw error;
      }
    }
    if (physical.outcome === 'succeeded') {
      this.confirmRunAbsent(ctx.taskId, sandboxId);
    }
    return physical;
  }

  private async rethrowAfterFailedSandboxCleanup(
    primary: unknown,
    ctx: SandboxProvisionContext<TCloneSpec>,
    sandboxId: string,
    knownSandbox?: BoxLiteSandbox,
  ): Promise<never> {
    if (primary instanceof BoxLiteProvisioningCleanupAlreadyAttemptedError) {
      throw primary.primary;
    }
    try {
      await this.cleanupFailedSandbox(ctx, sandboxId, knownSandbox);
    } catch {
      if (isSandboxCleanupCoordinationPendingError(primary)) throw primary;
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    if (
      isSandboxCleanupCoordinationPendingError(primary) &&
      !this.quarantinedRuns.has(ctx.taskId) &&
      primary.primary !== undefined
    ) {
      throw primary.primary;
    }
    throw primary;
  }

  private async runPreflight(
    taskId: string,
    sandbox: BoxLiteSandbox,
    runtimeId: string | null,
    environment?: SandboxResolvedEnvironmentMetadata | null,
    ctx?: SandboxProvisionContext<TCloneSpec>,
    diagnostics?: SandboxProvisioningDiagnosticObserver,
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
        ? this.createProvisionCommandExecutor(
            ctx,
            sandbox.id,
            'runtime_preflight',
            diagnostics,
          )
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
    allowQuarantined = false,
    readinessDiagnosticSession?: BoxLiteNativeExecutionDiagnosticSession,
  ): Promise<BoxLiteProvisionedRun | null> {
    const quarantinedSandboxId = this.quarantinedRuns.get(taskId);
    if (quarantinedSandboxId !== undefined && !allowQuarantined) return null;
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
            () => this.client.getSandbox(cached.sandbox.id, {
              diagnostics: ctx.diagnostics,
              cancellationSignal: ctx.cancellationSignal,
              diagnosticKey: 'sandbox.inspect.existing',
              diagnosticScope: boxLiteDiagnosticScope(ctx),
            }),
          )
        : await this.client.getSandbox(cached.sandbox.id);
      if (isUsableSandbox(refreshed)) {
        await this.assertResourceGeneration(
          refreshed,
          ownership,
          ctx,
          readinessDiagnosticSession,
        );
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
          () => this.client.getSandbox(sandboxId, {
            diagnostics: ctx.diagnostics,
            cancellationSignal: ctx.cancellationSignal,
            diagnosticKey: 'sandbox.inspect.existing',
            diagnosticScope: boxLiteDiagnosticScope(ctx),
          }),
        )
      : await this.client.getSandbox(sandboxId);
    if (!isUsableSandbox(sandbox)) {
      if (!stored || stored.sandbox.id === sandboxId) {
        this.runs.delete(taskId);
      }
      if (
        allowQuarantined &&
        quarantinedSandboxId === sandboxId
      ) {
        this.quarantinedRuns.delete(taskId);
      }
      return null;
    }
    await this.assertResourceGeneration(
      sandbox,
      ownership,
      ctx,
      readinessDiagnosticSession,
    );
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
    if (quarantinedSandboxId !== sandboxId) {
      this.runs.set(taskId, run);
    }
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

  private quarantineRun(taskId: string, providerSandboxId: string): void {
    this.forgetRun(taskId, providerSandboxId);
    this.quarantinedRuns.set(taskId, providerSandboxId);
  }

  private confirmRunAbsent(taskId: string, providerSandboxId: string): void {
    this.forgetRun(taskId, providerSandboxId);
    if (this.quarantinedRuns.get(taskId) === providerSandboxId) {
      this.quarantinedRuns.delete(taskId);
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
    readinessDiagnosticSession?: BoxLiteNativeExecutionDiagnosticSession,
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
    let probe;
    if (ctx) {
      const ownsDiagnosticSession = readinessDiagnosticSession === undefined;
      const diagnosticSession =
        readinessDiagnosticSession ??
        startBoxLiteNativeExecutionDiagnosticSession(
          ctx.diagnostics,
          'readiness',
        );
      try {
        probe = await this.runProvisionBoundary(
          ctx,
          'command.execute',
          () => this.client.exec({
            ...probeRequest,
            diagnostics: diagnosticSession.diagnostics,
            commandKind: 'runtime_preflight',
          }),
        );
      } finally {
        if (ownsDiagnosticSession) {
          diagnosticSession.finish();
        }
      }
    } else {
      probe = await this.client.exec(probeRequest);
    }
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

/**
 * Credential safety is always settled before the provider returns. A hook
 * rejection or a stable failed result is already the primary operation fact,
 * so a later settlement rejection must not replace it. An unconfirmed fence or
 * rejected durable cleanup acknowledgement quarantines the run. Physical
 * failure remains secondary and preserves the primary so router recovery can
 * allocate a later attempt; only ownership/store acknowledgement failure uses
 * the provider-neutral coordination signal. Without a primary, settlement
 * remains fail-closed.
 */
async function runWithCredentialSafetySettlement<TResult>(options: {
  readonly run: () => Promise<TResult>;
  readonly settleCredentialSafety: () => Promise<void>;
  readonly primaryFailure: (result: TResult) => unknown | null;
  /** True only after credential-bearing sandbox state is confirmed absent. */
  readonly isCredentialSafetyConfirmed: () => boolean;
  /** False while physical cleanup still lacks durable ownership acknowledgement. */
  readonly isCleanupCoordinationAcknowledged: () => boolean;
  /** Quarantine the run immediately so it cannot be retained or readopted. */
  readonly onSettlementFailure: () => void;
}): Promise<TResult> {
  let operation:
    | { readonly kind: 'succeeded'; readonly result: TResult }
    | { readonly kind: 'failed'; readonly error: unknown };
  try {
    operation = { kind: 'succeeded', result: await options.run() };
  } catch (error) {
    operation = { kind: 'failed', error };
  }

  let settlementFailure:
    | { readonly kind: 'failed'; readonly error: unknown }
    | undefined;
  try {
    await options.settleCredentialSafety();
  } catch (error) {
    settlementFailure = { kind: 'failed', error };
  }

  const cleanupCoordinationAcknowledged =
    options.isCleanupCoordinationAcknowledged();
  if (settlementFailure !== undefined || !cleanupCoordinationAcknowledged) {
    options.onSettlementFailure();
  }

  if (!cleanupCoordinationAcknowledged) {
    // A fence can run inside the workspace hook. In that branch its rejected
    // acknowledgement becomes the hook rejection itself, so never retain that
    // raw coordination error as the operation's primary diagnostic value.
    const primaryFailure =
      operation.kind === 'succeeded'
        ? options.primaryFailure(operation.result)
        : settlementFailure === undefined
          ? null
          : operation.error;
    throw new SandboxCleanupCoordinationPendingError(
      primaryFailure ??
        new SandboxProviderConfigurationError(
          'BoxLite credential safety settlement could not be confirmed',
        ),
    );
  }

  if (settlementFailure === undefined) {
    if (operation.kind === 'failed') throw operation.error;
    return operation.result;
  }

  const primaryFailure =
    operation.kind === 'failed'
      ? operation.error
      : options.primaryFailure(operation.result);
  if (!options.isCredentialSafetyConfirmed()) {
    if (primaryFailure !== null) throw primaryFailure;
    throw settlementFailure.error;
  }
  if (operation.kind === 'failed') throw operation.error;
  if (primaryFailure === null) throw settlementFailure.error;
  return operation.result;
}

/**
 * Provider-private control marker: workspace fencing already consumed the
 * provider-internal cleanup attempt, so the outer provision catch must let the
 * router allocate the later fallback rather than invoke cleanup twice.
 */
class BoxLiteProvisioningCleanupAlreadyAttemptedError extends Error {
  readonly primary: unknown;

  constructor(primary: unknown) {
    super('BoxLite provisioning cleanup was already attempted');
    this.name = 'BoxLiteProvisioningCleanupAlreadyAttemptedError';
    Object.defineProperty(this, 'primary', {
      value: primary,
      enumerable: false,
      configurable: false,
      writable: false,
    });
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
    // The provider's declared set, not the raw configured one: candidate
    // selection must see the derived workspace-source variants too.
    capabilities: provider.getProviderCapabilities(),
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

/**
 * Declared capabilities = the deployment's configured set PLUS the
 * workspace-source variants this build can actually perform
 * (add-repo-content-store D4/D5).
 *
 * The variants are derived rather than configured on purpose: BoxLite's create
 * API exposes no volume-mount field (verified against its create schema), so
 * `archive` is the only injection variant, and it is available exactly when the
 * client can upload an archive and the staged workspace hook is wired. Deriving
 * them keeps existing `BOXLITE_CAPABILITIES` deployments working instead of
 * failing closed on an env var that predates this contract.
 */
function resolveBoxLiteDeclaredCapabilities(args: {
  readonly configured: readonly SandboxProviderCapability[];
  readonly client: BoxLiteClient;
  readonly hasWorkspaceMaterialization: boolean;
}): readonly SandboxProviderCapability[] {
  const declared = new Set<SandboxProviderCapability>(args.configured);
  if (
    args.hasWorkspaceMaterialization &&
    declared.has('workspace.git.materialize')
  ) {
    // The gated legacy in-sandbox network clone stays available for rollback.
    declared.add('workspace.source.git');
    if (args.client.uploadArchive) declared.add('workspace.source.archive');
  }
  return Object.freeze([...declared]);
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

function boxLiteDiagnosticScope<TCloneSpec>(
  ctx: SandboxProvisionContext<TCloneSpec>,
): string {
  return ctx.ownership?.resourceGeneration ?? 'legacy';
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
