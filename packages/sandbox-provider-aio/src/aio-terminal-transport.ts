import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type {
  TerminalOpaqueInputCapability,
  TerminalTransport,
  TerminalTransportCleanupSettlement,
  TerminalTransportFrame,
  TerminalTransportReadyState,
  TerminalTransportWriteOutcome,
} from '@cap/sandbox-core';
import {
  deleteAioShellSessionExact,
  type AioShellFetch,
  type AioShellSessionCleanupProof,
} from './aio-shell-exec.js';
import {
  buildAioTerminalGuestIdentityProbe,
  buildAioTerminalOwnershipRegistrationShell,
  createAioTerminalOwnershipRecord,
  deleteAioTerminalOwnershipRecordFilesExact,
  isCompleteAioTerminalOwnershipScope,
  isCanonicalAioTerminalProviderSessionId,
  parseAioTerminalGuestIdentity,
  releaseAioTerminalGuestPairExact,
  type AioTerminalGuestPairReleaser,
  type AioTerminalGuestProcessFingerprint,
  type AioTerminalOwnershipRecord,
  type AioTerminalOwnershipPair,
  type AioTerminalOwnershipScope,
  type AioTerminalReconnectSocketFactory,
} from './aio-terminal-session-ownership.js';

export interface AioTerminalTransportLogger {
  warn(message: string): void;
}

export interface AioTerminalTransportOptions {
  readonly logger?: AioTerminalTransportLogger;
  /** REST endpoint used only for exact provider-session cleanup after close. */
  readonly baseUrl?: string;
  readonly fetch?: AioShellFetch;
  /** Optional stricter timing seams; the shared helper clamps them to hard maxima. */
  readonly cleanupAttemptTimeoutMs?: number;
  readonly cleanupRetryDelayMs?: number;
  readonly exactReleaseTimeoutMs?: number;
  readonly reconnectOutputMaxBytes?: number;
  readonly reconnectSocketFactory?: AioTerminalReconnectSocketFactory;
  /** Dependency seam used by provider conformance tests and alternate clients. */
  readonly guestPairReleaser?: AioTerminalGuestPairReleaser;
  /** Exact persisted task/resource owner used by SIGKILL recovery journaling. */
  readonly ownershipScope?: AioTerminalOwnershipScope;
  /** Stable within one API process; defaults to the provider module singleton. */
  readonly processFingerprint?: string;
  /** Deterministic encryption seam for ownership-journal tests only. */
  readonly ownershipIvFactory?: (role: 'pair') => Uint8Array;
  /**
   * Enables the independently identified injector/management socket. Browser
   * viewers use it for byte-preserving input; the task owner also uses it so
   * close can detach only that transport's exact tmux client.
   */
  readonly enableOpaqueInput?: boolean;
  readonly socketFactory?: (
    wsUrl: string,
    role: AioTerminalSocketRole,
  ) => AioTerminalWebSocket;
  /** Hard bound for the two-session identity and injector-loop handshake. */
  readonly handshakeTimeoutMs?: number;
  /** Deterministic seam for marker/fragmentation tests. */
  readonly markerFactory?: (role: AioTerminalMarkerRole) => string;
}

export type AioTerminalSocketRole = 'main' | 'injector';
export type AioTerminalMarkerRole =
  | AioTerminalSocketRole
  | 'loop'
  | 'ownership';

export interface AioTerminalWebSocket {
  readonly readyState: number;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string, callback?: (error?: Error) => void): void;
  pause(): void;
  resume(): void;
  close(): void;
}

interface AioTerminalEndpoint {
  readonly role: AioTerminalSocketRole;
  readonly socket: AioTerminalWebSocket;
  readonly identityMarker: string;
  providerReady: boolean;
  identityProbeSent: boolean;
  sessionFrame?: TerminalTransportFrame;
  readyFrame?: TerminalTransportFrame;
  shellReady: boolean;
  shellTty?: string;
  guestFingerprint?: AioTerminalGuestProcessFingerprint;
  handshakeBuffer: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 30_000;
// Creating the temporary REST shell, running the exact journal rm, and
// proving that temporary shell was deleted is one cleanup transaction. Real
// AIO hosts can take longer than the ownership module's 1.5s request default,
// so graceful transport shutdown uses that module's existing hard maximum.
const OWNERSHIP_RECORD_CLEANUP_TIMEOUT_MS = 5_000;
const OWNERSHIP_RECORD_CLEANUP_COALESCE_MS = 25;
const MAX_HANDSHAKE_BUFFER_CHARS = 16_384;
const MAX_PROVIDER_SESSION_ID_CHARS = 512;
const OPAQUE_INPUT_CHUNK_BYTES = 256;
const SAFE_TMUX_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const SAFE_MARKER_NONCE_PATTERN = /^[A-Za-z0-9]{8,64}$/u;

interface AioOwnershipRecordCleanupBatch {
  readonly paths: Set<string>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  accepting: boolean;
}

// Weakly partition by the actual fetch implementation (and therefore its
// sandbox/auth context). The inner key is a digest so endpoint credentials and
// task identifiers are never retained in process-global map keys.
const ownershipRecordCleanupBatches = new WeakMap<
  AioShellFetch,
  Map<string, AioOwnershipRecordCleanupBatch>
>();

export class AioTerminalTransport implements TerminalTransport {
  readonly cleanupDecision: Promise<TerminalTransportCleanupSettlement>;
  private readonly frameListeners = new Set<
    (frame: TerminalTransportFrame) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly main: AioTerminalEndpoint;
  private readonly injector?: AioTerminalEndpoint;
  private readonly opaqueInputEnabled: boolean;
  private readonly exactTaskPaneTarget: string;
  private readonly loopReadyMarker: string;
  private readonly loopFailureMarker: string;
  private readonly loopReleaseMarker: string;
  private readonly injectorCloseToken: string;
  private readonly ownershipReadyMarker: string;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private generation = 1;
  private closed = false;
  private closeEmitted = false;
  private errorEmitted = false;
  private compositeReady = false;
  private injectorLoopCommandSent = false;
  private injectorLoopReady = false;
  private ownershipRegistrationSent = false;
  private ownershipRegistrationReady = false;
  private cleanupPair?: AioTerminalOwnershipPair;
  private ownershipRecordPath?: string;
  private cleanupStarted = false;
  private readonly settleCleanupDecision: (
    settlement: TerminalTransportCleanupSettlement,
  ) => void;

