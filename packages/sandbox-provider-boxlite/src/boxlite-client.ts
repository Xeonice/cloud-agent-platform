import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';

export interface BoxLiteSandboxMetadata {
  readonly [key: string]: unknown;
}

export interface BoxLiteSandbox {
  readonly id: string;
  readonly taskId?: string;
  readonly state?: string;
  readonly image?: string;
  readonly rootfsPath?: string;
  readonly baseUrl?: string;
  readonly terminalUrl?: string;
  readonly metadata?: BoxLiteSandboxMetadata;
}

export interface BoxLiteCreateSandboxRequest {
  readonly taskId: string;
  readonly sandboxId?: string;
  readonly image?: string;
  readonly rootfsPath?: string;
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

export interface BoxLiteStartExecutionRequest {
  readonly sandboxId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly tty?: boolean;
  readonly timeoutMs?: number;
}

export interface BoxLiteStartedExecution {
  readonly id: string;
  readonly sandboxId: string;
}

export interface BoxLiteClient {
  createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox>;
  listSandboxes?(): Promise<readonly BoxLiteSandbox[]>;
  getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null>;
  deleteSandbox(sandboxId: string): Promise<void>;
  exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult>;
  uploadArchive?(request: BoxLiteArchiveUploadRequest): Promise<void>;
  downloadArchive?(request: BoxLiteArchiveDownloadRequest): Promise<Uint8Array | null>;
  startExecution?(request: BoxLiteStartExecutionRequest): Promise<BoxLiteStartedExecution>;
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
  readonly protocolMode?: 'native' | 'cap-rest';
  readonly pathPrefix?: string;
  readonly fetch?: BoxLiteFetch;
  readonly nativeAttachOutput?: boolean;
}

export class BoxLiteRestClient implements BoxLiteClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly protocolMode: 'native' | 'cap-rest';
  private readonly pathPrefix: string;
  private readonly fetchImpl: BoxLiteFetch;
  private readonly nativeAttachOutput: boolean;

