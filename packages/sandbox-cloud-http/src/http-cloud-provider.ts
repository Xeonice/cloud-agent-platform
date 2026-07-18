import type {
  GitCloneSpec,
  SandboxConnection,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
  SandboxExecutionMode,
  SandboxProviderCapability,
  SandboxProviderPort,
  SandboxProvisionContext,
  SandboxReadoptionPort,
  SandboxReadoptionTarget,
  SandboxOwnershipFence,
  SandboxPhysicalCleanupResult,
  SandboxProvisioningDiagnosticChannel,
  SandboxProvisioningDiagnosticCommandKind,
  SandboxProvisioningDiagnosticFact,
  SandboxProvisioningDiagnosticHttpStatusClass,
  SandboxProvisioningDiagnosticObserver,
  SandboxProvisioningDiagnosticOperation,
  SandboxProvisioningDiagnosticStage,
  SandboxProvisioningDiagnosticTerminalFact,
  SandboxRunCleanupAuthorization,
  SandboxSelectedRunPort,
  SandboxTeardownDisposition,
  SandboxTeardownResult,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import {
  assertSandboxProviderSupportsResources,
  createNonPersistingSandboxProvisioningDiagnosticObserver,
  defineCloudSandboxProvider,
  isSandboxCleanupCoordinationPendingError,
  isSandboxLegacyDeliverWorkspaceArgs,
  normalizeSandboxPhysicalCleanupResult,
  resourcesForSandboxProvision,
  runSandboxExternalBoundary,
  SandboxCleanupCoordinationPendingError,
  SandboxCleanupPendingError,
  SandboxProviderConfigurationError,
  snapshotSandboxProvisionContext,
  type SelectedSandboxRun,
  type SandboxProviderDescriptor,
} from '@cap/sandbox-core';

/**
 * Capabilities backed by the current cloud HTTP adapter without transferring
 * repository credentials across the control-plane request boundary.
 *
 * Workspace materialization/delivery stay deliberately absent until this
 * provider owns a canonical, bounded secret writer and its cleanup lifecycle.
 */
export const HTTP_CLOUD_SANDBOX_PROVIDER_CAPABILITIES = Object.freeze([
  'terminal.websocket',
  'transcript.retained-read',
  'lifecycle.readopt',
] as const satisfies readonly SandboxProviderCapability[]);

export interface HttpCloudSandboxFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type HttpCloudSandboxFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<HttpCloudSandboxFetchResponse>;

export interface HttpCloudSandboxProviderOptions {
  readonly id?: string;
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly mode?: SandboxExecutionMode;
  readonly capabilities?: readonly SandboxProviderCapability[];
  readonly timeoutMs?: number;
  readonly cleanupPollAttempts?: number;
  readonly cleanupPollIntervalMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly fetch?: HttpCloudSandboxFetch;
}

export interface HttpCloudSandboxProviderDescriptorOptions
  extends HttpCloudSandboxProviderOptions {
  readonly priority?: number;
}

export interface HttpCloudSandboxTeardownOptions {
  readonly ownership?: SandboxOwnershipFence;
  readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
  readonly providerSandboxId?: string;
  readonly disposition?: SandboxTeardownDisposition;
  /** Optional task-attempt observer; absent callers remain explicitly taskless. */
  readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
}

export class HttpCloudSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> implements
    SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource>,
    SandboxReadoptionPort,
    SandboxSelectedRunPort
{
  private readonly id: string;
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly mode: SandboxExecutionMode;
  private readonly capabilities: readonly SandboxProviderCapability[];
  private readonly timeoutMs: number;
  private readonly cleanupPollAttempts: number;
  private readonly cleanupPollIntervalMs: number;
  private readonly delayImpl: (ms: number) => Promise<void>;
  private readonly fetchImpl: HttpCloudSandboxFetch;
  private readonly runs = new Map<
    string,
    {
      readonly connection: SandboxConnection;
      readonly providerSandboxId?: string;
      readonly ownership?: SandboxOwnershipFence;
      readonly terminal?: SandboxTerminalEndpointDescriptor;
      readonly diagnostics?: SandboxProvisioningDiagnosticObserver;
    }
  >();
  private readonly replayOperationIds = new WeakMap<
    SandboxProvisioningDiagnosticObserver,
    Map<string, string>
  >();

  constructor(options: HttpCloudSandboxProviderOptions) {
    this.id = options.id ?? 'cloud-http';
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.mode = options.mode ?? 'workspace-write';
    this.capabilities = normalizeHttpCloudCapabilities(options.capabilities);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cleanupPollAttempts = normalizePositiveInteger(
      options.cleanupPollAttempts ?? 3,
      'cleanupPollAttempts',
    );
    this.cleanupPollIntervalMs = normalizeNonNegativeInteger(
      options.cleanupPollIntervalMs ?? 100,
      'cleanupPollIntervalMs',
    );
    this.delayImpl =
      options.delay ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init) as Promise<HttpCloudSandboxFetchResponse>);
  }

  getSandboxMode(): SandboxExecutionMode {
    return this.mode;
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    return this.capabilities;
  }

  async provision(ctx: SandboxProvisionContext<TCloneSpec>): Promise<SandboxConnection> {
    ctx = snapshotSandboxProvisionContext(ctx);
    ctx.diagnostics?.bindProviderFamily('cloud-http');
    if (ctx.workspace?.credential !== undefined) {
      throw new SandboxProviderConfigurationError(
        'HTTP cloud workspace credentials require a provider-local secret writer',
      );
    }
    assertSandboxProviderSupportsResources(
      this.getProviderCapabilities(),
      resourcesForSandboxProvision(ctx),
    );
    const body: Record<string, unknown> = {
      taskId: ctx.taskId,
      modelIntent: ctx.modelIntent,
      runtimeId: ctx.runtimeId,
      executionMode: ctx.executionMode,
    };
    if ('cloneSpec' in ctx) {
      body.cloneSpec = ctx.cloneSpec;
    }
    if ('environment' in ctx) {
      body.environment = ctx.environment;
    }
    if ('resources' in ctx) {
      body.resources = ctx.resources;
    }
    if ('workspace' in ctx) {
      body.workspace = ctx.workspace;
    }
    const resourceGeneration = ctx.ownership?.resourceGeneration;
    if (resourceGeneration) {
      // The lease owner generation remains API-internal. Only the stable,
      // non-secret physical incarnation is shared with the remote provider.
      body.resourceGeneration = resourceGeneration;
    }
    const createDiagnostic = await this.startDiagnostic(
      ctx.diagnostics,
      {
        stage: 'sandbox_creation',
        operation: 'sandbox_create',
        channel: 'primary',
      },
      `create:${ctx.taskId}`,
    );
    let createSettled = false;
    let createFailure:
      | { readonly kind: 'http'; readonly status: number }
      | { readonly kind: 'transport' | 'protocol' }
      | undefined;
    let createObservationCoordinationFailed = false;
    let createObservationPrimary: unknown;
    let createDefinitivelyNotCreated = false;
    let observedProviderSandboxId: string | undefined;
    try {
      const created = await runSandboxExternalBoundary({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        guard: ctx.externalBoundaryGuard,
        signal: ctx.cancellationSignal,
        run: async () => {
          let res: HttpCloudSandboxFetchResponse;
          try {
            res = await this.request('/v1/sandboxes', {
              method: 'POST',
              body,
              signal: ctx.cancellationSignal,
              headers: {
                // A replay with a transferred owner generation retains the same
                // physical resource generation and therefore the same remote key.
                'idempotency-key': resourceGeneration
                  ? `cap-task:${ctx.taskId}:resource:${resourceGeneration}`
                  : `cap-task:${ctx.taskId}`,
              },
            });
          } catch (error) {
            createFailure = { kind: 'transport' };
            throw error;
          }
          if (!res.ok) {
            createFailure = { kind: 'http', status: res.status };
            const providerFailure = new Error(
              `cloud sandbox request POST /v1/sandboxes failed: HTTP ${res.status}`,
            );
            if (isDefinitiveCloudCreateWithoutResource(res.status)) {
              createDefinitivelyNotCreated = true;
              try {
                await ctx.onSandboxCreateObserved?.({ kind: 'not-created' });
              } catch (error) {
                createObservationCoordinationFailed = true;
                createObservationPrimary = providerFailure;
                throw error;
              }
            }
            throw providerFailure;
          }
          const raw = await res.json().catch(() => undefined);
          let connection: SandboxConnection;
          let providerSandboxId: string | undefined;
          let terminal: SandboxTerminalEndpointDescriptor | undefined;
          try {
            assertCloudResourceGeneration(raw, resourceGeneration);
            connection = parseConnection(raw, ctx.taskId);
            providerSandboxId = attestedCloudProviderSandboxId(raw);
            terminal = parseOptionalTerminalDescriptor(raw);
          } catch (error) {
            createFailure = { kind: 'protocol' };
            throw error;
          }
          observedProviderSandboxId = providerSandboxId;
          await this.settleDiagnostic(createDiagnostic, {
            outcome: 'succeeded',
            cause: null,
            retryable: false,
            httpStatusClass: httpStatusClass(res.status),
          });
          createSettled = true;
          try {
            await ctx.onSandboxCreateObserved?.({
              kind: 'created',
              ...(providerSandboxId === undefined
                ? {}
                : { providerSandboxId }),
            });
          } catch (error) {
            createObservationCoordinationFailed = true;
            createObservationPrimary = error;
            throw error;
          }
          return { connection, providerSandboxId, terminal };
        },
      });
      this.runs.set(ctx.taskId, {
        connection: created.connection,
        ...(created.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: created.providerSandboxId }),
        ...(created.terminal === undefined ? {} : { terminal: created.terminal }),
        ownership: ctx.ownership,
        ...(ctx.diagnostics === undefined
          ? {}
          : { diagnostics: ctx.diagnostics }),
      });
      return created.connection;
    } catch (error) {
      if (!createSettled) {
        await this.settleDiagnostic(
          createDiagnostic,
          classifyCloudCreateFailure(
            error,
            createFailure,
            ctx.cancellationSignal,
            this.timeoutMs,
          ),
        );
      }
      const primary = createObservationPrimary ?? error;
      if (!createDefinitivelyNotCreated) {
        try {
          await this.cleanupFailedProvision(
            ctx,
            observedProviderSandboxId,
            primary,
          );
        } catch (cleanupError) {
          if (isSandboxCleanupCoordinationPendingError(cleanupError)) {
            throw cleanupError;
          }
          throw new SandboxCleanupCoordinationPendingError(primary);
        }
      }
      if (createObservationCoordinationFailed) {
        throw new SandboxCleanupCoordinationPendingError(primary);
      }
      throw primary;
    }
  }

  async teardownSandbox(
    taskId: string,
    options: HttpCloudSandboxTeardownOptions = {},
  ): Promise<SandboxPhysicalCleanupResult> {
    if (options.cleanupAuthorization) {
      assertCloudCleanupAuthorization(
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
          : options.ownership;
    const providerSandboxId =
      options.providerSandboxId ?? this.runs.get(taskId)?.providerSandboxId;
    // Legacy cloud adapters historically treated teardown as removal. The
    // router now always supplies the business disposition explicitly.
    const disposition = options.disposition ?? 'superseded-remove';
    const result = await this.runPhysicalCleanup(
      taskId,
      ownership,
      providerSandboxId,
      disposition,
      options.diagnostics ?? this.runs.get(taskId)?.diagnostics,
    );
    if (result.outcome === 'succeeded' && disposition === 'superseded-remove') {
      this.runs.delete(taskId);
    }
    return result;
  }

  private async runPhysicalCleanup(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
    disposition: SandboxTeardownDisposition = 'superseded-remove',
    diagnostics?: SandboxProvisioningDiagnosticObserver,
  ): Promise<SandboxPhysicalCleanupResult> {
    try {
      return normalizeSandboxPhysicalCleanupResult(
        await this.deleteSandbox(
          taskId,
          ownership,
          providerSandboxId,
          disposition,
          diagnostics,
        ),
      );
    } catch (error) {
      if (isSandboxCleanupCoordinationPendingError(error)) throw error;
      if (error instanceof CloudPhysicalCleanupError) return error.result;
      return cloudCleanupIndeterminate();
    }
  }

  private async deleteSandbox(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
    disposition: SandboxTeardownDisposition = 'superseded-remove',
    diagnostics?: SandboxProvisioningDiagnosticObserver,
  ): Promise<SandboxTeardownResult> {
    const deletion = await this.startDiagnostic(diagnostics, {
      stage: 'cleanup',
      operation: 'sandbox_delete',
      channel: 'cleanup',
      commandKind: 'sandbox_cleanup',
    });
    let res: HttpCloudSandboxFetchResponse;
    try {
      res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        body: {
          disposition,
          ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
          ...(ownership === undefined
            ? {}
            : { resourceGeneration: ownership.resourceGeneration }),
        },
        ...(ownership
          ? {
              headers: {
                // The remote control plane must compare this generation before
                // deleting. A stale worker receives 409/412 and cannot remove a
                // later incarnation that reused the deterministic task id.
                'if-match': quoteEntityTag(ownership.resourceGeneration),
              },
            }
          : {}),
      });
    } catch (error) {
      const terminal = classifyCloudCleanupTransportFailure(
        error,
        this.timeoutMs,
      );
      await this.settleDiagnostic(deletion, terminal.fact);
      throw new CloudPhysicalCleanupError(terminal.result);
    }
    if (res.status === 409 || res.status === 412) {
      await this.settleDiagnostic(deletion, {
        outcome: 'failed',
        cause: 'coordination_failed',
        retryable: true,
        httpStatusClass: httpStatusClass(res.status),
      });
      throw new SandboxCleanupCoordinationPendingError();
    }
    if (res.status === 404) {
      await this.settleDiagnostic(deletion, {
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        httpStatusClass: '4xx',
      });
      return { kind: 'already-absent' };
    }
    if (!res.ok) {
      const terminal = classifyCloudCleanupHttpFailure(
        res.status,
        this.timeoutMs,
      );
      await this.settleDiagnostic(deletion, terminal.fact);
      throw new CloudPhysicalCleanupError(terminal.result);
    }
    await this.settleDiagnostic(deletion, {
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      httpStatusClass: httpStatusClass(res.status),
    });
    // Every DELETE 2xx/202/204 is only an acknowledgement. Success requires a
    // separate bounded GET that proves absence or the requested retained state.
    return this.confirmAcceptedTeardown(
      taskId,
      ownership,
      providerSandboxId,
      disposition,
      diagnostics,
    );
  }

  private async confirmAcceptedTeardown(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
    disposition: SandboxTeardownDisposition = 'superseded-remove',
    diagnostics?: SandboxProvisioningDiagnosticObserver,
  ): Promise<SandboxTeardownResult> {
    const confirmation = await this.startDiagnostic(diagnostics, {
      stage: 'cleanup',
      operation: 'sandbox_absence_confirm',
      channel: 'cleanup',
      commandKind: 'sandbox_cleanup',
    });
    for (let attempt = 0; attempt < this.cleanupPollAttempts; attempt += 1) {
      let res: HttpCloudSandboxFetchResponse;
      try {
        res = await this.request(
          `/v1/sandboxes/${encodeURIComponent(taskId)}`,
          {
            method: 'GET',
            ...(ownership
              ? {
                  headers: {
                    'if-match': quoteEntityTag(ownership.resourceGeneration),
                  },
                }
              : {}),
          },
        );
      } catch (error) {
        const terminal = classifyCloudCleanupTransportFailure(
          error,
          this.timeoutMs,
        );
        await this.settleDiagnostic(confirmation, terminal.fact);
        throw new CloudPhysicalCleanupError(terminal.result);
      }
      if (res.status === 404) {
        if (disposition === 'superseded-remove') {
          await this.settleDiagnostic(confirmation, {
            outcome: 'succeeded',
            cause: null,
            retryable: false,
            httpStatusClass: '4xx',
          });
          return { kind: 'found-and-cleaned' };
        }
        await this.settleDiagnostic(confirmation, {
          outcome: 'failed',
          cause: 'cleanup_failed',
          retryable: false,
          httpStatusClass: '4xx',
        });
        throw new CloudPhysicalCleanupError(cloudCleanupFailed(false));
      }
      if (res.status === 409 || res.status === 412) {
        await this.settleDiagnostic(confirmation, {
          outcome: 'failed',
          cause: 'coordination_failed',
          retryable: true,
          httpStatusClass: httpStatusClass(res.status),
        });
        throw new SandboxCleanupCoordinationPendingError();
      }
      if (!res.ok) {
        const terminal = classifyCloudCleanupHttpFailure(
          res.status,
          this.timeoutMs,
        );
        await this.settleDiagnostic(confirmation, terminal.fact);
        throw new CloudPhysicalCleanupError(terminal.result);
      }
      const raw = await res.json().catch(() => undefined);
      try {
        assertCloudCleanupTarget(raw, ownership, providerSandboxId);
      } catch {
        await this.settleDiagnostic(confirmation, {
          outcome: 'failed',
          cause: 'coordination_failed',
          retryable: true,
          httpStatusClass: httpStatusClass(res.status),
        });
        throw new SandboxCleanupCoordinationPendingError();
      }
      if (isCloudTeardownTerminal(raw, disposition)) {
        await this.settleDiagnostic(confirmation, {
          outcome: 'succeeded',
          cause: null,
          retryable: false,
          httpStatusClass: httpStatusClass(res.status),
        });
        return { kind: 'found-and-cleaned' };
      }
      if (attempt + 1 < this.cleanupPollAttempts) {
        await this.delayImpl(this.cleanupPollIntervalMs);
      }
    }
    await this.settleDiagnostic(confirmation, {
      outcome: 'indeterminate',
      cause: 'cleanup_unconfirmed',
      retryable: true,
    });
    throw new SandboxCleanupPendingError();
  }

  private async cleanupFailedProvision(
    ctx: SandboxProvisionContext<TCloneSpec>,
    observedProviderSandboxId?: string,
    primary?: unknown,
  ): Promise<void> {
    let authorization: SandboxRunCleanupAuthorization | null | undefined;
    try {
      authorization = await ctx.beforeSandboxCleanup?.();
    } catch {
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    if (!authorization) {
      if (ctx.ownership !== undefined) {
        throw new SandboxCleanupCoordinationPendingError(primary);
      }
      return;
    }
    try {
      assertCloudCleanupAuthorization(
        authorization,
        ctx.taskId,
        this.id,
      );
      if (
        ctx.ownership &&
        (authorization.kind !== 'generation' ||
          authorization.ownership.resourceGeneration !==
            ctx.ownership.resourceGeneration)
      ) {
        throw new SandboxProviderConfigurationError(
          'Cloud cleanup authorization changed physical resource generation',
        );
      }
    } catch {
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    let result: SandboxPhysicalCleanupResult;
    try {
      result = await this.runPhysicalCleanup(
        ctx.taskId,
        authorization.kind === 'generation'
          ? authorization.ownership
          : undefined,
        observedProviderSandboxId ?? this.runs.get(ctx.taskId)?.providerSandboxId,
        'superseded-remove',
        ctx.diagnostics,
      );
    } catch {
      throw new SandboxCleanupCoordinationPendingError(primary);
    }
    if (result.outcome === 'succeeded') {
      try {
        await ctx.afterSandboxCleanup?.(authorization);
      } catch {
        throw new SandboxCleanupCoordinationPendingError(primary);
      }
    }
  }

  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: TRuntimeId | null,
  ): Promise<TTranscriptSource | null> {
    const query =
      runtimeId === null || runtimeId === undefined
        ? ''
        : `?runtimeId=${encodeURIComponent(String(runtimeId))}`;
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(taskId)}/transcript${query}`,
      { method: 'GET' },
    );
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) return null;
    const raw = await res.json().catch(() => undefined);
    return parseOptionalTranscriptSource<TTranscriptSource>(raw);
  }

  async sandboxExists(
    taskId: string,
    diagnostics: SandboxProvisioningDiagnosticObserver =
      createNonPersistingSandboxProvisioningDiagnosticObserver(),
  ): Promise<boolean> {
    const inspection = await this.startDiagnostic(diagnostics, {
      stage: 'sandbox_inspect',
      operation: 'sandbox_inspect',
      channel: 'primary',
    });
    let res: HttpCloudSandboxFetchResponse;
    try {
      res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}`, {
        method: 'GET',
      });
    } catch (error) {
      await this.settleDiagnostic(
        inspection,
        classifyCloudInspectTransportFailure(error, this.timeoutMs),
      );
      throw error;
    }
    if (res.status === 404) {
      await this.settleDiagnostic(inspection, {
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        httpStatusClass: '4xx',
      });
      return false;
    }
    if (!res.ok) {
      await this.settleDiagnostic(inspection, {
        outcome: res.status === 408 ? 'timed_out' : 'indeterminate',
        cause:
          res.status === 408 ? 'settlement_unknown' : 'provider_unavailable',
        retryable: true,
        httpStatusClass: httpStatusClass(res.status),
        ...(res.status === 408 ? { timeoutMs: this.timeoutMs } : {}),
      });
      throw new Error(
        `cloud sandbox existence check for task ${taskId} is indeterminate: HTTP ${res.status}`,
      );
    }
    await this.settleDiagnostic(inspection, {
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      httpStatusClass: httpStatusClass(res.status),
    });
    return true;
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
    if (!isSandboxLegacyDeliverWorkspaceArgs(args)) {
      return {
        hadChanges: false,
        commitSha: null,
        error: 'Credentialed delivery requires a provider-local secret writer',
      };
    }
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}/deliver`, {
      method: 'POST',
      body: args,
    });
    if (!res.ok) {
      return {
        hadChanges: false,
        commitSha: null,
        error: `cloud delivery HTTP ${res.status}`,
      };
    }
    return parseDeliverResult(await res.json().catch(() => undefined));
  }

  async listReadoptable(): Promise<string[]> {
    const path = '/v1/sandboxes/readoptable';
    const res = await this.request(path, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`cloud sandbox request GET ${path} failed: HTTP ${res.status}`);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new Error(
        'cloud sandbox readoption inventory is indeterminate: response was not valid JSON',
      );
    }
    return parseCloudReadoptableTaskIds(raw);
  }

  async reattach(
    taskId: string,
    target?: SandboxReadoptionTarget,
  ): Promise<SandboxConnection | null> {
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(taskId)}/reattach`,
      {
        method: 'POST',
        ...(target
          ? {
              body: {
                ...(target.providerSandboxId === undefined
                  ? {}
                  : { providerSandboxId: target.providerSandboxId }),
                ...(target.ownership === undefined
                  ? {}
                  : {
                      resourceGeneration:
                        target.ownership.resourceGeneration,
                    }),
              },
              ...(target.ownership
                ? {
                    headers: {
                      'if-match': quoteEntityTag(
                        target.ownership.resourceGeneration,
                      ),
                    },
                  }
                : {}),
            }
          : {}),
      },
    );
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      throw new Error(
        `cloud sandbox reattach for task ${taskId} is indeterminate: HTTP ${res.status}`,
      );
    }
    const raw = await res.json().catch(() => undefined);
    assertCloudReadoptionTarget(raw, target);
    const connection = parseConnection(raw, taskId);
    const providerSandboxId = attestedCloudProviderSandboxId(raw);
    const terminal = parseOptionalTerminalDescriptor(raw);
    this.runs.set(taskId, {
      connection,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      ...(terminal === undefined ? {} : { terminal }),
      ownership: target?.ownership,
    });
    return connection;
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun | null> {
    const run = this.runs.get(taskId);
    if (!run) return null;
    return {
      taskId,
      providerId: this.id,
      ...(run.providerSandboxId === undefined
        ? {}
        : { providerSandboxId: run.providerSandboxId }),
      provider: this,
      capabilities: this.getProviderCapabilities(),
      connection: run.connection,
      terminal: run.terminal,
    };
  }

  private async startDiagnostic(
    diagnostics: SandboxProvisioningDiagnosticObserver | undefined,
    descriptor: CloudDiagnosticDescriptor,
    replayKey?: string,
  ): Promise<CloudDiagnosticOperation | undefined> {
    if (diagnostics === undefined) return undefined;
    try {
      let operationId: string;
      if (replayKey === undefined) {
        operationId = diagnostics.createOperationId();
      } else {
        let operations = this.replayOperationIds.get(diagnostics);
        if (operations === undefined) {
          operations = new Map();
          this.replayOperationIds.set(diagnostics, operations);
        }
        operationId =
          operations.get(replayKey) ?? diagnostics.createOperationId();
        operations.set(replayKey, operationId);
      }
      const operation = { diagnostics, operationId, ...descriptor } as const;
      await emitCloudDiagnostic(operation, { outcome: 'started' });
      return operation;
    } catch {
      return undefined;
    }
  }

  private async settleDiagnostic(
    operation: CloudDiagnosticOperation | undefined,
    terminal: CloudDiagnosticTerminal,
  ): Promise<void> {
    if (operation === undefined) return;
    await emitCloudDiagnostic(operation, terminal);
  }

  private request(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<HttpCloudSandboxFetchResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (this.apiToken) {
      headers.authorization = `Bearer ${this.apiToken}`;
    }
    Object.assign(headers, init.headers);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body,
      signal:
        init.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([init.signal, timeoutSignal]),
    });
  }
}