  constructor(
    private readonly taskId: string,
    private readonly wsUrl: string,
    private readonly options: AioTerminalTransportOptions = {},
  ) {
    const cleanupDecision = createDeferred<TerminalTransportCleanupSettlement>();
    this.cleanupDecision = cleanupDecision.promise;
    this.settleCleanupDecision = cleanupDecision.resolve;
    this.exactTaskPaneTarget = buildExactTaskPaneTarget(taskId);
    this.opaqueInputEnabled = options.enableOpaqueInput === true;
    if (
      options.ownershipScope !== undefined &&
      !isCompleteAioTerminalOwnershipScope(options.ownershipScope, taskId)
    ) {
      throw new Error('AIO terminal ownership scope was invalid');
    }

    if (!this.opaqueInputEnabled) {
      let mainSocket: AioTerminalWebSocket;
      try {
        mainSocket = this.createSocket('main');
      } catch {
        throw new Error('AIO terminal main WebSocket could not be opened');
      }
      this.loopReadyMarker = '';
      this.loopFailureMarker = '';
      this.loopReleaseMarker = '';
      this.injectorCloseToken = '';
      this.ownershipReadyMarker = '';
      this.main = {
        role: 'main',
        socket: mainSocket,
        identityMarker: '',
        providerReady: false,
        identityProbeSent: false,
        shellReady: true,
        handshakeBuffer: '',
      };
      this.bindLegacyMain(this.main);
      return;
    }

    const mainNonce = createMarkerNonce(options, 'main');
    const injectorNonce = createMarkerNonce(options, 'injector');
    const loopNonce = createMarkerNonce(options, 'loop');
    const ownershipNonce = createMarkerNonce(options, 'ownership');
    this.loopReadyMarker = `CAP_AIO_INJECTOR_READY_${loopNonce}`;
    this.loopFailureMarker = `CAP_AIO_INJECTOR_FAILED_${loopNonce}`;
    this.loopReleaseMarker = `CAP_AIO_INJECTOR_RELEASED_${loopNonce}`;
    this.injectorCloseToken = `: CAP_AIO_INJECTOR_CLOSE_${loopNonce}`;
    this.ownershipReadyMarker =
      `CAP_AIO_OWNERSHIP_READY_${ownershipNonce}`;

    let mainSocket: AioTerminalWebSocket;
    try {
      mainSocket = this.createSocket('main');
    } catch {
      throw new Error('AIO terminal main WebSocket could not be opened');
    }

    let injectorSocket: AioTerminalWebSocket;
    try {
      injectorSocket = this.createSocket('injector');
    } catch {
      bestEffortCloseSocket(mainSocket);
      throw new Error('AIO terminal injector WebSocket could not be opened');
    }

    this.main = {
      role: 'main',
      socket: mainSocket,
      identityMarker: `CAP_AIO_MAIN_SHELL_READY_${mainNonce}`,
      providerReady: false,
      identityProbeSent: false,
      shellReady: false,
      handshakeBuffer: '',
    };
    this.injector = {
      role: 'injector',
      socket: injectorSocket,
      identityMarker: `CAP_AIO_INJECTOR_SHELL_READY_${injectorNonce}`,
      providerReady: false,
      identityProbeSent: false,
      shellReady: false,
      handshakeBuffer: '',
    };

    const generation = this.generation;
    this.bindEndpoint(this.main, generation);
    this.bindEndpoint(this.requireInjector(), generation);
    this.startHandshakeTimer(generation);
  }

  get readyState(): TerminalTransportReadyState {
    if (!this.opaqueInputEnabled) {
      return normalizeAioWebSocketReadyState(this.main.socket.readyState);
    }
    if (this.closed) return 'closed';
    const mainState = normalizeAioWebSocketReadyState(
      this.main.socket.readyState,
    );
    const injectorState = normalizeAioWebSocketReadyState(
      this.requireInjector().socket.readyState,
    );
    if (mainState === 'closed' || injectorState === 'closed') return 'closed';
    if (mainState === 'closing' || injectorState === 'closing') return 'closing';
    return this.compositeReady && mainState === 'open' && injectorState === 'open'
      ? 'open'
      : 'connecting';
  }

