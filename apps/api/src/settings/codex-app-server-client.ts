import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export const DEFAULT_APP_SERVER_LINE_BYTES = 256 * 1024;
export const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 10_000;

export type CodexAppServerClientErrorKind =
  | 'aborted'
  | 'malformed_message'
  | 'message_too_large'
  | 'process_exited'
  | 'request_failed'
  | 'request_timeout'
  | 'transport_failed';

const SAFE_MESSAGES: Record<CodexAppServerClientErrorKind, string> = {
  aborted: 'Codex App Server operation was aborted.',
  malformed_message: 'Codex App Server returned an invalid protocol message.',
  message_too_large: 'Codex App Server returned an oversized protocol message.',
  process_exited: 'Codex App Server exited before login completed.',
  request_failed: 'Codex App Server rejected a protocol request.',
  request_timeout: 'Codex App Server did not respond before the deadline.',
  transport_failed: 'Codex App Server transport failed.',
};

/** Protocol error with no raw payload/server message attached. */
export class CodexAppServerClientError extends Error {
  readonly name = 'CodexAppServerClientError';

  constructor(readonly kind: CodexAppServerClientErrorKind) {
    super(SAFE_MESSAGES[kind]);
  }
}

export interface CodexAppServerTransport {
  readonly readable: Readable;
  readonly writable: Writable;
}

export interface CodexAppServerClientOptions {
  readonly maxLineBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface CodexAppServerOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodexAppServerDeviceCode {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
}

export type CodexAppServerLoginCompletion =
  | { readonly loginId: string; readonly success: true }
  | { readonly loginId: string; readonly success: false };

interface PendingRequest<T = unknown> {
  readonly method: string;
  readonly parse: (value: unknown) => T;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: CodexAppServerClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface CompletionWaiter {
  readonly loginId: string;
  readonly resolve: (value: CodexAppServerLoginCompletion) => void;
  readonly reject: (reason: CodexAppServerClientError) => void;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseInitializeResult(value: unknown): JsonObject {
  if (
    !isObject(value) ||
    !nonEmptyString(value.codexHome) ||
    !nonEmptyString(value.platformFamily) ||
    !nonEmptyString(value.platformOs) ||
    !nonEmptyString(value.userAgent)
  ) {
    throw new CodexAppServerClientError('malformed_message');
  }
  return value;
}

function parseDeviceCodeResult(value: unknown): CodexAppServerDeviceCode {
  if (
    !isObject(value) ||
    value.type !== 'chatgptDeviceCode' ||
    !nonEmptyString(value.loginId) ||
    !nonEmptyString(value.verificationUrl) ||
    !nonEmptyString(value.userCode)
  ) {
    throw new CodexAppServerClientError('malformed_message');
  }

  let url: URL;
  try {
    url = new URL(value.verificationUrl);
  } catch {
    throw new CodexAppServerClientError('malformed_message');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CodexAppServerClientError('malformed_message');
  }

  return {
    loginId: value.loginId,
    verificationUrl: value.verificationUrl,
    userCode: value.userCode,
  };
}

function parseCancelResult(value: unknown): 'canceled' | 'notFound' {
  if (
    !isObject(value) ||
    (value.status !== 'canceled' && value.status !== 'notFound')
  ) {
    throw new CodexAppServerClientError('malformed_message');
  }
  return value.status;
}

/**
 * Minimal, runtime-validated client for the pinned Codex App Server JSONL API.
 * Unknown notifications are ignored for forward compatibility; known messages
 * fail closed without including their payload in the resulting error.
 */
export class CodexAppServerClient {
  private readonly decoder = new StringDecoder('utf8');
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly queuedCompletions = new Map<string, CodexAppServerLoginCompletion>();
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private bufferedLine = '';
  private bufferedLineBytes = 0;
  private nextRequestId = 1;
  private activeLoginId?: string;
  private completionWaiter?: CompletionWaiter;
  private terminalError?: CodexAppServerClientError;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly transport: CodexAppServerTransport,
    options: CodexAppServerClientOptions = {},
  ) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_APP_SERVER_LINE_BYTES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'cloud-agent-platform';
    this.clientVersion = options.clientVersion ?? '1';

    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
      throw new Error('maxLineBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be a positive integer');
    }

    transport.readable.on('data', this.onData);
    transport.readable.once('end', this.onTransportEnd);
    transport.readable.once('close', this.onTransportEnd);
    transport.readable.once('error', this.onTransportError);
    transport.writable.once('error', this.onTransportError);
  }