interface CloudDiagnosticDescriptor {
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind;
}

interface CloudDiagnosticOperation extends CloudDiagnosticDescriptor {
  readonly diagnostics: SandboxProvisioningDiagnosticObserver;
  readonly operationId: string;
}

type CloudDiagnosticTerminal = Omit<
  SandboxProvisioningDiagnosticTerminalFact,
  'operationId' | 'stage' | 'operation' | 'channel' | 'commandKind'
>;

type CloudCreateFailureHint =
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'transport' | 'protocol' }
  | undefined;

class CloudPhysicalCleanupError extends Error {
  constructor(readonly result: SandboxPhysicalCleanupResult) {
    super('Cloud sandbox physical cleanup did not settle successfully');
    this.name = 'CloudPhysicalCleanupError';
  }
}

function emitCloudDiagnostic(
  operation: CloudDiagnosticOperation,
  fact: { readonly outcome: 'started' } | CloudDiagnosticTerminal,
): void {
  try {
    void operation.diagnostics
      .emit({
        operationId: operation.operationId,
        stage: operation.stage,
        operation: operation.operation,
        channel: operation.channel,
        ...(operation.commandKind === undefined
          ? {}
          : { commandKind: operation.commandKind }),
        ...fact,
      } as SandboxProvisioningDiagnosticFact)
      .catch(() => undefined);
  } catch {
    // Diagnostic persistence is evidence only; provider control stays authoritative.
  }
}

