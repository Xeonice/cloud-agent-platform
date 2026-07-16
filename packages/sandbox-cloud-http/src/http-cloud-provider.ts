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
  SandboxRunCleanupAuthorization,
  SandboxSelectedRunPort,
  SandboxTeardownDisposition,
  SandboxTeardownResult,
  SandboxTerminalEndpointDescriptor,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  assertSandboxProviderSupportsResources,
  defineCloudSandboxProvider,
  isSandboxLegacyDeliverWorkspaceArgs,
  resourcesForSandboxProvision,
  runSandboxExternalBoundary,
  SandboxCleanupPendingError,
  SandboxProviderConfigurationError,
  snapshotSandboxProvisionContext,
  type SelectedSandboxRun,
  type SandboxProviderDescriptor,
} from '@cap/sandbox-core';

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
    }
  >();

  constructor(options: HttpCloudSandboxProviderOptions) {
    this.id = options.id ?? 'cloud-http';
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.mode = options.mode ?? 'workspace-write';
    this.capabilities = options.capabilities ?? SANDBOX_PROVIDER_CAPABILITIES;
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
    let observedProviderSandboxId: string | undefined;
    try {
      const raw = await runSandboxExternalBoundary({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        guard: ctx.externalBoundaryGuard,
        signal: ctx.cancellationSignal,
        run: async () => {
          const res = await this.request('/v1/sandboxes', {
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
          if (!res.ok) {
            if (isDefinitiveCloudCreateWithoutResource(res.status)) {
              await ctx.onSandboxCreateObserved?.({ kind: 'not-created' });
            }
            throw new Error(
              `cloud sandbox request POST /v1/sandboxes failed: HTTP ${res.status}`,
            );
          }
          const raw = await res.json().catch(() => undefined);
          assertCloudResourceGeneration(raw, resourceGeneration);
          const providerSandboxId = attestedCloudProviderSandboxId(raw);
          observedProviderSandboxId = providerSandboxId;
          await ctx.onSandboxCreateObserved?.({
            kind: 'created',
            ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
          });
          return raw;
        },
      });
      const connection = parseConnection(raw, ctx.taskId);
      const providerSandboxId = attestedCloudProviderSandboxId(raw);
      const terminal = parseOptionalTerminalDescriptor(raw);
      this.runs.set(ctx.taskId, {
        connection,
        ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
        ...(terminal === undefined ? {} : { terminal }),
        ownership: ctx.ownership,
      });
      return connection;
    } catch (error) {
      await this.cleanupFailedProvision(ctx, observedProviderSandboxId);
      throw error;
    }
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
    const result = await this.deleteSandbox(
      taskId,
      ownership,
      providerSandboxId,
      disposition,
    );
    this.runs.delete(taskId);
    return result;
  }

  private async deleteSandbox(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
    disposition: SandboxTeardownDisposition = 'superseded-remove',
  ): Promise<SandboxTeardownResult> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}`, {
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
    if (res.status === 409 || res.status === 412) {
      throw new Error(
        `cloud sandbox teardown for task ${taskId} was fenced by resource generation`,
      );
    }
    if (res.status === 202) {
      return this.confirmAcceptedTeardown(
        taskId,
        ownership,
        providerSandboxId,
        disposition,
      );
    }
    if (res.status === 404) return { kind: 'already-absent' };
    if (!res.ok) {
      throw new Error(`cloud sandbox teardown for task ${taskId} failed: HTTP ${res.status}`);
    }
    if (disposition === 'terminal-retain') {
      const raw = await res.json().catch(() => undefined);
      if (isCloudTeardownTerminal(raw, disposition)) {
        assertCloudCleanupTarget(raw, ownership, providerSandboxId);
        return { kind: 'found-and-cleaned' };
      }
      // A synchronous 2xx/204 acknowledges the command but does not prove the
      // retained sandbox is stopped and reattachable. Confirm it exactly like
      // an asynchronous 202 response.
      return this.confirmAcceptedTeardown(
        taskId,
        ownership,
        providerSandboxId,
        disposition,
      );
    }
    return { kind: 'found-and-cleaned' };
  }

  private async confirmAcceptedTeardown(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
    disposition: SandboxTeardownDisposition = 'superseded-remove',
  ): Promise<SandboxTeardownResult> {
    for (let attempt = 0; attempt < this.cleanupPollAttempts; attempt += 1) {
      const res = await this.request(
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
      if (res.status === 404) {
        if (disposition === 'superseded-remove') {
          return { kind: 'found-and-cleaned' };
        }
        throw new Error(
          `cloud terminal-retain teardown for task ${taskId} removed the retained sandbox`,
        );
      }
      if (res.status === 409 || res.status === 412) {
        throw new Error(
          `cloud sandbox teardown for task ${taskId} was fenced by resource generation`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `cloud sandbox teardown confirmation for task ${taskId} failed: HTTP ${res.status}`,
        );
      }
      const raw = await res.json().catch(() => undefined);
      assertCloudCleanupTarget(raw, ownership, providerSandboxId);
      if (isCloudTeardownTerminal(raw, disposition)) {
        return { kind: 'found-and-cleaned' };
      }
      if (attempt + 1 < this.cleanupPollAttempts) {
        await this.delayImpl(this.cleanupPollIntervalMs);
      }
    }
    throw new SandboxCleanupPendingError();
  }

  private async cleanupFailedProvision(
    ctx: SandboxProvisionContext<TCloneSpec>,
    observedProviderSandboxId?: string,
  ): Promise<void> {
    const authorization = await ctx.beforeSandboxCleanup?.();
    if (!authorization) return;
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
    const result = await this.deleteSandbox(
      ctx.taskId,
      authorization.kind === 'generation'
        ? authorization.ownership
        : undefined,
      observedProviderSandboxId ?? this.runs.get(ctx.taskId)?.providerSandboxId,
      'superseded-remove',
    );
    if (result.kind === 'found-and-cleaned') {
      await ctx.afterSandboxCleanup?.(authorization);
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

  async sandboxExists(taskId: string): Promise<boolean> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}`, {
      method: 'GET',
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(
        `cloud sandbox existence check for task ${taskId} is indeterminate: HTTP ${res.status}`,
      );
    }
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

  private async requestJson(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown> {
    const res = await this.request(path, init);
    if (!res.ok) {
      throw new Error(`cloud sandbox request ${init.method} ${path} failed: HTTP ${res.status}`);
    }
    return res.json().catch(() => undefined);
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
  const value = unwrapData(raw);
  const providerSandboxId =
    value && typeof value === 'object'
      ? (value as { readonly providerSandboxId?: unknown }).providerSandboxId
      : undefined;
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
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') return undefined;
  const terminal = (value as Record<string, unknown>).terminal;
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
