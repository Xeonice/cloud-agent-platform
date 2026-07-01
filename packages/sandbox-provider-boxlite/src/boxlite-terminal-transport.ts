import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import type {
  SandboxTerminalEndpointDescriptor,
  TerminalTransport,
  TerminalTransportFrame,
  TerminalTransportReadyState,
} from '@cap/sandbox-core';

export interface BoxLiteTerminalTransportLogger {
  warn(message: string): void;
}

export interface BoxLiteTerminalTransportOptions {
  readonly apiToken?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: BoxLiteTerminalTransportLogger;
}

const STDOUT_CHANNEL = 1;
const STDERR_CHANNEL = 2;

export class BoxLiteTerminalTransport implements TerminalTransport {
  private readonly frameListeners = new Set<
    (frame: TerminalTransportFrame) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly config: BoxLiteTerminalConfig;
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private socket: WebSocket | null = null;
  private state: TerminalTransportReadyState = 'connecting';

  constructor(
    private readonly taskId: string,
    descriptor: SandboxTerminalEndpointDescriptor,
    private readonly options: BoxLiteTerminalTransportOptions = {},
  ) {
    this.config = readBoxLiteTerminalConfig(descriptor, options);
    void this.open();
  }

  get readyState(): TerminalTransportReadyState {
    if (!this.socket) return this.state;
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CLOSING:
        return 'closing';
      default:
        return 'closed';
    }
  }

  onFrame(listener: (frame: TerminalTransportFrame) => void): { dispose(): void } {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }

  onClose(listener: () => void): { dispose(): void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void): { dispose(): void } {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  sendInput(data: string): boolean {
    return this.sendBinary(Buffer.from(data, 'utf8'));
  }

  sendResize(cols: number, rows: number): boolean {
    return this.sendControl({ type: 'resize', cols, rows });
  }

  sendPong(_timestamp: number): boolean {
    return true;
  }

  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }

  close(): void {
    this.sendControl({ type: 'stdin_eof' });
    try {
      this.socket?.close();
    } catch {
      // Best-effort; closed sockets may throw on close.
    }
  }

  private async open(): Promise<void> {
    try {
      const executionId = await this.startExecution();
      this.emitFrame({ type: 'session_id', data: executionId });
      const ws = new WebSocket(this.attachUrl(executionId), {
        headers: this.authHeaders(),
      });
      this.socket = ws;
      ws.on('open', () => {
        this.state = 'open';
        this.emitFrame({ type: 'ready' });
      });
      ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
      ws.on('close', () => {
        this.flushOutputDecoders();
        this.state = 'closed';
        for (const listener of this.closeListeners) listener();
      });
      ws.on('error', (error) => {
      this.options.logger?.warn(
        `task ${this.taskId}: BoxLite terminal WS error: ${error.message}`,
      );
        this.emitError(error);
      });
    } catch (err) {
      this.state = 'closed';
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      for (const listener of this.closeListeners) listener();
    }
  }

  private async startExecution(): Promise<string> {
    const fetchImpl = this.options.fetch ?? fetch;
    const res = await fetchImpl(
      `${this.config.httpBaseUrl}${this.boxPath()}/exec`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          command: 'sh',
          args: [
            '-lc',
            [
              'export TERM=xterm-256color',
              `cd ${shellQuote(this.config.workspacePath)}`,
              'exec bash -l',
            ].join(' && '),
          ],
          working_dir: this.config.workspacePath,
          tty: true,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`BoxLite terminal exec failed: HTTP ${res.status}`);
    }
    const raw = await res.json().catch(() => undefined);
    const executionId = parseExecutionId(raw);
    if (!executionId) {
      throw new Error('BoxLite terminal exec response missing execution id');
    }
    return executionId;
  }

  private onMessage(raw: WebSocket.RawData, isBinary: boolean): void {
    if (!isBinary) {
      this.onControlMessage(rawToBuffer(raw).toString('utf8'));
      return;
    }

    const buffer = rawToBuffer(raw);
    if (buffer.length === 0) return;
    const channel = buffer[0];
    const payload = buffer.subarray(1);
    switch (channel) {
      case STDOUT_CHANNEL:
        this.emitDecodedOutput(this.stdoutDecoder, payload);
        break;
      case STDERR_CHANNEL:
        this.emitDecodedOutput(this.stderrDecoder, payload);
        break;
      default:
        break;
    }
  }

  private onControlMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const frame = parsed as { type?: unknown; exit_code?: unknown; message?: unknown };
    if (frame.type === 'exit') {
      this.flushOutputDecoders();
      this.emitFrame({
        type: 'exit',
        data:
          typeof frame.exit_code === 'number'
            ? String(frame.exit_code)
            : '',
      });
      return;
    }
    if (frame.type === 'error') {
      this.emitError(
        new Error(
          typeof frame.message === 'string'
            ? frame.message
            : 'BoxLite terminal control error',
        ),
      );
    }
  }

  private emitDecodedOutput(decoder: StringDecoder, payload: Buffer): void {
    const data = decoder.write(payload);
    if (data.length > 0) {
      this.emitFrame({ type: 'output', data });
    }
  }

  private flushOutputDecoders(): void {
    const stdout = this.stdoutDecoder.end();
    if (stdout.length > 0) {
      this.emitFrame({ type: 'output', data: stdout });
    }
    const stderr = this.stderrDecoder.end();
    if (stderr.length > 0) {
      this.emitFrame({ type: 'output', data: stderr });
    }
  }

  private sendBinary(payload: Buffer): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(payload);
    return true;
  }

  private sendControl(frame: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private attachUrl(executionId: string): string {
    return `${this.config.wsBaseUrl}${this.boxPath()}/executions/${encodeURIComponent(executionId)}/attach`;
  }

  private boxPath(): string {
    return `${this.apiPath()}/boxes/${encodeURIComponent(this.config.sandboxId)}`;
  }

  private apiPath(): string {
    return this.config.pathPrefix ? `/v1/${this.config.pathPrefix}` : '/v1';
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiToken
      ? { authorization: `Bearer ${this.config.apiToken}` }
      : {};
  }

  private emitFrame(frame: TerminalTransportFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface BoxLiteTerminalConfig {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly apiToken?: string;
  readonly sandboxId: string;
  readonly pathPrefix: string;
  readonly workspacePath: string;
}

function readBoxLiteTerminalConfig(
  descriptor: SandboxTerminalEndpointDescriptor,
  options: BoxLiteTerminalTransportOptions = {},
): BoxLiteTerminalConfig {
  const metadata = descriptor.metadata ?? {};
  const endpoint = requiredString(metadata.endpoint, 'endpoint');
  const sandboxId = requiredString(metadata.sandboxId, 'sandboxId');
  const pathPrefix =
    typeof metadata.pathPrefix === 'string'
      ? normalizePathPrefix(metadata.pathPrefix)
      : 'default';
  return {
    httpBaseUrl: endpoint.replace(/\/+$/, ''),
    wsBaseUrl: (descriptor.wsUrl ?? endpoint)
      .replace(/^http/i, 'ws')
      .replace(/\/+$/, ''),
    apiToken: options.apiToken ?? process.env.BOXLITE_API_TOKEN,
    sandboxId,
    pathPrefix,
    workspacePath:
      typeof metadata.workspacePath === 'string' ? metadata.workspacePath : '/workspace',
  };
}

export function createBoxLiteTerminalTransportFactory(args: {
  readonly taskId: string;
  readonly descriptor: SandboxTerminalEndpointDescriptor;
  readonly apiToken?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: BoxLiteTerminalTransportLogger;
}): { open(): TerminalTransport } {
  return {
    open: () =>
      new BoxLiteTerminalTransport(args.taskId, args.descriptor, {
        apiToken: args.apiToken,
        fetch: args.fetch,
        logger: args.logger,
      }),
  };
}

function parseExecutionId(raw: unknown): string | null {
  const value =
    raw && typeof raw === 'object' && 'data' in raw
      ? (raw as { readonly data?: unknown }).data
      : raw;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.execution_id === 'string'
    ? record.execution_id
    : typeof record.id === 'string'
      ? record.id
      : null;
}

function requiredString(raw: unknown, label: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  throw new Error(`BoxLite terminal descriptor missing ${label}`);
}

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function rawToBuffer(raw: WebSocket.RawData): Buffer {
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const BOXLITE_TERMINAL_CHANNELS = {
  stdout: STDOUT_CHANNEL,
  stderr: STDERR_CHANNEL,
} as const;