function classifyCloudCreateFailure(
  error: unknown,
  hint: CloudCreateFailureHint,
  cancellationSignal: AbortSignal | undefined,
  timeoutMs: number,
): CloudDiagnosticTerminal {
  if (cancellationSignal?.aborted) {
    return { outcome: 'cancelled', cause: 'cancelled', retryable: false };
  }
  if (isTimeoutLike(error) || (hint?.kind === 'http' && hint.status === 408)) {
    return {
      outcome: 'timed_out',
      cause: 'settlement_unknown',
      retryable: true,
      timeoutMs,
      ...(hint?.kind === 'http'
        ? { httpStatusClass: httpStatusClass(hint.status) }
        : {}),
    };
  }
  if (hint?.kind === 'transport') {
    return {
      outcome: 'indeterminate',
      cause: 'transport_failed',
      retryable: true,
    };
  }
  if (hint?.kind === 'protocol') {
    return { outcome: 'failed', cause: 'protocol_failed', retryable: false };
  }
  if (hint?.kind === 'http') {
    if (hint.status >= 500) {
      return {
        outcome: 'indeterminate',
        cause: 'provider_unavailable',
        retryable: true,
        httpStatusClass: httpStatusClass(hint.status),
      };
    }
    const accessDenied = hint.status === 401 || hint.status === 403;
    return {
      outcome: 'failed',
      cause: accessDenied ? 'access_denied' : 'protocol_failed',
      retryable: hint.status === 429,
      httpStatusClass: httpStatusClass(hint.status),
    };
  }
  return { outcome: 'failed', cause: 'unknown', retryable: false };
}

