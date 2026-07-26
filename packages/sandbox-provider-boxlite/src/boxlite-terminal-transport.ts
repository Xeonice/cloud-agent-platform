import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import WebSocket, { type ClientOptions } from 'ws';
import type {
  SandboxTerminalEndpointDescriptor,
  TerminalTransport,
  TerminalTransportCleanupSettlement,
  TerminalTransportFrame,
  TerminalTransportReadyState,
  TerminalTransportWriteOutcome,
} from '@cap/sandbox-core';
import { BOXLITE_TERMINAL_BYTE_BRIDGE_PATH } from './boxlite-preflight.js';

export interface BoxLiteTerminalTransportLogger {
  warn(message: string): void;
}

export interface BoxLiteTerminalTransportOptions {
  readonly apiToken?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: BoxLiteTerminalTransportLogger;
  /** Optional stricter bounds; callers may shorten but never expand defaults. */
  readonly cleanupTimeoutMs?: number;
  readonly cleanupAttemptTimeoutMs?: number;
  readonly cleanupRetryDelayMs?: number;
  /** Optional stricter bridge-ready bound; callers may shorten the hard default. */
  readonly bridgeHandshakeTimeoutMs?: number;
  /** Deterministic generation seam for protocol tests. */
  readonly bridgeGenerationFactory?: () => string;
  readonly webSocketFactory?: (
    url: string,
    options: ClientOptions,
  ) => WebSocket;
}

const STDOUT_CHANNEL = 1;
const STDERR_CHANNEL = 2;
const BRIDGE_PROTOCOL_VERSION = '1';
const BRIDGE_INITIAL_COLS = 80;
const BRIDGE_INITIAL_ROWS = 24;
const BRIDGE_OUTPUT_CHUNK_BYTES = 3_072;
const BRIDGE_INPUT_CHUNK_BYTES = 16_384;
const BRIDGE_MAX_FRAME_BYTES = 24_000;
const BRIDGE_MAX_PROVIDER_CHUNK_BYTES = 262_144;
const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;
const BRIDGE_MAX_GEOMETRY = 1_000;
const BRIDGE_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const BRIDGE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const BRIDGE_POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const BRIDGE_EXIT_CODE_PATTERN = /^(?:0|[1-9][0-9]{0,2}|-[1-9][0-9]{0,2})$/u;
const BOXLITE_EXECUTION_CLEANUP_ATTEMPTS = 3;
const BOXLITE_EXECUTION_CLEANUP_TIMEOUT_MS = 5_000;
const BOXLITE_EXECUTION_CLEANUP_ATTEMPT_TIMEOUT_MS = 750;
const BOXLITE_EXECUTION_CLEANUP_RETRY_DELAY_MS = 25;

type BoxLiteExecutionCreationOutcome =
  | { readonly kind: 'created'; readonly executionId: string }
  | { readonly kind: 'failed' };

interface BoxLiteExecutionCleanupPolicy {
  readonly timeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly retryDelayMs: number;
}