  /**
   * This capability is deliberately input-only. AIO's native JSON `output.data`
   * remains a UTF-8 terminal text stream and cannot preserve arbitrary PTY bytes
   * such as standalone 0x80/0xff. The independent injector avoids putting raw
   * input bytes in JSON; it does not make the AIO output wire binary-safe.
   */
  get opaqueInputCapability(): TerminalOpaqueInputCapability {
    return this.opaqueInputEnabled &&
      this.compositeReady &&
      this.areBothSocketsOpen()
      ? 'byte-preserving'
      : 'unsupported';
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
    if (this.main.socket.readyState !== WebSocket.OPEN) return false;
    if (this.opaqueInputEnabled && this.readyState !== 'open') return false;
    return this.sendJson(this.main.socket, { type: 'input', data });
  }

  sendInputBytes(data: Uint8Array): TerminalTransportWriteOutcome {
    if (!this.opaqueInputEnabled) {
      return this.main.socket.readyState === WebSocket.OPEN
        ? 'unsupported'
        : 'closed';
    }
    if (this.closed || this.hasClosedOpaqueInputSocket()) return 'closed';
    if (
      !this.areBothSocketsOpen() ||
      !this.compositeReady ||
      !this.injectorLoopReady
    ) {
      return 'unsupported';
    }

    // Only canonical lowercase ASCII hex crosses aio-json-v1. The injector's
    // already-confirmed shell loop converts each bounded token back to one byte
    // with `tmux send-keys -H` against the exact task pane target. WebSocket send
    // order therefore remains the input order without a UTF-8 byte round trip.
    for (let offset = 0; offset < data.byteLength; offset += OPAQUE_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + OPAQUE_INPUT_CHUNK_BYTES, data.byteLength);
      const line = encodeCanonicalHexLine(data, offset, end);
      if (
        !this.sendJson(this.requireInjector().socket, {
          type: 'input',
          data: `${line}\n`,
        })
      ) {
        return 'closed';
      }
    }
    return 'written';
  }

  sendTerminalResponseBytes(
    data: Uint8Array,
  ): TerminalTransportWriteOutcome {
    // xterm query responses are a 7-bit terminal protocol stream. Keeping this
    // path ASCII-only makes the AIO JSON string representation byte-exact; all
    // arbitrary operator bytes continue through the independently identified
    // injector instead of being relabelled as terminal responses.
    if (!isAsciiBytes(data)) return 'unsupported';
    if (this.closed) return 'closed';
    const mainState = normalizeAioWebSocketReadyState(
      this.main.socket.readyState,
    );
    if (mainState === 'closed' || mainState === 'closing') return 'closed';
    if (
      mainState !== 'open' ||
      (this.opaqueInputEnabled && this.readyState !== 'open')
    ) {
      return 'unsupported';
    }
    const response = Buffer.from(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).toString('ascii');
    return this.sendJson(this.main.socket, { type: 'input', data: response })
      ? 'written'
      : 'closed';
  }

  sendResize(cols: number, rows: number): boolean {
    if (this.main.socket.readyState !== WebSocket.OPEN) return false;
    if (this.opaqueInputEnabled && this.readyState !== 'open') return false;
    return this.sendJson(this.main.socket, {
      type: 'resize',
      data: { cols, rows },
    });
  }

  sendPong(timestamp: number): boolean {
    if (this.main.socket.readyState !== WebSocket.OPEN) return false;
    if (this.opaqueInputEnabled && this.readyState !== 'open') return false;
    return this.sendJson(this.main.socket, { type: 'pong', timestamp });
  }

  pause(): void {
    try {
      this.main.socket.pause();
    } catch {
      // Viewer-local backpressure is best-effort after a concurrent close.
    }
  }

  resume(): void {
    try {
      this.main.socket.resume();
    } catch {
      // Viewer-local backpressure is best-effort after a concurrent close.
    }
  }

  close(): void {
    this.shutdown();
  }

  private createSocket(role: AioTerminalSocketRole): AioTerminalWebSocket {
    return (
      this.options.socketFactory?.(this.wsUrl, role) ?? new WebSocket(this.wsUrl)
    );
  }

  private bindEndpoint(
    endpoint: AioTerminalEndpoint,
    generation: number,
  ): void {
    endpoint.socket.on('message', (raw) => {
      if (!this.isCurrent(generation)) return;
      const frame = parseAioFrame(raw);
      if (!frame) return;
      this.onEndpointFrame(endpoint, frame);
    });
    endpoint.socket.on('close', () => {
      if (!this.isCurrent(generation)) return;
      this.fail(
        new Error(`AIO terminal ${endpoint.role} WebSocket closed unexpectedly`),
      );
    });
    endpoint.socket.on('error', () => {
      if (!this.isCurrent(generation)) return;
      this.fail(new Error(`AIO terminal ${endpoint.role} WebSocket failed`));
    });
  }

  private bindLegacyMain(endpoint: AioTerminalEndpoint): void {
    const generation = this.generation;
    endpoint.socket.on('message', (raw) => {
      if (!this.isCurrent(generation)) return;
      const frame = parseAioFrame(raw);
      if (!frame) return;
      if (
        frame.type === 'session_id' &&
        !this.recordProviderSessionId(endpoint, frame)
      ) {
        return;
      }
      this.emitFrame(frame);
    });
    endpoint.socket.on('close', () => {
      if (!this.isCurrent(generation)) return;
      this.shutdown();
    });
    endpoint.socket.on('error', () => {
      if (!this.isCurrent(generation)) return;
      const error = new Error('AIO terminal main WebSocket failed');
      this.options.logger?.warn(`task ${this.taskId}: ${error.message}`);
      for (const listener of this.errorListeners) listener(error);
    });
  }