function classifyCloudCleanupHttpFailure(
  status: number,
  timeoutMs: number,
): Readonly<{
  fact: CloudDiagnosticTerminal;
  result: SandboxPhysicalCleanupResult;
}> {
  if (status === 408) {
    return {
      fact: {
        outcome: 'timed_out',
        cause: 'cleanup_unconfirmed',
        retryable: true,
        timeoutMs,
        httpStatusClass: httpStatusClass(status),
      },
      result: cloudCleanupIndeterminate(),
    };
  }
  if (status >= 500) {
    return {
      fact: {
        outcome: 'indeterminate',
        cause: 'cleanup_unconfirmed',
        retryable: true,
        httpStatusClass: httpStatusClass(status),
      },
      result: cloudCleanupIndeterminate(),
    };
  }
  const retryable = status === 429;
  return {
    fact: {
      outcome: 'failed',
      cause: 'cleanup_failed',
      retryable,
      httpStatusClass: httpStatusClass(status),
    },
    result: cloudCleanupFailed(retryable),
  };
}

function classifyCloudCleanupTransportFailure(
  error: unknown,
  timeoutMs: number,
): Readonly<{
  fact: CloudDiagnosticTerminal;
  result: SandboxPhysicalCleanupResult;
}> {
  return {
    fact: isTimeoutLike(error)
      ? {
          outcome: 'timed_out',
          cause: 'cleanup_unconfirmed',
          retryable: true,
          timeoutMs,
        }
      : {
          outcome: 'indeterminate',
          cause: 'cleanup_unconfirmed',
          retryable: true,
        },
    result: cloudCleanupIndeterminate(),
  };
}

