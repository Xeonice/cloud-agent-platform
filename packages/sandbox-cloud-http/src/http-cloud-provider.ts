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
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  defineCloudSandboxProvider,
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
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly mode?: SandboxExecutionMode;
  readonly capabilities?: readonly SandboxProviderCapability[];
  readonly timeoutMs?: number;
  readonly fetch?: HttpCloudSandboxFetch;
}

export interface HttpCloudSandboxProviderDescriptorOptions
  extends HttpCloudSandboxProviderOptions {
  readonly id?: string;
  readonly priority?: number;
}

export class HttpCloudSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> implements
    SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource>,
    SandboxReadoptionPort
{
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly mode: SandboxExecutionMode;
  private readonly capabilities: readonly SandboxProviderCapability[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: HttpCloudSandboxFetch;

  constructor(options: HttpCloudSandboxProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.mode = options.mode ?? 'workspace-write';
    this.capabilities = options.capabilities ?? SANDBOX_PROVIDER_CAPABILITIES;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
    const raw = await this.requestJson('/v1/sandboxes', {
      method: 'POST',
      body,
    });
    return parseConnection(raw, ctx.taskId);
  }

  async teardownSandbox(taskId: string): Promise<void> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`cloud sandbox teardown for task ${taskId} failed: HTTP ${res.status}`);
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
    return res.ok;
  }

  async deliverWorkspaceChanges(
    taskId: string,
    args: SandboxDeliverWorkspaceArgs,
  ): Promise<SandboxDeliverWorkspaceResult> {
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
    const raw = await this.requestJson('/v1/sandboxes/readoptable', { method: 'GET' });
    const value = unwrapData(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  async reattach(taskId: string): Promise<SandboxConnection | null> {
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(taskId)}/reattach`,
      { method: 'POST' },
    );
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) return null;
    return parseConnection(await res.json().catch(() => undefined), taskId);
  }

  private async requestJson(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
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
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
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