  constructor(options: BoxLiteRestClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.protocolMode = options.protocolMode ?? 'native';
    this.pathPrefix = normalizePathPrefix(options.pathPrefix ?? 'default');
    this.nativeAttachOutput = options.nativeAttachOutput ?? options.fetch === undefined;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => {
        const fetchImpl = (globalThis as { readonly fetch?: BoxLiteFetch }).fetch;
        if (!fetchImpl) throw new Error('global fetch is not available');
        return fetchImpl(input, init);
      });
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    validateSandboxSource(request);
    if (this.protocolMode === 'native') {
      const sandbox = parseSandbox(
        await this.requestJson(this.nativeBoxesPath(), {
          method: 'POST',
          body: {
            name: request.sandboxId ?? request.taskId,
            ...(request.rootfsPath
              ? { rootfs_path: request.rootfsPath }
              : { image: request.image }),
            env: request.env,
          },
        }),
      );
      try {
        return parseSandbox(
          await this.requestJson(`${this.sandboxPath(sandbox.id)}/start`, {
            method: 'POST',
          }),
        );
      } catch (error) {
        await this.deleteSandbox(sandbox.id).catch(() => undefined);
        throw error;
      }
    }
    if (request.rootfsPath) {
      throw new Error('BoxLite rootfsPath create is only supported with native protocol mode');
    }
    return parseSandbox(
      await this.requestJson('/v1/sandboxes', {
        method: 'POST',
        body: request,
      }),
    );
  }

  async getSandbox(sandboxId: string): Promise<BoxLiteSandbox | null> {
    const res = await this.request(this.sandboxPath(sandboxId), {
      method: 'GET',
    });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`BoxLite get sandbox ${sandboxId} failed: HTTP ${res.status}`);
    }
    return parseOptionalSandbox(await res.json().catch(() => undefined));
  }

  async listSandboxes(): Promise<readonly BoxLiteSandbox[]> {
    const raw = await this.requestJson(
      this.protocolMode === 'native' ? this.nativeBoxesPath() : '/v1/sandboxes',
      { method: 'GET' },
    );
    return parseSandboxList(raw);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const res = await this.request(this.sandboxPath(sandboxId), {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`BoxLite delete sandbox ${sandboxId} failed: HTTP ${res.status}`);
    }
  }

  async exec(request: BoxLiteExecRequest): Promise<BoxLiteExecResult> {
    if (this.protocolMode === 'native') {
      const started = await this.startExecution({
        sandboxId: request.sandboxId,
        command: 'sh',
        args: ['-lc', request.command],
        cwd: request.cwd,
        tty: false,
        timeoutMs: request.timeoutMs,
      });
      const outputPromise = this.nativeAttachOutput
        ? this.collectNativeExecutionOutput(
            started.sandboxId,
            started.id,
            request.timeoutMs,
          ).catch(() => null)
        : Promise.resolve(null);
      const polled = await this.waitForNativeExecution(
        started.sandboxId,
        started.id,
        request.timeoutMs,
      );
      const attached = await outputPromise;
      return mergeExecOutput(polled, attached);
    }
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
    if (this.protocolMode === 'native') {
      const path = encodeURIComponent(request.path);
      const res = await this.request(
        `${this.sandboxPath(request.sandboxId)}/files?path=${path}`,
        {
          method: 'PUT',
          body: request.archive,
        },
      );
      if (!res.ok) {
        throw new Error(
          `BoxLite file upload for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
        );
      }
      return;
    }
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
    if (this.protocolMode === 'native') {
      const path = encodeURIComponent(request.path);
      const res = await this.request(
        `${this.sandboxPath(request.sandboxId)}/files?path=${path}`,
        { method: 'GET' },
      );
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) {
        throw new Error(
          `BoxLite file download for sandbox ${request.sandboxId} failed: HTTP ${res.status}`,
        );
      }
      const buffer = await res.arrayBuffer?.();
      return buffer ? new Uint8Array(buffer) : null;
    }
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

  async startExecution(
    request: BoxLiteStartExecutionRequest,
  ): Promise<BoxLiteStartedExecution> {
    const raw = await this.requestJson(
      `${this.sandboxPath(request.sandboxId)}/exec`,
      {
        method: 'POST',
        body: {
          command: request.command,
          args: request.args,
          working_dir: request.cwd,
          tty: request.tty === true,
          timeout_seconds:
            request.timeoutMs === undefined
              ? undefined
              : Math.max(1, Math.ceil(request.timeoutMs / 1000)),
        },
      },
    );
    return parseStartedExecution(raw, request.sandboxId);
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
      const text =
        typeof res.text === 'function'
          ? await res.text().catch(() => '')
          : '';
      const detail = text.trim() ? `: ${text.trim().slice(0, 500)}` : '';
      throw new Error(`BoxLite request ${init.method} ${path} failed: HTTP ${res.status}${detail}`);
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
      Object.assign(headers, this.authHeaders());
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body,
      signal: timeoutSignal(this.timeoutMs),
    });
  }

  private sandboxPath(sandboxId: string): string {
    return this.protocolMode === 'native'
      ? `${this.nativeBoxesPath()}/${encodePathSegment(sandboxId)}`
      : `/v1/sandboxes/${encodeURIComponent(sandboxId)}`;
  }

  private nativeBoxesPath(): string {
    return `${this.nativeApiPath()}/boxes`;
  }

  private nativeExecutionPath(sandboxId: string, executionId: string): string {
    return `${this.sandboxPath(sandboxId)}/executions/${encodePathSegment(executionId)}`;
  }

  private nativeApiPath(): string {
    return this.pathPrefix ? `/v1/${this.pathPrefix}` : '/v1';
  }

  private async waitForNativeExecution(
    sandboxId: string,
    executionId: string,
    timeoutMs: number | undefined,
  ): Promise<BoxLiteExecResult> {
    const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);
    let last: unknown;
    while (Date.now() <= deadline) {
      last = await this.requestJson(this.nativeExecutionPath(sandboxId, executionId), {
        method: 'GET',
      });
      const result = parseNativeExecutionResult(last);
      if (result.done) return result.result;
      await sleep(250);
    }
    return {
      exitCode: 124,
      stdout: '',
      stderr: '',
      output: '',
      timedOut: true,
    };
  }

  private collectNativeExecutionOutput(
    sandboxId: string,
    executionId: string,
    timeoutMs: number | undefined,
  ): Promise<Pick<BoxLiteExecResult, 'stdout' | 'stderr' | 'output'> | null> {
    return new Promise((resolve) => {
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      let socket: WebSocket | null = null;
      const timeout = setTimeout(() => finish(), timeoutMs ?? this.timeoutMs);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        try {
          socket?.close();
        } catch {
          // Best-effort; closed sockets may throw.
        }
        resolve(stdout || stderr ? { stdout, stderr, output: `${stdout}${stderr}` } : null);
      };

      try {
        socket = new WebSocket(
          `${this.baseUrl.replace(/^http/, 'ws')}${this.nativeExecutionPath(sandboxId, executionId)}/attach`,
          { headers: this.authHeaders() },
        );
      } catch {
        finish();
        return;
      }

      socket.on('message', (raw, isBinary) => {
        if (!isBinary) {
          const text = rawToBuffer(raw).toString('utf8');
          const frame = parseControlFrame(text);
          if (frame?.type === 'exit') finish();
          return;
        }
        const buffer = rawToBuffer(raw);
        if (buffer.length === 0) return;
        const channel = buffer[0];
        const payload = buffer.subarray(1);
        if (channel === 1) {
          stdout += stdoutDecoder.write(payload);
        } else if (channel === 2) {
          stderr += stderrDecoder.write(payload);
        }
      });
      socket.on('close', finish);
      socket.on('error', finish);
    });
  }

  private authHeaders(): Record<string, string> {
    return this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {};
  }
}

export interface FakeBoxLiteClientOptions {
  readonly execHandler?: (request: BoxLiteExecRequest) => BoxLiteExecResult | Promise<BoxLiteExecResult>;
}

export class FakeBoxLiteClient implements BoxLiteClient {
  readonly sandboxes = new Map<string, BoxLiteSandbox>();
  readonly createCalls: BoxLiteCreateSandboxRequest[] = [];
  readonly execCalls: BoxLiteExecRequest[] = [];
  readonly startExecutionCalls: BoxLiteStartExecutionRequest[] = [];
  readonly deletedSandboxIds: string[] = [];
  private readonly archives = new Map<string, Uint8Array>();
  private readonly execHandler?: FakeBoxLiteClientOptions['execHandler'];

  constructor(options: FakeBoxLiteClientOptions = {}) {
    this.execHandler = options.execHandler;
  }

  async createSandbox(request: BoxLiteCreateSandboxRequest): Promise<BoxLiteSandbox> {
    validateSandboxSource(request);
    this.createCalls.push(request);
    const id = request.sandboxId ?? request.taskId;
    const sandbox: BoxLiteSandbox = {
      id,
      taskId: request.taskId,
      state: 'running',
      image: request.image,
      rootfsPath: request.rootfsPath,
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

  async listSandboxes(): Promise<readonly BoxLiteSandbox[]> {
    return [...this.sandboxes.values()];
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

  async startExecution(
    request: BoxLiteStartExecutionRequest,
  ): Promise<BoxLiteStartedExecution> {
    this.startExecutionCalls.push(request);
    return {
      id: `exec-${this.startExecutionCalls.length}`,
      sandboxId: request.sandboxId,
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

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map(encodePathSegment)
    .join('/');
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
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

function parseSandboxList(raw: unknown): readonly BoxLiteSandbox[] {
  const value = unwrapData(raw);
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { boxes?: unknown }).boxes)
      ? (value as { boxes: unknown[] }).boxes
      : value &&
          typeof value === 'object' &&
          Array.isArray((value as { sandboxes?: unknown }).sandboxes)
        ? (value as { sandboxes: unknown[] }).sandboxes
        : null;
  if (!list) throw new Error('BoxLite response did not include a sandbox list');
  return list.map(parseSandbox);
}

function parseSandbox(raw: unknown): BoxLiteSandbox {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite response did not include a sandbox object');
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.box_id === 'string'
        ? record.box_id
        : typeof record.name === 'string'
          ? record.name
          : null;
  if (!id) throw new Error('BoxLite sandbox response missing id');
  return {
    id,
    taskId:
      typeof record.taskId === 'string'
        ? record.taskId
        : typeof record.task_id === 'string'
          ? record.task_id
          : undefined,
    state:
      typeof record.state === 'string'
        ? record.state
        : typeof record.status === 'string'
          ? record.status
          : undefined,
    image: typeof record.image === 'string' ? record.image : undefined,
    rootfsPath:
      typeof record.rootfsPath === 'string'
        ? record.rootfsPath
        : typeof record.rootfs_path === 'string'
          ? record.rootfs_path
          : undefined,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
    terminalUrl: typeof record.terminalUrl === 'string' ? record.terminalUrl : undefined,
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as BoxLiteSandboxMetadata)
        : undefined,
  };
}

function validateSandboxSource(request: BoxLiteCreateSandboxRequest): void {
  if (request.image && request.rootfsPath) {
    throw new Error('BoxLite createSandbox requires either image or rootfsPath, not both');
  }
  if (!request.image && !request.rootfsPath) {
    throw new Error('BoxLite createSandbox requires image or rootfsPath');
  }
}

function parseStartedExecution(
  raw: unknown,
  sandboxId: string,
): BoxLiteStartedExecution {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    throw new Error('BoxLite exec response did not include an execution object');
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.execution_id === 'string'
      ? record.execution_id
      : typeof record.id === 'string'
        ? record.id
        : null;
  if (!id) throw new Error('BoxLite exec response missing execution id');
  return { id, sandboxId };
}

function parseNativeExecutionResult(raw: unknown): {
  readonly done: boolean;
  readonly result: BoxLiteExecResult;
} {
  const value = unwrapData(raw);
  if (!value || typeof value !== 'object') {
    return {
      done: true,
      result: {
        exitCode: 1,
        stdout: '',
        stderr: '',
        output: '',
      },
    };
  }
  const record = value as Record<string, unknown>;
  const status = String(record.status ?? record.state ?? '').toLowerCase();
  const exitCode =
    typeof record.exit_code === 'number'
      ? record.exit_code
      : typeof record.exitCode === 'number'
        ? record.exitCode
        : typeof record.code === 'number'
          ? record.code
          : null;
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const output =
    typeof record.output === 'string'
      ? record.output
      : stdout || stderr
        ? `${stdout}${stderr}`
        : '';
  const done =
    exitCode !== null ||
    ['completed', 'complete', 'exited', 'failed', 'killed', 'timeout', 'timed_out'].includes(status);
  return {
    done,
    result: {
      exitCode: exitCode ?? (status === 'timed_out' || status === 'timeout' ? 124 : 0),
      stdout,
      stderr,
      output,
      timedOut: status === 'timed_out' || status === 'timeout' || record.timed_out === true,
    },
  };
}

function mergeExecOutput(
  polled: BoxLiteExecResult,
  attached: Pick<BoxLiteExecResult, 'stdout' | 'stderr' | 'output'> | null,
): BoxLiteExecResult {
  if (!attached) return polled;
  const stdout = attached.stdout || polled.stdout;
  const stderr = attached.stderr || polled.stderr;
  const output = attached.output || polled.output || `${stdout}${stderr}`;
  return {
    ...polled,
    stdout,
    stderr,
    output,
  };
}

function rawToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function parseControlFrame(text: string): { readonly type?: unknown } | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      ? (parsed as { readonly type?: unknown })
      : null;
  } catch {
    return null;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