function classifyCloudInspectTransportFailure(
  error: unknown,
  timeoutMs: number,
): CloudDiagnosticTerminal {
  return isTimeoutLike(error)
    ? {
        outcome: 'timed_out',
        cause: 'settlement_unknown',
        retryable: true,
        timeoutMs,
      }
    : {
        outcome: 'indeterminate',
        cause: 'transport_failed',
        retryable: true,
      };
}

function cloudCleanupFailed(retryable: boolean): SandboxPhysicalCleanupResult {
  return Object.freeze({
    outcome: 'failed',
    proof: null,
    cause: 'cleanup_failed',
    retryable,
  });
}

function cloudCleanupIndeterminate(): SandboxPhysicalCleanupResult {
  return Object.freeze({
    outcome: 'indeterminate',
    proof: null,
    cause: 'cleanup_unconfirmed',
    retryable: true,
  });
}

function isTimeoutLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { readonly name?: unknown }).name === 'TimeoutError' ||
      (error as { readonly code?: unknown }).code === 'ETIMEDOUT')
  );
}

function httpStatusClass(
  status: number,
): SandboxProvisioningDiagnosticHttpStatusClass | null {
  if (status >= 100 && status < 200) return '1xx';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return null;
}

export function defineHttpCloudSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: HttpCloudSandboxProviderDescriptorOptions,
): SandboxProviderDescriptor<
  HttpCloudSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