export class BoxLiteTerminalTransport implements TerminalTransport {
  readonly opaqueInputCapability = 'byte-preserving' as const;
  readonly cleanupDecision: Promise<TerminalTransportCleanupSettlement>;
  private readonly frameListeners = new Set<
    (frame: TerminalTransportFrame) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly config: BoxLiteTerminalConfig;
  private readonly cleanupPolicy: BoxLiteExecutionCleanupPolicy;
  private readonly outputDecoder = new StringDecoder('utf8');
  private readonly bridgeGeneration: string;
  private readonly bridgeHandshakeTimeoutMs: number;
  private readonly openController = new AbortController();
  private readonly executionCreationDecision: Promise<BoxLiteExecutionCreationOutcome>;
  private resolveExecutionCreationDecision!: (
    outcome: BoxLiteExecutionCreationOutcome,
  ) => void;
  private resolveCleanupDecision!: (
    settlement: TerminalTransportCleanupSettlement,
  ) => void;
  private socket: WebSocket | null = null;
  private state: TerminalTransportReadyState = 'connecting';
  private closedLatch = false;
  private closeEmitted = false;
  private executionCreationSettled = false;
  private cleanupStarted = false;
  private cleanupSettled = false;
  private errorEmitted = false;
  private bridgeReady = false;
  private bridgeExitSeen = false;
  private outputSequence = 0;
  private bridgeOutputBuffer = Buffer.alloc(0);
  private handshakeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly taskId: string,
    descriptor: SandboxTerminalEndpointDescriptor,
    private readonly options: BoxLiteTerminalTransportOptions = {},
  ) {
    this.config = readBoxLiteTerminalConfig(descriptor, options);
    this.cleanupPolicy = readBoxLiteExecutionCleanupPolicy(options);
    this.bridgeGeneration = createBridgeGeneration(options);
    this.bridgeHandshakeTimeoutMs = boundedPositiveDuration(
      options.bridgeHandshakeTimeoutMs,
      BRIDGE_HANDSHAKE_TIMEOUT_MS,
    );
    this.executionCreationDecision = new Promise((resolve) => {
      this.resolveExecutionCreationDecision = resolve;
    });
    this.cleanupDecision = new Promise((resolve) => {
      this.resolveCleanupDecision = resolve;
    });
    void this.open();
  }

  get readyState(): TerminalTransportReadyState {
    if (this.closedLatch) return 'closed';
    if (!this.socket) return this.state;
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return this.bridgeReady ? 'open' : 'connecting';
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
    return this.sendBridgeInput(Buffer.from(data, 'utf8'));
  }

  sendInputBytes(data: Uint8Array): TerminalTransportWriteOutcome {
    if (
      this.closedLatch ||
      !this.socket ||
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      return 'closed';
    }
    if (this.readyState !== 'open') return 'unsupported';
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return this.sendBridgeInput(payload) ? 'written' : 'closed';
  }

  sendTerminalResponseBytes(
    data: Uint8Array,
  ): TerminalTransportWriteOutcome {
    return this.sendInputBytes(data);
  }

  sendResize(cols: number, rows: number): boolean {
    if (!isBridgeGeometry(cols, rows)) return false;
    return this.sendBridgeLine(`S ${this.bridgeGeneration} ${cols} ${rows}\n`);
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
    if (this.closedLatch) {
      this.startExecutionCleanup();
      return;
    }
    this.closedLatch = true;
    this.state = 'closed';
    this.clearHandshakeTimer();
    this.closeSocketWithEof(this.socket);
    this.startExecutionCleanup();
    this.emitCloseOnce();
  }

  private async open(): Promise<void> {
    try {
      const executionId = await this.startExecution();
      this.settleExecutionCreation({ kind: 'created', executionId });
      if (this.closedLatch) {
        this.startExecutionCleanup();
        return;
      }
      // The normalized seam needs only the establishment marker. The exact
      // native execution id remains private to this transport and cleanup.
      this.emitFrame({ type: 'session_id' });
      const ws = this.createWebSocket(this.attachUrl(executionId), {
        headers: this.authHeaders(),
      });
      this.socket = ws;
      ws.on('open', () => {
        if (this.closedLatch) {
          this.closeSocketWithEof(ws);
          return;
        }
        this.state = 'connecting';
        this.startHandshakeTimer();
      });
      ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
      ws.on('close', () => {
        const unexpectedBridgeClose =
          !this.closedLatch &&
          (!this.bridgeReady ||
            !this.bridgeExitSeen ||
            this.bridgeOutputBuffer.length > 0);
        this.clearHandshakeTimer();
        this.closedLatch = true;
        this.state = 'closed';
        this.startExecutionCleanup();
        if (unexpectedBridgeClose) {
          this.emitErrorOnce(
            new Error('BoxLite terminal byte bridge closed unexpectedly'),
          );
        }
        this.emitCloseOnce();
      });
      ws.on('error', () => {
        this.options.logger?.warn(
          `task ${this.taskId}: BoxLite terminal WebSocket failed`,
        );
        this.failBridge('BoxLite terminal WebSocket failed');
      });
    } catch {
      this.settleExecutionCreation({ kind: 'failed' });
      this.state = 'closed';
      this.startExecutionCleanup();
      if (this.closedLatch || this.openController.signal.aborted) {
        this.emitCloseOnce();
        return;
      }
      this.emitError(new Error('BoxLite terminal execution could not be opened'));
      this.emitCloseOnce();
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
          command: BOXLITE_TERMINAL_BYTE_BRIDGE_PATH,
          args: [
            '--shell',
            '--generation',
            this.bridgeGeneration,
            '--cols',
            String(BRIDGE_INITIAL_COLS),
            '--rows',
            String(BRIDGE_INITIAL_ROWS),
            '--term',
            'xterm-256color',
          ],
          working_dir: this.config.workspacePath,
          tty: true,
        }),
        signal: this.openController.signal,
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
    if (this.closedLatch) return;
    if (!isBinary) {
      this.onControlMessage(rawToBuffer(raw).toString('utf8'));
      return;
    }

    const buffer = rawToBuffer(raw);
    if (buffer.length === 0) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    const channel = buffer[0];
    const payload = buffer.subarray(1);
    switch (channel) {
      case STDOUT_CHANNEL:
        this.consumeBridgeOutput(payload);
        break;
      case STDERR_CHANNEL:
        if (payload.length > 0) {
          this.failBridge('BoxLite terminal byte bridge failed');
        }
        break;
      default:
        this.failBridge('BoxLite terminal byte bridge protocol failed');
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
      if (!this.bridgeReady || !this.bridgeExitSeen) {
        this.failBridge('BoxLite terminal byte bridge exited unexpectedly');
        return;
      }
      return;
    }
    if (frame.type === 'error') {
      // Provider-controlled messages can contain an execution id or upstream
      // URL. Keep the public error boundary useful but identity/credential-free.
      this.failBridge('BoxLite terminal control error');
    }
  }

  private consumeBridgeOutput(payload: Buffer): void {
    if (
      payload.length > BRIDGE_MAX_PROVIDER_CHUNK_BYTES ||
      !isAsciiBuffer(payload)
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    this.bridgeOutputBuffer = Buffer.concat([this.bridgeOutputBuffer, payload]);
    while (!this.closedLatch) {
      const newline = this.bridgeOutputBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > BRIDGE_MAX_FRAME_BYTES) {
        this.failBridge('BoxLite terminal byte bridge protocol failed');
        return;
      }
      const line = this.bridgeOutputBuffer.subarray(0, newline).toString('ascii');
      this.bridgeOutputBuffer = this.bridgeOutputBuffer.subarray(newline + 1);
      this.consumeBridgeLine(line);
    }
    if (this.bridgeOutputBuffer.length > BRIDGE_MAX_FRAME_BYTES) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
    }
  }

  private consumeBridgeLine(line: string): void {
    const fields = line.split(' ');
    switch (fields[0]) {
      case 'R':
        this.consumeBridgeReady(fields);
        return;
      case 'O':
        this.consumeBridgeBytes(fields);
        return;
      case 'E':
        if (fields.length !== 3) {
          this.failBridge('BoxLite terminal byte bridge protocol failed');
          return;
        }
        if (
          fields[1] !== this.bridgeGeneration ||
          !BRIDGE_REASON_PATTERN.test(fields[2]!)
        ) {
          this.failBridge('BoxLite terminal byte bridge protocol failed');
          return;
        }
        this.failBridge('BoxLite terminal byte bridge rejected a frame');
        return;
      case 'X':
        this.consumeBridgeExit(fields);
        return;
      default:
        this.failBridge('BoxLite terminal byte bridge protocol failed');
    }
  }

  private consumeBridgeReady(fields: string[]): void {
    if (fields.length !== 7) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    const childPid = fields[3]!;
    if (
      this.bridgeReady ||
      fields[1] !== this.bridgeGeneration ||
      fields[2] !== BRIDGE_PROTOCOL_VERSION ||
      !BRIDGE_POSITIVE_DECIMAL_PATTERN.test(childPid) ||
      !Number.isSafeInteger(Number(childPid)) ||
      fields[4] !== 'shell' ||
      fields[5] !== String(BRIDGE_INITIAL_COLS) ||
      fields[6] !== String(BRIDGE_INITIAL_ROWS)
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    this.bridgeReady = true;
    this.state = 'open';
    this.clearHandshakeTimer();
    this.emitFrame({ type: 'ready' });
  }

  private consumeBridgeBytes(fields: string[]): void {
    if (
      !this.bridgeReady ||
      this.bridgeExitSeen ||
      fields.length !== 4
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    if (
      fields[1] !== this.bridgeGeneration ||
      !BRIDGE_POSITIVE_DECIMAL_PATTERN.test(fields[2]!)
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    const sequence = Number(fields[2]);
    const payload = decodeCanonicalBridgeBase64(fields[3]!);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence !== this.outputSequence + 1 ||
      payload === null
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    this.outputSequence = sequence;
    this.emitDecodedOutput(payload);
  }

  private consumeBridgeExit(fields: string[]): void {
    if (
      !this.bridgeReady ||
      this.bridgeExitSeen ||
      fields.length !== 4
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    if (
      fields[1] !== this.bridgeGeneration ||
      !BRIDGE_REASON_PATTERN.test(fields[2]!) ||
      !BRIDGE_EXIT_CODE_PATTERN.test(fields[3]!)
    ) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    const exitCode = Number(fields[3]);
    if (exitCode < -255 || exitCode > 255) {
      this.failBridge('BoxLite terminal byte bridge protocol failed');
      return;
    }
    this.bridgeExitSeen = true;
    this.emitFrame({ type: 'exit', data: String(exitCode) });
  }

  private emitDecodedOutput(payload: Buffer): void {
    const data = this.outputDecoder.write(payload);
    this.emitFrame({
      type: 'output',
      data,
      bytes: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    });
  }

  private sendBridgeInput(payload: Buffer): boolean {
    if (this.readyState !== 'open') return false;
    for (let offset = 0; offset < payload.length; offset += BRIDGE_INPUT_CHUNK_BYTES) {
      const chunk = payload.subarray(
        offset,
        Math.min(offset + BRIDGE_INPUT_CHUNK_BYTES, payload.length),
      );
      if (
        !this.sendBridgeLine(
          `I ${this.bridgeGeneration} ${chunk.toString('base64')}\n`,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private sendBridgeLine(line: string): boolean {
    if (
      !this.bridgeReady ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    this.socket.send(Buffer.from(line, 'ascii'));
    return true;
  }

  private createWebSocket(
    url: string,
    options: ClientOptions,
  ): WebSocket {
    return this.options.webSocketFactory?.(url, options) ?? new WebSocket(url, options);
  }

  private closeSocketWithEof(socket: WebSocket | null): void {
    if (!socket) return;
    const closeOpenSocket = (): void => {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          if (this.bridgeReady && !this.bridgeExitSeen) {
            socket.send(Buffer.from(`C ${this.bridgeGeneration}\n`, 'ascii'));
          }
          socket.send(JSON.stringify({ type: 'stdin_eof' }));
        }
        socket.close();
      } catch {
        try {
          socket.terminate();
        } catch {
          // Best-effort exact-execution cleanup.
        }
      }
    };
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.once('open', closeOpenSocket);
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          // Best-effort exact-execution cleanup.
        }
      }, 2_000);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
      socket.once('error', () => clearTimeout(timer));
      return;
    }
    closeOpenSocket();
  }

  private startHandshakeTimer(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.failBridge('BoxLite terminal byte bridge readiness timed out');
    }, this.bridgeHandshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private failBridge(message: string): void {
    if (this.closedLatch) return;
    this.closedLatch = true;
    this.state = 'closed';
    this.clearHandshakeTimer();
    this.emitErrorOnce(new Error(message));
    this.closeSocketWithEof(this.socket);
    this.startExecutionCleanup();
    this.emitCloseOnce();
  }

  /**
   * Cleanup is deliberately provider-execution scoped. Closing the attach socket
   * is not evidence: BoxLite retains that execution after WS disconnect, so the
   * decision settles only after exact DELETE followed by GET=404 confirmation.
   */
  private startExecutionCleanup(): void {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    void this.cleanupExactExecution().then(
      (settlement) => this.settleCleanup(settlement),
      () => this.settleCleanup(this.indeterminateCleanup('cleanup-unconfirmed')),
    );
  }

  private async cleanupExactExecution(): Promise<TerminalTransportCleanupSettlement> {
    const deadline = Date.now() + this.cleanupPolicy.timeoutMs;
    const creation = await waitForPromiseBeforeDeadline(
      this.executionCreationDecision,
      deadline,
    );
    if (!creation || creation.kind === 'failed') {
      this.openController.abort();
      return this.indeterminateCleanup('identity-unavailable', 0);
    }

    const executionId = creation.executionId;
    let deleteConfirmed = false;
    for (
      let attempt = 1;
      attempt <= BOXLITE_EXECUTION_CLEANUP_ATTEMPTS && Date.now() < deadline;
      attempt += 1
    ) {
      const deletion = await this.fetchExecutionCleanup(
        executionId,
        'DELETE',
        deadline,
      );
      if (deletion?.status === 204 || deletion?.status === 404) {
        if (deletion.status === 204) deleteConfirmed = true;
        const confirmation = await this.fetchExecutionCleanup(
          executionId,
          'GET',
          deadline,
        );
        if (confirmation?.status === 404) {
          this.openController.abort();
          return {
            kind: 'confirmed',
            expectedIdentities: 1,
            observedIdentities: 1,
            confirmedIdentities: 1,
            deletedIdentities: deleteConfirmed ? 1 : 0,
            alreadyAbsentIdentities: deleteConfirmed ? 0 : 1,
            cause: null,
          };
        }
      }
      if (attempt < BOXLITE_EXECUTION_CLEANUP_ATTEMPTS) {
        await delayBeforeDeadline(
          this.cleanupPolicy.retryDelayMs * attempt,
          deadline,
        );
      }
    }
    this.openController.abort();
    return this.indeterminateCleanup('cleanup-unconfirmed', 1);
  }

  private fetchExecutionCleanup(
    executionId: string,
    method: 'DELETE' | 'GET',
    deadline: number,
  ): Promise<Response | null> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.resolve(null);
    const timeoutMs = Math.min(
      remainingMs,
      this.cleanupPolicy.attemptTimeoutMs,
    );
    const controller = new AbortController();
    const fetchImpl = this.options.fetch ?? fetch;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (response: Response | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      const timer = setTimeout(() => {
        controller.abort();
        settle(null);
      }, timeoutMs);
      void Promise.resolve()
        .then(() =>
          fetchImpl(this.executionUrl(executionId), {
            method,
            headers: {
              accept: 'application/json',
              ...this.authHeaders(),
            },
            signal: controller.signal,
          }),
        )
        .then(
          (response) => settle(response),
          () => settle(null),
        );
    });
  }

  private settleExecutionCreation(outcome: BoxLiteExecutionCreationOutcome): void {
    if (this.executionCreationSettled) return;
    this.executionCreationSettled = true;
    this.resolveExecutionCreationDecision(outcome);
  }

  private settleCleanup(settlement: TerminalTransportCleanupSettlement): void {
    if (this.cleanupSettled) return;
    this.cleanupSettled = true;
    this.resolveCleanupDecision(settlement);
  }

  private indeterminateCleanup(
    cause: Extract<
      TerminalTransportCleanupSettlement,
      { kind: 'indeterminate' }
    >['cause'],
    observedIdentities = 0,
  ): TerminalTransportCleanupSettlement {
    return {
      kind: 'indeterminate',
      expectedIdentities: 1,
      observedIdentities,
      confirmedIdentities: 0,
      deletedIdentities: 0,
      alreadyAbsentIdentities: 0,
      cause,
    };
  }

  private emitCloseOnce(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }

  private attachUrl(executionId: string): string {
    return `${this.config.wsBaseUrl}${this.boxPath()}/executions/${encodeURIComponent(executionId)}/attach`;
  }

  private executionUrl(executionId: string): string {
    return `${this.config.httpBaseUrl}${this.boxPath()}/executions/${encodeURIComponent(executionId)}`;
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

  private emitErrorOnce(error: Error): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    this.emitError(error);
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
  readonly cleanupTimeoutMs?: number;
  readonly cleanupAttemptTimeoutMs?: number;
  readonly cleanupRetryDelayMs?: number;
  readonly bridgeHandshakeTimeoutMs?: number;
  readonly bridgeGenerationFactory?: () => string;
  readonly webSocketFactory?: BoxLiteTerminalTransportOptions['webSocketFactory'];
}): { open(): TerminalTransport } {
  return {
    open: () =>
      new BoxLiteTerminalTransport(args.taskId, args.descriptor, {
        apiToken: args.apiToken,
        fetch: args.fetch,
        logger: args.logger,
        cleanupTimeoutMs: args.cleanupTimeoutMs,
        cleanupAttemptTimeoutMs: args.cleanupAttemptTimeoutMs,
        cleanupRetryDelayMs: args.cleanupRetryDelayMs,
        bridgeHandshakeTimeoutMs: args.bridgeHandshakeTimeoutMs,
        bridgeGenerationFactory: args.bridgeGenerationFactory,
        webSocketFactory: args.webSocketFactory,
      }),
  };
}