  private onEndpointFrame(
    endpoint: AioTerminalEndpoint,
    frame: TerminalTransportFrame,
  ): void {
    switch (frame.type) {
      case 'session_id':
        this.onProviderSessionId(endpoint, frame);
        return;
      case 'ready':
        endpoint.providerReady = true;
        endpoint.readyFrame = frame;
        this.maybeStartIdentityProbe(endpoint);
        return;
      case 'output':
        if (typeof frame.data !== 'string') {
          this.fail(
            new Error(`AIO terminal ${endpoint.role} output was not UTF-8 text`),
          );
          return;
        }
        if (endpoint === this.main && this.compositeReady) {
          this.emitFrame(frame);
          return;
        }
        this.observeHandshakeOutput(endpoint, frame.data);
        return;
      case 'ping':
        if (endpoint === this.main && this.compositeReady) {
          this.emitFrame(frame);
          return;
        }
        this.sendInternalPong(endpoint, frame);
        return;
      case 'error':
        this.fail(new Error(`AIO terminal ${endpoint.role} protocol failed`));
        return;
      default:
        if (endpoint === this.main && this.compositeReady) this.emitFrame(frame);
    }
  }

  private onProviderSessionId(
    endpoint: AioTerminalEndpoint,
    frame: TerminalTransportFrame,
  ): void {
    if (!this.recordProviderSessionId(endpoint, frame)) return;
    this.maybeStartIdentityProbe(endpoint);
  }

  private recordProviderSessionId(
    endpoint: AioTerminalEndpoint,
    frame: TerminalTransportFrame,
  ): boolean {
    if (
      typeof frame.data !== 'string' ||
      frame.data.length === 0 ||
      frame.data.length > MAX_PROVIDER_SESSION_ID_CHARS ||
      (this.opaqueInputEnabled &&
        !isCanonicalAioTerminalProviderSessionId(frame.data))
    ) {
      this.fail(
        new Error(`AIO terminal ${endpoint.role} session identity was invalid`),
      );
      return false;
    }
    if (endpoint.sessionFrame && endpoint.sessionFrame.data !== frame.data) {
      this.fail(
        new Error(`AIO terminal ${endpoint.role} session identity changed`),
      );
      return false;
    }
    const peer = endpoint === this.main ? this.injector : this.main;
    if (
      this.opaqueInputEnabled &&
      typeof peer?.sessionFrame?.data === 'string' &&
      peer.sessionFrame.data.slice(0, 8) === frame.data.slice(0, 8)
    ) {
      this.fail(
        new Error(
          'AIO terminal sockets did not have distinct session identities',
        ),
      );
      return false;
    }
    endpoint.sessionFrame = frame;
    return true;
  }

  private maybeStartIdentityProbe(endpoint: AioTerminalEndpoint): void {
    if (
      this.closed ||
      endpoint.identityProbeSent ||
      !endpoint.providerReady ||
      !endpoint.sessionFrame
    ) {
      return;
    }
    endpoint.identityProbeSent = true;
    let command: string;
    try {
      command = buildAioTerminalGuestIdentityProbe(endpoint.identityMarker);
    } catch {
      this.fail(new Error('AIO terminal identity probe could not be built'));
      return;
    }
    if (command.includes(endpoint.identityMarker)) {
      this.fail(new Error('AIO terminal identity marker was not echo-safe'));
      return;
    }
    this.sendJson(endpoint.socket, {
      type: 'input',
      data: `${command}\n`,
    });
  }

  private observeHandshakeOutput(
    endpoint: AioTerminalEndpoint,
    text: string,
  ): void {
    endpoint.handshakeBuffer = appendBounded(
      endpoint.handshakeBuffer,
      text,
      MAX_HANDSHAKE_BUFFER_CHARS,
    );

    if (endpoint === this.injector) {
      if (
        this.ownershipRegistrationSent &&
        !this.ownershipRegistrationReady &&
        endpoint.handshakeBuffer.includes(this.ownershipReadyMarker)
      ) {
        this.ownershipRegistrationReady = true;
        endpoint.handshakeBuffer = '';
        this.maybeStartInjectorLoop();
        return;
      }
      if (
        endpoint.handshakeBuffer.includes(
          `${this.loopFailureMarker} status=`,
        )
      ) {
        this.fail(new Error('AIO terminal byte injector stopped'));
        return;
      }
      if (
        this.injectorLoopCommandSent &&
        !this.injectorLoopReady &&
        endpoint.handshakeBuffer.includes(this.loopReadyMarker)
      ) {
        this.injectorLoopReady = true;
        endpoint.handshakeBuffer = '';
        this.maybePublishCompositeReady();
        return;
      }
    }

    if (endpoint.shellReady) return;
    const shellIdentity = parseAioTerminalGuestIdentity(
      endpoint.handshakeBuffer,
      endpoint.identityMarker,
    );
    if (!shellIdentity) {
      if (
        endpoint.handshakeBuffer.includes(endpoint.identityMarker) &&
        endpoint.handshakeBuffer.includes('\n')
      ) {
        this.fail(
          new Error(`AIO terminal ${endpoint.role} shell identity was invalid`),
        );
      }
      return;
    }
    if (shellIdentity.tty.length === 0) {
      this.fail(
        new Error(`AIO terminal ${endpoint.role} shell identity was invalid`),
      );
      return;
    }
    endpoint.shellReady = true;
    endpoint.shellTty = shellIdentity.tty;
    endpoint.guestFingerprint = shellIdentity;
    endpoint.handshakeBuffer = '';
    this.maybeRegisterOwnershipPair();
  }

