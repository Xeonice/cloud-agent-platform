export interface BoxLiteSandboxMetadata {
  readonly [key: string]: unknown;
}

export interface BoxLiteSandbox {
  readonly id: string;
  readonly taskId?: string;
  readonly state?: string;
  readonly image?: string;
  readonly baseUrl?: string;
  readonly terminalUrl?: string;
  readonly metadata?: BoxLiteSandboxMetadata;
}

export interface BoxLiteCreateSandboxRequest {
  readonly taskId: string;
  readonly sandboxId?: string;
  readonly image: string;
  readonly location?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: BoxLiteSandboxMetadata;
}

export interface BoxLiteExecRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface BoxLiteExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly timedOut?: boolean;
}

export interface BoxLiteArchiveUploadRequest {
  readonly sandboxId: string;
  readonly path: string;
  readonly archive: Uint8Array;
}

export interface BoxLiteArchiveDownloadRequest {
  readonly sandboxId: string;
  readonly path: string;
}

export interface BoxLiteClient {
  createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox>;
  getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null>;
  deleteSandbox(sandboxId: string): Promise<void>;
  exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult>;
  uploadArchive?(request: BoxLiteArchiveUploadRequest): Promise<void>;
  downloadArchive?(request: BoxLiteArchiveDownloadRequest): Promise<Uint8Array | null>;
}

export interface BoxLiteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type BoxLiteFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Uint8Array;
    readonly signal?: unknown;
  },
) => Promise<BoxLiteFetchResponse>;

export interface BoxLiteRestClientOptions {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: BoxLiteFetch;
}

export class BoxLiteRestClient implements BoxLiteClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: BoxLiteFetch;

  constructor(options: BoxLiteRestClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => {
        const fetchImpl = (globalThis as { readonly fetch?: BoxLiteFetch }).fetch;
        if (!fetchImpl) throw new Error('global fetch is not available');
        return fetchImpl(input, init);
      });
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    return parseSandbox(
      await this.requestJson('/v1/sandboxes', {
        method: 'POST',
        body: request,
      }),
    );
  }

  async getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: 'GET',
    });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`BoxLite get sandbox ${sandboxId} failed: HTTP ${res.status}`);
    }
    return parseOptionalSandbox(await res.json().catch(() => undefined));
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`BoxLite delete sandbox ${sandboxId} failed: HTTP ${res.status}`);
    }
  }

  async exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult> {
    return parseExecResult(
      await this.requestJson(
        `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/exec`,
        {
          method: 'POST',
          body: {
            command: request.command,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
          },
        },
      ),
    );
  }

  async uploadArchive(request: BoxLiteArchiveUploadRequest): Promise<void> {
    const path = encodeURIComponent(request.path);
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/archive?path=${path}`,
      {
        method: 'PUT',
        body: request.archive,
      },
    );
    if (!res.ok) {
      throw new Error(
        `BoxLite archive upload for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
      );
    }
  }

  async downloadArchive(
    request: BoxLiteArchiveDownloadRequest,
  ): Promise<Uint8Array | null> {
    const path = encodeURIComponent(request.path);
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(request.sandboxId)}/archive?path=${path}`,
      { method: 'GET' },
    );
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      throw new Error(
        `BoxLite archive download for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
      );
    }
    const buffer = await res.arrayBuffer?.();
    return buffer ? new Uint8Array(buffer) : null;
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
      throw new Error(`BoxLite request ${init.method} ${path} failed: HTTP ${res.status}`);
    }
    return res.json().catch(() => undefined);
  }

  private request(
    path: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
    },
  ): Promise<BoxLiteFetchResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    let body: string | Uint8Array | undefined;
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) {
      body = init.body;
      if (init.body instanceof Uint8Array) {
        headers['content-type'] = 'application/octet-stream';
      }
    } else if (init.body !== undefined) {
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
      signal: timeoutSignal(this.timeoutMs),
    });
  }
}

export interface FakeBoxLiteClientOptions {
  readonly execHandler?: (request: BoxLiteExecRequest) => BoxLiteExecResult | Promise<BoxLiteExecResult>;
}

export class FakeBoxLiteClient implements BoxLiteClient {
  readonly sandboxes = new Map<string, BoxLiteSandbox>();
  readonly createCalls: BoxLiteCreateSandboxRequest[] = [];
  readonly execCalls: BoxLiteExecRequest[] = [];
  readonly deletedSandboxIds: string[] = [];
  private readonly archives = new Map<string, Uint8Array>();
  private readonly execHandler?: FakeBoxLiteClientOptions['execHandler'];

  constructor(options: FakeBoxLiteClientOptions = {}) {
    this.execHandler = options.execHandler;
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    this.createCalls.push(request);
    const id = request.sandboxId ?? request.taskId;
    const sandbox: BoxLiteSandbox = {
      id,
      taskId: request.taskId,
      state: 'running',
      image: request.image,
      baseUrl: `boxlite://${id}`,
      terminalUrl: `boxlite://${id}/terminal`,
      metadata: request.metadata,
    };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null> {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.deletedSandboxIds.push(sandboxId);
    this.sandboxes.delete(sandboxId);
  }

  async exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult> {
    this.execCalls.push(request);
    if (this.execHandler) return this.execHandler(request);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: false,
    };
  }

  async uploadArchive(request: BoxLiteArchiveUploadRequest): Promise<void> {
    this.archives.set(archiveKey(request.sandboxId, request.path), request.archive);
  }

  async downloadArchive(
    request: BoxLiteArchiveDownloadRequest,
  ): Promise<Uint8Array | null> {
    return this.archives.get(archiveKey(request.sandboxId, request.path)) ?? null;
  }
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

function parseOptionalSandbox(raw: unknown): BoxLiteSandbox | null {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') return null;
  return parseSandbox(value);
}

function parseSandbox(raw: unknown): BoxLiteSandbox {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite response did not include a sandbox object');
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  if (!id) throw new Error('BoxLite sandbox response missing id');
  return {
    id,
    taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
    state: typeof record.state === 'string' ? record.state : undefined,
    image: typeof record.image === 'string' ? record.image : undefined,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
    terminalUrl: typeof record.terminalUrl === 'string' ? record.terminalUrl : undefined,
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as BoxLiteSandboxMetadata)
        : undefined,
  };
}

function parseExecResult(raw: unknown): BoxLiteExecResult {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite exec response did not include a result object');
  }
  const record = value as Record<string, unknown>;
  const exitCode =
    typeof record.exitCode === 'number'
      ? record.exitCode
      : typeof record.exit_code === 'number'
        ? record.exit_code
        : Number.NaN;
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const output =
    typeof record.output === 'string'
      ? record.output
      : stdout || stderr
        ? `${stdout}${stderr}`
        : '';
  return {
    exitCode,
    stdout,
    stderr,
    output,
    timedOut: record.timedOut === true || record.timed_out === true,
  };
}

function archiveKey(sandboxId: string, path: string): string {
  return `${sandboxId}\0${path}`;
}

function timeoutSignal(timeoutMs: number): unknown {
  return (
    globalThis as {
      readonly AbortSignal?: { timeout(timeoutMs: number): unknown };
    }
  ).AbortSignal?.timeout(timeoutMs);
}