> {
  const provider = new HttpCloudSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>(
    options,
  );
  return defineCloudSandboxProvider({
    id: options.id ?? 'cloud-http',
    provider,
    priority: options.priority,
  });
}

function normalizeHttpCloudCapabilities(
  declared: readonly SandboxProviderCapability[] | undefined,
): readonly SandboxProviderCapability[] {
  const capabilities =
    declared ?? HTTP_CLOUD_SANDBOX_PROVIDER_CAPABILITIES;
  const unsupportedWorkspaceCapabilities = capabilities.filter(
    (capability) =>
      capability === 'workspace.git.materialize' ||
      capability === 'workspace.git.deliver',
  );
  if (unsupportedWorkspaceCapabilities.length > 0) {
    throw new SandboxProviderConfigurationError(
      `HTTP cloud provider cannot declare unsupported canonical workspace capabilities: ${unsupportedWorkspaceCapabilities.join(', ')}`,
    );
  }
  return Object.freeze([...capabilities]);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function unwrapData(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    return (raw as { readonly data?: unknown }).data;
  }
  return raw;
}

function parseCloudReadoptableTaskIds(raw: unknown): string[] {
  const value = unwrapData(raw);
  if (!Array.isArray(value)) {
    throw new Error(
      'cloud sandbox readoption inventory is indeterminate: response did not include a task id array',
    );
  }
  if (
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.trim().length === 0 ||
        entry.trim() !== entry,
    )
  ) {
    throw new Error(
      'cloud sandbox readoption inventory is indeterminate: response included an invalid task id',
    );
  }
  return value;
}