  private maybeRegisterOwnershipPair(): void {
    const injector = this.requireInjector();
    if (
      this.closed ||
      this.ownershipRegistrationSent ||
      !this.main.shellReady ||
      !injector.shellReady ||
      !this.main.guestFingerprint ||
      !injector.guestFingerprint ||
      typeof this.main.sessionFrame?.data !== 'string' ||
      typeof injector.sessionFrame?.data !== 'string'
    ) {
      return;
    }
    let pair: AioTerminalOwnershipPair;
    try {
      pair = Object.freeze({
        mainSessionId: this.main.sessionFrame.data,
        injectorSessionId: injector.sessionFrame.data,
        main: this.main.guestFingerprint,
        injector: injector.guestFingerprint,
        closeToken: this.injectorCloseToken,
        releaseMarker: this.loopReleaseMarker,
      });
      if (
        !isCanonicalAioTerminalProviderSessionId(pair.mainSessionId) ||
        !isCanonicalAioTerminalProviderSessionId(pair.injectorSessionId) ||
        pair.mainSessionId.slice(0, 8) ===
          pair.injectorSessionId.slice(0, 8)
      ) {
        throw new Error('provider identity');
      }
      this.cleanupPair = pair;
      if (!this.options.ownershipScope) {
        this.ownershipRegistrationSent = true;
        this.ownershipRegistrationReady = true;
        this.maybeStartInjectorLoop();
        return;
      }
      const ownershipRecord: AioTerminalOwnershipRecord =
        createAioTerminalOwnershipRecord({
          pair,
          scope: this.options.ownershipScope,
          processFingerprint: this.options.processFingerprint,
          iv: this.options.ownershipIvFactory?.('pair'),
        });
      this.ownershipRecordPath = ownershipRecord.path;
      const command = buildOwnershipRegistrationReadyCommand(
        ownershipRecord,
        this.ownershipReadyMarker,
      );
      if (command.includes(this.ownershipReadyMarker)) {
        throw new Error('ownership marker echo');
      }
      this.ownershipRegistrationSent = true;
      this.sendJson(injector.socket, {
        type: 'input',
        data: `${command}\n`,
      });
    } catch {
      this.fail(new Error('AIO terminal ownership registration failed'));
    }
  }

  private maybeStartInjectorLoop(): void {
    const injector = this.requireInjector();
    if (
      this.closed ||
      this.injectorLoopCommandSent ||
      !this.ownershipRegistrationReady ||
      !this.main.shellReady ||
      !injector.shellReady ||
      !this.main.shellTty ||
      !this.main.sessionFrame ||
      !injector.sessionFrame
    ) {
      return;
    }
    if (this.main.sessionFrame.data === injector.sessionFrame.data) {
      this.fail(
        new Error(
          'AIO terminal sockets did not have distinct session identities',
        ),
      );
      return;
    }

    const loopNonce = markerNonce(this.loopReadyMarker);
    const command = buildInjectorLoopCommand({
      exactTaskPaneTarget: this.exactTaskPaneTarget,
      closeToken: this.injectorCloseToken,
      loopNonce,
      releaseMarker: this.loopReleaseMarker,
    });
    if (
      command.includes(this.loopReadyMarker) ||
      command.includes(this.loopFailureMarker) ||
      command.includes(this.loopReleaseMarker)
    ) {
      this.fail(new Error('AIO terminal injector marker was not echo-safe'));
      return;
    }
    this.injectorLoopCommandSent = true;
    this.sendJson(injector.socket, {
      type: 'input',
      data: `${command}\n`,
    });
  }

  private maybePublishCompositeReady(): void {
    const injector = this.requireInjector();
    if (
      this.closed ||
      this.compositeReady ||
      !this.injectorLoopReady ||
      !this.main.shellReady ||
      !injector.shellReady ||
      !this.main.sessionFrame ||
      !this.main.readyFrame ||
      !this.areBothSocketsOpen()
    ) {
      return;
    }
    this.compositeReady = true;
    this.clearHandshakeTimer();
    this.emitFrame(this.main.sessionFrame);
    this.emitFrame(this.main.readyFrame);
  }

  private sendInternalPong(
    endpoint: AioTerminalEndpoint,
    frame: TerminalTransportFrame,
  ): void {
    const timestamp =
      typeof frame.timestamp === 'number'
        ? frame.timestamp
        : typeof frame.data === 'number'
          ? frame.data
          : Date.now();
    this.sendJson(endpoint.socket, { type: 'pong', timestamp });
  }

  private sendJson(
    socket: AioTerminalWebSocket,
    frame: Record<string, unknown>,
  ): boolean {
    if (this.closed || socket.readyState !== WebSocket.OPEN) return false;
    const generation = this.generation;
    try {
      socket.send(JSON.stringify(frame), (error) => {
        if (!error || !this.isCurrent(generation)) return;
        this.handleWriteFailure();
      });
      return true;
    } catch {
      this.handleWriteFailure();
      return false;
    }
  }