  async initialize(options: CodexAppServerOperationOptions = {}): Promise<void> {
    if (this.initialized) return;
    await this.request(
      'initialize',
      {
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
          title: 'Cloud Agent Platform',
        },
        capabilities: null,
      },
      parseInitializeResult,
      options,
    );
    // The initialized notification is deliberately emitted only after the
    // initialize response has been validated.
    this.write({ method: 'initialized' });
    this.initialized = true;
  }

  async startDeviceCode(
    options: CodexAppServerOperationOptions = {},
  ): Promise<CodexAppServerDeviceCode> {
    if (!this.initialized) {
      throw new CodexAppServerClientError('malformed_message');
    }
    const result = await this.request(
      'account/login/start',
      { type: 'chatgptDeviceCode' },
      parseDeviceCodeResult,
      options,
    );
    this.activeLoginId = result.loginId;
    for (const loginId of [...this.queuedCompletions.keys()]) {
      if (loginId !== result.loginId) this.queuedCompletions.delete(loginId);
    }
    return result;
  }

  async waitForCompletion(
    loginId: string,
    options: CodexAppServerOperationOptions = {},
  ): Promise<CodexAppServerLoginCompletion> {
    if (!nonEmptyString(loginId) || loginId !== this.activeLoginId) {
      throw new CodexAppServerClientError('malformed_message');
    }
    this.throwIfTerminal();

    const queued = this.queuedCompletions.get(loginId);
    if (queued) {
      this.queuedCompletions.delete(loginId);
      return queued;
    }

    if (this.completionWaiter) {
      throw new CodexAppServerClientError('malformed_message');
    }

    let waiter: CompletionWaiter | undefined;
    const completion = new Promise<CodexAppServerLoginCompletion>((resolve, reject) => {
      waiter = { loginId, resolve, reject };
      this.completionWaiter = waiter;
    });
    try {
      return await this.boundPromise(completion, options);
    } catch (error) {
      if (this.completionWaiter === waiter) this.completionWaiter = undefined;
      throw error;
    }
  }

  async cancel(
    loginId: string,
    options: CodexAppServerOperationOptions = {},
  ): Promise<void> {
    if (!nonEmptyString(loginId)) {
      throw new CodexAppServerClientError('malformed_message');
    }
    await this.request(
      'account/login/cancel',
      { loginId },
      parseCancelResult,
      options,
    );
  }

  /** Stops protocol processing without writing any raw buffered data. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.fail(new CodexAppServerClientError('process_exited'));
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed || this.terminalError) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // A single transport chunk is also bounded. Valid JSONL may coalesce many
    // messages, so allow a small multiple of the per-line ceiling.
    if (bytes.length > this.maxLineBytes * 4) {
      this.fail(new CodexAppServerClientError('message_too_large'));
      return;
    }
    const decoded = this.decoder.write(bytes);
    let from = 0;
    while (from < decoded.length) {
      const newline = decoded.indexOf('\n', from);
      const end = newline === -1 ? decoded.length : newline;
      let piece = decoded.slice(from, end);
      if (newline !== -1 && piece.endsWith('\r')) piece = piece.slice(0, -1);
      this.bufferedLine += piece;
      this.bufferedLineBytes += Buffer.byteLength(piece, 'utf8');
      if (this.bufferedLineBytes > this.maxLineBytes) {
        this.fail(new CodexAppServerClientError('message_too_large'));
        return;
      }
      if (newline === -1) break;
      const line = this.bufferedLine;
      this.bufferedLine = '';
      this.bufferedLineBytes = 0;
      if (line.length > 0) this.handleLine(line);
      if (this.terminalError) return;
      from = newline + 1;
    }
  };

  private readonly onTransportEnd = (): void => {
    if (this.closed || this.terminalError) return;
    const trailing = this.decoder.end();
    if (trailing.length > 0) {
      this.bufferedLine += trailing;
      this.bufferedLineBytes += Buffer.byteLength(trailing, 'utf8');
    }
    this.fail(new CodexAppServerClientError('process_exited'));
  };

  private readonly onTransportError = (): void => {
    this.fail(new CodexAppServerClientError('transport_failed'));
  };

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new CodexAppServerClientError('malformed_message'));
      return;
    }
    if (!isObject(value)) {
      this.fail(new CodexAppServerClientError('malformed_message'));
      return;
    }

    if (isRequestId(value.id) && ('result' in value || 'error' in value)) {
      this.handleResponse(value.id, value);
      return;
    }
    if (typeof value.method === 'string') {
      this.handleNotification(value.method, value.params);
      return;
    }
    this.fail(new CodexAppServerClientError('malformed_message'));
  }

  private handleResponse(id: string | number, response: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.fail(new CodexAppServerClientError('malformed_message'));
      return;
    }
    this.pending.delete(id);
    this.cleanupPending(pending);

    if ('error' in response) {
      const error = response.error;
      if (
        !isObject(error) ||
        !Number.isSafeInteger(error.code) ||
        typeof error.message !== 'string'
      ) {
        pending.reject(new CodexAppServerClientError('malformed_message'));
      } else {
        // Never include the server-provided message/data: either may contain
        // authentication material.
        pending.reject(new CodexAppServerClientError('request_failed'));
      }
      return;
    }

    try {
      pending.resolve(pending.parse(response.result));
    } catch {
      pending.reject(new CodexAppServerClientError('malformed_message'));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'account/login/completed') {
      // Codex adds notifications over time; unrelated methods are intentionally
      // ignored rather than becoming an accidental version lock.
      return;
    }
    if (
      !isObject(params) ||
      typeof params.success !== 'boolean' ||
      (params.loginId !== undefined &&
        params.loginId !== null &&
        !nonEmptyString(params.loginId)) ||
      (params.error !== undefined && params.error !== null && typeof params.error !== 'string')
    ) {
      this.fail(new CodexAppServerClientError('malformed_message'));
      return;
    }
    if (params.loginId === undefined || params.loginId === null) return;

    const completion: CodexAppServerLoginCompletion = params.success
      ? { loginId: params.loginId, success: true }
      : { loginId: params.loginId, success: false };

    if (this.activeLoginId && params.loginId !== this.activeLoginId) return;
    if (this.completionWaiter?.loginId === params.loginId) {
      const waiter = this.completionWaiter;
      this.completionWaiter = undefined;
      waiter.resolve(completion);
      return;
    }
    if (this.queuedCompletions.size >= 8) {
      const oldest = this.queuedCompletions.keys().next().value as string | undefined;
      if (oldest) this.queuedCompletions.delete(oldest);
    }
    this.queuedCompletions.set(params.loginId, completion);
  }

  private request<T>(
    method: string,
    params: unknown,
    parse: (value: unknown) => T,
    options: CodexAppServerOperationOptions,
  ): Promise<T> {
    this.throwIfTerminal();
    if (options.signal?.aborted) {
      return Promise.reject(new CodexAppServerClientError('aborted'));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new CodexAppServerClientError('request_timeout'));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.cleanupPending(pending);
        reject(new CodexAppServerClientError('request_timeout'));
      }, timeoutMs);

      const abortListener = options.signal
        ? () => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            this.cleanupPending(pending);
            reject(new CodexAppServerClientError('aborted'));
          }
        : undefined;
      const pending: PendingRequest<T> = {
        method,
        parse,
        resolve,
        reject,
        timer,
        signal: options.signal,
        abortListener,
      };
      this.pending.set(id, pending as PendingRequest);
      if (abortListener) options.signal?.addEventListener('abort', abortListener, { once: true });

      try {
        this.write({ id, method, params });
      } catch {
        this.pending.delete(id);
        this.cleanupPending(pending);
        reject(new CodexAppServerClientError('transport_failed'));
      }
    });
  }

  private write(value: JsonObject): void {
    this.throwIfTerminal();
    const line = `${JSON.stringify(value)}\n`;
    this.transport.writable.write(line, (error?: Error | null) => {
      if (error) this.fail(new CodexAppServerClientError('transport_failed'));
    });
  }

  private async boundPromise<T>(
    promise: Promise<T>,
    options: CodexAppServerOperationOptions,
  ): Promise<T> {
    if (options.signal?.aborted) {
      throw new CodexAppServerClientError('aborted');
    }
    const timeoutMs = options.timeoutMs;
    if (timeoutMs === undefined && !options.signal) return promise;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new CodexAppServerClientError('request_timeout');
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
        callback();
      };
      const abortListener = options.signal
        ? () => finish(() => reject(new CodexAppServerClientError('aborted')))
        : undefined;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => finish(() => reject(new CodexAppServerClientError('request_timeout'))),
              timeoutMs,
            );
      if (abortListener) options.signal?.addEventListener('abort', abortListener, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) =>
          finish(() =>
            reject(
              error instanceof CodexAppServerClientError
                ? error
                : new CodexAppServerClientError('transport_failed'),
            ),
          ),
      );
    });
  }

  private cleanupPending<T>(pending: PendingRequest<T>): void {
    clearTimeout(pending.timer);
    if (pending.abortListener) {
      pending.signal?.removeEventListener('abort', pending.abortListener);
    }
  }

  private fail(error: CodexAppServerClientError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.completionWaiter) {
      this.completionWaiter.reject(error);
      this.completionWaiter = undefined;
    }
  }

  private throwIfTerminal(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) throw new CodexAppServerClientError('process_exited');
  }

  private detach(): void {
    this.transport.readable.off('data', this.onData);
    this.transport.readable.off('end', this.onTransportEnd);
    this.transport.readable.off('close', this.onTransportEnd);
    this.transport.readable.off('error', this.onTransportError);
    this.transport.writable.off('error', this.onTransportError);
  }
}