function readBoxLiteExecutionCleanupPolicy(
  options: BoxLiteTerminalTransportOptions,
): BoxLiteExecutionCleanupPolicy {
  return {
    timeoutMs: boundedPositiveDuration(
      options.cleanupTimeoutMs,
      BOXLITE_EXECUTION_CLEANUP_TIMEOUT_MS,
    ),
    attemptTimeoutMs: boundedPositiveDuration(
      options.cleanupAttemptTimeoutMs,
      BOXLITE_EXECUTION_CLEANUP_ATTEMPT_TIMEOUT_MS,
    ),
    retryDelayMs: boundedNonNegativeDuration(
      options.cleanupRetryDelayMs,
      BOXLITE_EXECUTION_CLEANUP_RETRY_DELAY_MS,
    ),
  };
}

function boundedPositiveDuration(value: number | undefined, maximum: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return maximum;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function boundedNonNegativeDuration(
  value: number | undefined,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return maximum;
  return Math.min(maximum, Math.floor(value));
}

function waitForPromiseBeforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T | null> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    void promise.then(
      (value) => settle(value),
      () => settle(null),
    );
  });
}

function delayBeforeDeadline(delayMs: number, deadline: number): Promise<void> {
  const boundedDelayMs = Math.max(0, Math.min(delayMs, deadline - Date.now()));
  if (boundedDelayMs === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, boundedDelayMs));
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

function createBridgeGeneration(
  options: BoxLiteTerminalTransportOptions,
): string {
  const generation =
    options.bridgeGenerationFactory?.() ?? randomBytes(16).toString('hex');
  if (!BRIDGE_GENERATION_PATTERN.test(generation)) {
    throw new Error('BoxLite terminal byte bridge generation was invalid');
  }
  return generation;
}

function isAsciiBuffer(payload: Buffer): boolean {
  for (const byte of payload) {
    if (byte > 0x7f) return false;
  }
  return true;
}

function decodeCanonicalBridgeBase64(token: string): Buffer | null {
  if (
    token.length === 0 ||
    token.length > Math.ceil(BRIDGE_OUTPUT_CHUNK_BYTES / 3) * 4 ||
    token.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      token,
    )
  ) {
    return null;
  }
  const payload = Buffer.from(token, 'base64');
  if (payload.toString('base64') !== token) {
    return null;
  }
  return payload;
}

function isBridgeGeometry(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= BRIDGE_MAX_GEOMETRY &&
    rows <= BRIDGE_MAX_GEOMETRY
  );
}

export const BOXLITE_TERMINAL_CHANNELS = {
  stdout: STDOUT_CHANNEL,
  stderr: STDERR_CHANNEL,
} as const;