  private handleWriteFailure(): void {
    const error = new Error('AIO terminal WebSocket write failed');
    if (this.opaqueInputEnabled) {
      this.fail(error);
      return;
    }
    this.options.logger?.warn(`task ${this.taskId}: ${error.message}`);
    for (const listener of this.errorListeners) listener(error);
  }

  private startHandshakeTimer(generation: number): void {
    const timeoutMs = normalizeHandshakeTimeout(
      this.options.handshakeTimeoutMs,
    );
    this.handshakeTimer = setTimeout(() => {
      if (!this.isCurrent(generation) || this.compositeReady) return;
      this.fail(new Error('AIO terminal byte injector handshake timed out'));
    }, timeoutMs);
    this.handshakeTimer.unref?.();
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.options.logger?.warn(`task ${this.taskId}: ${error.message}`);
    if (!this.errorEmitted) {
      this.errorEmitted = true;
      for (const listener of this.errorListeners) listener(error);
    }
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.compositeReady = false;
    this.injectorLoopReady = false;
    this.clearHandshakeTimer();
    // Do not consume the injector close token on a socket that may be racing a
    // network failure. Exact cleanup reconnects the persisted injector PTY by
    // its authenticated id, stops the loop, then runs full-fingerprint-guarded
    // detach/exit commands queued behind that token.
    bestEffortCloseSocket(this.main.socket);
    if (this.injector) bestEffortCloseSocket(this.injector.socket);
    this.startProviderSessionCleanup();
    this.emitCloseOnce();
  }

  private startProviderSessionCleanup(): void {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    const endpoints = this.injector
      ? [this.main, this.injector]
      : [this.main];
    const expectedIdentities = endpoints.length;
    const pair = this.cleanupPair;
    const observedIds = pair
      ? [pair.mainSessionId, pair.injectorSessionId]
      : endpoints.flatMap((endpoint) =>
          typeof endpoint.sessionFrame?.data === 'string'
            ? [endpoint.sessionFrame.data]
            : [],
        );
    const observedIdentities = observedIds.length;
    const ownershipRecordPaths = this.ownershipRecordPath
      ? [this.ownershipRecordPath]
      : [];

    const baseUrl = this.options.baseUrl;
    if (!baseUrl) {
      this.settleCleanupDecision({
        kind: 'indeterminate',
        expectedIdentities,
        observedIdentities,
        confirmedIdentities: 0,
        deletedIdentities: 0,
        alreadyAbsentIdentities: 0,
        cause: 'cleanup-unsupported',
      });
      return;
    }
    if (!pair || observedIdentities !== expectedIdentities) {
      this.settleCleanupDecision({
        kind: 'indeterminate',
        expectedIdentities,
        observedIdentities,
        confirmedIdentities: 0,
        deletedIdentities: 0,
        alreadyAbsentIdentities: 0,
        cause: 'identity-unavailable',
      });
      return;
    }

    const releaser =
      this.options.guestPairReleaser ?? releaseAioTerminalGuestPairExact;
    void releaser({
      fetch: this.options.fetch ?? fetch,
      baseUrl,
      taskId: this.taskId,
      pair,
      timeoutMs: this.options.exactReleaseTimeoutMs,
      maxOutputBytes: this.options.reconnectOutputMaxBytes,
      socketFactory: this.options.reconnectSocketFactory,
    }).then(
      async (results) => {
        if (results.kind !== 'confirmed') {
          this.settleCleanupDecision({
            kind: 'indeterminate',
            expectedIdentities,
            observedIdentities,
            confirmedIdentities: 0,
            deletedIdentities: 0,
            alreadyAbsentIdentities: 0,
            cause: 'cleanup-unconfirmed',
          });
          return;
        }
        const metadataResults = await this.cleanupObservedProviderSessions(
          baseUrl,
          observedIds,
        );
        const proofs = metadataResults.filter(
          (result): result is AioShellSessionCleanupProof => result !== null,
        );
        const deletedIdentities = proofs.filter(
          (proof) => proof === 'deleted',
        ).length;
        const alreadyAbsentIdentities = proofs.filter(
          (proof) => proof === 'already-absent',
        ).length;
        const confirmedIdentities = proofs.length;
        if (
          observedIdentities === expectedIdentities &&
          confirmedIdentities === expectedIdentities
        ) {
          if (ownershipRecordPaths.length > 0) {
            try {
              await deleteAioTerminalOwnershipRecordsCoalesced({
                fetch: this.options.fetch ?? fetch,
                baseUrl,
                taskId: this.taskId,
                paths: ownershipRecordPaths,
              });
            } catch {
              this.settleCleanupDecision({
                kind: 'indeterminate',
                expectedIdentities,
                observedIdentities,
                confirmedIdentities,
                deletedIdentities,
                alreadyAbsentIdentities,
                cause: 'cleanup-unconfirmed',
              });
              return;
            }
          }
          this.settleCleanupDecision({
            kind: 'confirmed',
            expectedIdentities,
            observedIdentities,
            confirmedIdentities,
            deletedIdentities,
            alreadyAbsentIdentities,
            cause: null,
          });
          return;
        }
        this.settleCleanupDecision({
          kind: 'indeterminate',
          expectedIdentities,
          observedIdentities,
          confirmedIdentities,
          deletedIdentities,
          alreadyAbsentIdentities,
          cause: metadataResults.some((result) => result === null)
            ? 'cleanup-unconfirmed'
            : 'identity-unavailable',
        });
      },
      () => {
        // A programming/runtime rejection outside an individual provider call
        // remains bounded and cannot be promoted to successful cleanup.
        this.settleCleanupDecision({
          kind: 'indeterminate',
          expectedIdentities,
          observedIdentities,
          confirmedIdentities: 0,
          deletedIdentities: 0,
          alreadyAbsentIdentities: 0,
          cause: 'cleanup-unconfirmed',
        });
      },
    );
  }