function assertCloudResourceGeneration(
  raw: unknown,
  expected: string | undefined,
): void {
  if (!expected) return;
  const value = unwrapData(raw);
  const actual =
    value && typeof value === 'object'
      ? (value as { readonly resourceGeneration?: unknown }).resourceGeneration
      : undefined;
  if (actual !== expected) {
    throw new Error(
      'cloud sandbox response did not confirm the requested resource generation',
    );
  }
}

function attestedCloudProviderSandboxId(raw: unknown): string | undefined {
  // Every caller parses the connection from this same object first.
  const value = unwrapData(raw) as { readonly providerSandboxId?: unknown };
  const providerSandboxId = value.providerSandboxId;
  return typeof providerSandboxId === 'string' && providerSandboxId.length > 0
    ? providerSandboxId
    : undefined;
}

function assertCloudReadoptionTarget(
  raw: unknown,
  target: SandboxReadoptionTarget | undefined,
): void {
  if (!target) return;
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('cloud sandbox reattach did not attest the persisted target');
  }
  const record = value as {
    readonly providerSandboxId?: unknown;
    readonly resourceGeneration?: unknown;
  };
  if (
    target.providerSandboxId !== undefined &&
    record.providerSandboxId !== target.providerSandboxId
  ) {
    throw new Error(
      'cloud sandbox reattach provider sandbox id does not match persisted target',
    );
  }
  if (
    target.ownership !== undefined &&
    record.resourceGeneration !== target.ownership.resourceGeneration
  ) {
    throw new Error(
      'cloud sandbox reattach resource generation does not match persisted target',
    );
  }
}