  private cleanupObservedProviderSessions(
    baseUrl: string,
    sessionIds: readonly string[],
  ): Promise<readonly (AioShellSessionCleanupProof | null)[]> {
    const fetchImpl = this.options.fetch ?? fetch;
    return Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          return await deleteAioShellSessionExact(
            fetchImpl,
            baseUrl,
            sessionId,
            {
              attemptTimeoutMs: this.options.cleanupAttemptTimeoutMs,
              retryDelayMs: this.options.cleanupRetryDelayMs,
            },
          );
        } catch {
          return null;
        }
      }),
    );
  }

  private emitCloseOnce(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }

  private areBothSocketsOpen(): boolean {
    return (
      this.main.socket.readyState === WebSocket.OPEN &&
      this.requireInjector().socket.readyState === WebSocket.OPEN
    );
  }

  private hasClosedOpaqueInputSocket(): boolean {
    const injectorState = this.requireInjector().socket.readyState;
    return (
      this.main.socket.readyState === WebSocket.CLOSING ||
      this.main.socket.readyState === WebSocket.CLOSED ||
      injectorState === WebSocket.CLOSING ||
      injectorState === WebSocket.CLOSED
    );
  }

  private requireInjector(): AioTerminalEndpoint {
    if (!this.injector) {
      throw new Error('AIO opaque-input injector is not enabled');
    }
    return this.injector;
  }

  private emitFrame(frame: TerminalTransportFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }
}

function createMarkerNonce(
  options: AioTerminalTransportOptions,
  role: AioTerminalMarkerRole,
): string {
  let nonce: string;
  try {
    nonce = options.markerFactory?.(role) ?? randomBytes(12).toString('hex');
  } catch {
    throw new Error('AIO terminal marker generation failed');
  }
  if (!SAFE_MARKER_NONCE_PATTERN.test(nonce)) {
    throw new Error('AIO terminal marker generation failed');
  }
  return nonce;
}

function buildExactTaskPaneTarget(taskId: string): string {
  const sessionName = `task${taskId}`;
  if (!SAFE_TMUX_NAME_PATTERN.test(sessionName)) {
    throw new Error('task id cannot be represented as a safe tmux session target');
  }
  return `=${sessionName}:`;
}

function markerNonce(marker: string): string {
  const nonce = marker.slice(marker.lastIndexOf('_') + 1);
  if (!SAFE_MARKER_NONCE_PATTERN.test(nonce)) {
    throw new Error('AIO terminal marker generation failed');
  }
  return nonce;
}

function buildOwnershipRegistrationReadyCommand(
  record: AioTerminalOwnershipRecord,
  marker: string,
): string {
  const nonce = markerNonce(marker);
  const prefix = marker.slice(0, marker.lastIndexOf('_') + 1);
  return (
    buildAioTerminalOwnershipRegistrationShell({ record, nonce }) +
    ` && printf '\\r\\n${prefix}%s\\r\\n' '${nonce}'`
  );
}

function buildInjectorLoopCommand(args: {
  readonly exactTaskPaneTarget: string;
  readonly closeToken: string;
  readonly loopNonce: string;
  readonly releaseMarker: string;
}): string {
  const releaseNonce = markerNonce(args.releaseMarker);
  const releasePrefix = args.releaseMarker.slice(
    0,
    args.releaseMarker.lastIndexOf('_') + 1,
  );
  return [
    'LC_ALL=C; export LC_ALL; cap_status=0;',
    `printf '\\r\\nCAP_AIO_INJECTOR_READY_%s\\r\\n' '${args.loopNonce}';`,
    'while IFS= read -r cap_line; do',
    `if [ "$cap_line" = '${args.closeToken}' ]; then`,
    `if [ "$cap_status" -eq 0 ]; then printf '\\r\\n${releasePrefix}%s\\r\\n' '${releaseNonce}'; fi;`,
    'break;',
    'fi;',
    'set -- $cap_line;',
    '[ "$#" -gt 0 ] || continue;',
    `[ "$#" -le ${OPAQUE_INPUT_CHUNK_BYTES} ] || { cap_status=64; break; };`,
    'cap_valid=1;',
    'for cap_hex; do',
    'case "$cap_hex" in [0-9a-f][0-9a-f]) ;; *) cap_valid=0; break ;; esac;',
    'done;',
    '[ "$cap_valid" -eq 1 ] || { cap_status=64; break; };',
    `tmux send-keys -H -t '${args.exactTaskPaneTarget}' "$@" || { cap_status=65; break; };`,
    'done;',
    `if [ "$cap_status" -ne 0 ]; then printf '\\r\\nCAP_AIO_INJECTOR_FAILED_%s status=%s\\r\\n' '${args.loopNonce}' "$cap_status"; fi`,
  ].join(' ');
}