function assertCloudCleanupAuthorization(
  authorization: SandboxRunCleanupAuthorization,
  taskId: string,
  providerId: string,
): void {
  if (
    authorization.taskId !== taskId ||
    authorization.providerId !== providerId
  ) {
    throw new SandboxProviderConfigurationError(
      'Cloud sandbox cleanup authorization does not match the selected run',
    );
  }
}

function assertCloudCleanupTarget(
  raw: unknown,
  ownership?: SandboxOwnershipFence,
  providerSandboxId?: string,
): void {
  const value = unwrapData(raw);
  const record =
    value && typeof value === 'object'
      ? (value as {
          readonly providerSandboxId?: unknown;
          readonly resourceGeneration?: unknown;
        })
      : undefined;
  if (
    ownership !== undefined &&
    record?.resourceGeneration !== ownership.resourceGeneration
  ) {
    throw new Error(
      'cloud sandbox teardown confirmation did not attest the exact resource generation',
    );
  }
  if (
    providerSandboxId !== undefined &&
    record?.providerSandboxId !== providerSandboxId
  ) {
    throw new Error(
      'cloud sandbox teardown confirmation did not attest the exact provider sandbox id',
    );
  }
}

function isCloudTeardownTerminal(
  raw: unknown,
  disposition: SandboxTeardownDisposition,
): boolean {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') return false;
  const record = value as {
    readonly deleted?: unknown;
    readonly status?: unknown;
  };
  return disposition === 'terminal-retain'
    ? record.status === 'stopped' || record.status === 'retained'
    : record.deleted === true ||
        record.status === 'deleted' ||
        record.status === 'removed';
}

function isDefinitiveCloudCreateWithoutResource(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function quoteEntityTag(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parseConnection(raw: unknown, fallbackTaskId: string): SandboxConnection {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('cloud sandbox response did not include a connection object');
  }
  const record = value as Record<string, unknown>;
  const taskId = typeof record.taskId === 'string' ? record.taskId : fallbackTaskId;
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : null;
  const wsUrl = typeof record.wsUrl === 'string' ? record.wsUrl : null;
  if (!baseUrl || !wsUrl) {
    throw new Error('cloud sandbox connection response missing baseUrl or wsUrl');
  }
  return { taskId, baseUrl, wsUrl };
}

/**
 * Cloud readoption must attest the terminal protocol it expects the API to
 * attach. Missing descriptors remain backward-compatible for non-readoption
 * operations, while TasksService refuses to re-adopt them rather than silently
 * defaulting a non-AIO provider to `aio-json-v1`.
 */
function parseOptionalTerminalDescriptor(
  raw: unknown,
): SandboxTerminalEndpointDescriptor | undefined {
  // Every caller parses the connection from this same object first.
  const value = unwrapData(raw) as Record<string, unknown>;
  const terminal = value.terminal;
  if (terminal === undefined || terminal === null) return undefined;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) {
    throw new Error('cloud sandbox terminal descriptor is invalid');
  }
  const record = terminal as Record<string, unknown>;
  if (typeof record.protocol !== 'string' || record.protocol.trim() === '') {
    throw new Error('cloud sandbox terminal descriptor is invalid');
  }
  const url = typeof record.url === 'string' && record.url !== ''
    ? record.url
    : undefined;
  const wsUrl = typeof record.wsUrl === 'string' && record.wsUrl !== ''
    ? record.wsUrl
    : undefined;
  if (url === undefined && wsUrl === undefined) {
    throw new Error('cloud sandbox terminal descriptor is invalid');
  }
  const metadata =
    record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
      ? (record.metadata as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    protocol: record.protocol,
    ...(url === undefined ? {} : { url }),
    ...(wsUrl === undefined ? {} : { wsUrl }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseOptionalTranscriptSource<
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(raw: unknown): TTranscriptSource | null {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.format !== 'string' || typeof record.jsonl !== 'string') {
    return null;
  }
  return {
    format: record.format,
    jsonl: record.jsonl,
  } as TTranscriptSource;
}

function parseDeliverResult(raw: unknown): SandboxDeliverWorkspaceResult {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    return {
      hadChanges: false,
      commitSha: null,
      error: 'cloud delivery response was invalid',
    };
  }
  const record = value as Record<string, unknown>;
  return {
    hadChanges: record.hadChanges === true,
    commitSha: typeof record.commitSha === 'string' ? record.commitSha : null,
    error: typeof record.error === 'string' ? record.error : null,
  };
}