function encodeCanonicalHexLine(
  data: Uint8Array,
  start: number,
  end: number,
): string {
  const tokens = new Array<string>(end - start);
  for (let index = start; index < end; index += 1) {
    tokens[index - start] = data[index]!.toString(16).padStart(2, '0');
  }
  return tokens.join(' ');
}

function isAsciiBytes(data: Uint8Array): boolean {
  for (const byte of data) {
    if (byte > 0x7f) return false;
  }
  return true;
}

function appendBounded(
  current: string,
  addition: string,
  maxChars: number,
): string {
  const combined = current + addition;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function normalizeHandshakeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_HANDSHAKE_TIMEOUT_MS);
}

function bestEffortCloseSocket(socket: AioTerminalWebSocket): void {
  try {
    socket.close();
  } catch {
    // Closed sockets may throw on repeated close.
  }
}

function deleteAioTerminalOwnershipRecordsCoalesced(args: {
  readonly fetch: AioShellFetch;
  readonly baseUrl: string;
  readonly taskId: string;
  readonly paths: readonly string[];
}): Promise<void> {
  let fetchBatches = ownershipRecordCleanupBatches.get(args.fetch);
  if (!fetchBatches) {
    fetchBatches = new Map();
    ownershipRecordCleanupBatches.set(args.fetch, fetchBatches);
  }
  const key = aioOwnershipRecordCleanupBatchKey(args.baseUrl, args.taskId);
  const existing = fetchBatches.get(key);
  if (existing?.accepting) {
    for (const path of args.paths) existing.paths.add(path);
    return existing.promise;
  }

  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  const batch: AioOwnershipRecordCleanupBatch = {
    paths: new Set(args.paths),
    promise,
    resolve,
    reject,
    accepting: true,
  };
  fetchBatches.set(key, batch);
  setTimeout(() => {
    batch.accepting = false;
    const paths = [...batch.paths];
    void deleteAioTerminalOwnershipRecordFilesExact({
      fetch: args.fetch,
      baseUrl: args.baseUrl,
      paths,
      requestTimeoutMs: OWNERSHIP_RECORD_CLEANUP_TIMEOUT_MS,
    }).then(batch.resolve, () => {
      batch.reject(
        new Error('AIO terminal ownership record cleanup was not confirmed'),
      );
    }).finally(() => {
      const currentFetchBatches = ownershipRecordCleanupBatches.get(args.fetch);
      if (currentFetchBatches?.get(key) === batch) {
        currentFetchBatches.delete(key);
      }
      if (currentFetchBatches?.size === 0) {
        ownershipRecordCleanupBatches.delete(args.fetch);
      }
    });
  }, OWNERSHIP_RECORD_CLEANUP_COALESCE_MS);
  return promise;
}

function aioOwnershipRecordCleanupBatchKey(
  baseUrl: string,
  taskId: string,
): string {
  return createHash('sha256')
    .update(baseUrl.replace(/\/+$/u, ''), 'utf8')
    .update('\0', 'utf8')
    .update(taskId, 'utf8')
    .digest('hex');
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createAioTerminalTransportFactory(args: {
  readonly taskId: string;
  readonly wsUrl: string;
  readonly baseUrl?: string;
  readonly fetch?: AioShellFetch;
  readonly logger?: AioTerminalTransportLogger;
  readonly enableOpaqueInput?: boolean;
  readonly cleanupAttemptTimeoutMs?: number;
  readonly cleanupRetryDelayMs?: number;
  readonly ownershipScope?: AioTerminalOwnershipScope;
}): { open(): TerminalTransport } {
  return {
    open: () =>
      new AioTerminalTransport(args.taskId, args.wsUrl, {
        baseUrl: args.baseUrl,
        fetch: args.fetch,
        logger: args.logger,
        enableOpaqueInput: args.enableOpaqueInput,
        cleanupAttemptTimeoutMs: args.cleanupAttemptTimeoutMs,
        cleanupRetryDelayMs: args.cleanupRetryDelayMs,
        ownershipScope: args.ownershipScope,
      }),
  };
}

/**
 * Keep AIO's `/v1/shell/wait` wire contract behind the provider boundary. The
 * shared sandbox session engine consumes only the normalized optional exit code.
 */
export function createAioTerminalExitStatusResolver(args: {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}): () => Promise<number | null> {
  return async () => {
    try {
      const fetchImpl = args.fetch ?? fetch;
      const response = await fetchImpl(`${args.baseUrl}/v1/shell/wait`, {
        method: 'POST',
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        readonly exitCode?: unknown;
        readonly code?: unknown;
      };
      return normalizeAioTerminalExitCode(body.exitCode ?? body.code);
    } catch {
      return null;
    }
  };
}

function normalizeAioTerminalExitCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^-?\d+$/u.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parseAioFrame(raw: WebSocket.RawData): TerminalTransportFrame | null {
  return parseAioTerminalFrame(raw);
}

export function normalizeAioWebSocketReadyState(
  readyState: number,
): TerminalTransportReadyState {
  switch (readyState) {
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

export function parseAioTerminalFrame(
  raw: WebSocket.RawData,
): TerminalTransportFrame | null {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString('utf8');
  } else {
    text = Buffer.from(raw as ArrayBuffer).toString('utf8');
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof (obj as { type?: unknown }).type !== 'string'
  ) {
    return null;
  }
  return obj as TerminalTransportFrame;
}
