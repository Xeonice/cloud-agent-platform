import { ControlFrameSchema } from '@cap/contracts';
import { buildHandshakeFrame, handshakeInputFromEnv, type HandshakeInput } from './handshake.js';

/**
 * Runner outbound dial-back client (track runner-dialback-and-creds, 8.1).
 *
 * Design D8 / spec "Runner dials back to the orchestrator": the runner
 * establishes its connection by dialing **out** to the orchestrator over a
 * WebSocket and *never* binds or listens on an inbound port. No sandbox exposes
 * an inbound network port, which removes the inbound attack surface and works
 * behind NAT — the orchestrator is the only listener.
 *
 * The first frame the runner sends on the freshly-opened socket SHALL be the
 * dial-back handshake frame carrying the short-lived per-task `TASK_TOKEN`
 * (spec "Dial-back handshake authenticated by a short-lived TASK_TOKEN"). The
 * orchestrator-side verifier that accepts/rejects that handshake lives in the
 * integration track (task 8.2) — this client's contract is simply: open
 * outbound, send the handshake first, never listen.
 *
 * To keep this module self-contained and free of a hard dependency on a
 * concrete WebSocket library (owned by the runner package, not this track), the
 * minimal socket surface this client needs is injected via a factory. In
 * production the runner wires the `ws` library's `WebSocket` to it; tests wire a
 * fake to assert handshake-first ordering and no-inbound-listen behaviour.
 */

/** Minimal outbound WebSocket surface this client depends on. */
export interface OutboundSocket {
  /** Registers a persistent listener for socket events. */
  on(event: 'open', listener: () => void): void;
  on(event: 'close', listener: (code: number, reason?: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  /** Sends one frame to the orchestrator. */
  send(data: string): void;
  /** Closes the outbound connection. */
  close(): void;
}

/**
 * Opens a *client* (outbound) WebSocket to the given orchestrator URL. The
 * implementation MUST dial out only and MUST NOT create a server/listener.
 */
export type OutboundSocketFactory = (url: string) => OutboundSocket;

export interface DialBackClientOptions {
  /**
   * The orchestrator's WebSocket URL to dial out to (e.g. `wss://api.../runner`).
   * Cross-origin by design (design D10): the runner reaches the orchestrator
   * over an env-configured URL, never a same-origin assumption.
   */
  readonly orchestratorUrl: string;
  /** Opens an outbound client socket. Never binds/listens on an inbound port. */
  readonly socketFactory: OutboundSocketFactory;
  /**
   * Handshake inputs (claimed task id + `TASK_TOKEN`). Defaults to reading them
   * from the process environment the orchestrator injected at provisioning time.
   */
  readonly handshake?: HandshakeInput;
  /** Optional structured logger; defaults to a no-op to avoid leaking the token. */
  readonly log?: (message: string) => void;
  /**
   * Optional callback invoked for every validated inbound control frame from
   * the orchestrator (e.g. `resize`, `pause`, `resume`, `keystroke`). The
   * runner wires this to forward geometry/flow-control events to the local PTY
   * (VR.8: resize; VR.9: pause/resume).
   */
  readonly onControl?: (frame: import('@cap/contracts').ControlFrame) => void;
}

/** Connection state of the dial-back client. */
export type DialBackState = 'idle' | 'connecting' | 'handshaking' | 'open' | 'closed';

export class DialBackClient {
  private readonly orchestratorUrl: string;
  private readonly socketFactory: OutboundSocketFactory;
  private readonly handshakeInput: HandshakeInput;
  private readonly log: (message: string) => void;
  private readonly onControlCallback?: (frame: import('@cap/contracts').ControlFrame) => void;

  private socket: OutboundSocket | null = null;
  private state: DialBackState = 'idle';
  /** Guards against ever sending a non-handshake frame before the handshake. */
  private handshakeSent = false;

  constructor(options: DialBackClientOptions) {
    if (!options.orchestratorUrl?.trim()) {
      throw new Error('DialBackClient requires a non-empty orchestratorUrl');
    }
    this.orchestratorUrl = options.orchestratorUrl;
    this.socketFactory = options.socketFactory;
    this.handshakeInput = options.handshake ?? handshakeInputFromEnv();
    this.log = options.log ?? (() => undefined);
    this.onControlCallback = options.onControl;
  }

  /** Current connection state. */
  get connectionState(): DialBackState {
    return this.state;
  }

  /** True once the handshake frame has been emitted as the first frame. */
  get hasSentHandshake(): boolean {
    return this.handshakeSent;
  }

  /**
   * Dials out to the orchestrator and, on connection open, sends the dial-back
   * handshake frame as the very first frame. Resolves once the handshake has
   * been written to the wire (not when the orchestrator accepts it — acceptance
   * is observed on the message/close channel and handled by callers).
   *
   * Idempotent guard: calling `connect` while not idle/closed throws, so a
   * single client only ever owns one outbound socket.
   */
  connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed') {
      throw new Error(`DialBackClient.connect called in state "${this.state}"`);
    }

    // Build (and validate) the handshake before opening the socket so a bad
    // token fails fast and we never open a connection we cannot authenticate.
    const handshakeFrame = buildHandshakeFrame(this.handshakeInput);

    this.state = 'connecting';
    this.handshakeSent = false;
    // Outbound dial: this opens a *client* connection. It deliberately never
    // creates a server or binds an inbound port.
    const socket = this.socketFactory(this.orchestratorUrl);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.on('open', () => {
        this.state = 'handshaking';
        try {
          // The handshake MUST be the first frame on the socket.
          socket.send(JSON.stringify(handshakeFrame));
          this.handshakeSent = true;
          this.state = 'open';
          this.log('dial-back handshake sent');
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (err) {
          this.state = 'closed';
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });

      // Handle inbound control frames from the orchestrator (e.g. resize,
      // pause, resume). Validate each frame against the contracts schema before
      // dispatching to the onControl callback so malformed frames are dropped.
      socket.on('message', (data: unknown) => {
        if (!this.onControlCallback) return;
        const text = typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf8') : null);
        if (!text) return;
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return; }
        const result = ControlFrameSchema.safeParse(parsed);
        if (result.success) this.onControlCallback(result.data);
      });

      socket.on('error', (err) => {
        this.state = 'closed';
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      socket.on('close', () => {
        this.state = 'closed';
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('dial-back socket closed before handshake completed'));
        }
      });
    });
  }

  /**
   * Sends a post-handshake frame. Refuses to send anything until the handshake
   * frame has been written, preserving the "handshake is the first frame"
   * invariant even if a caller races ahead.
   */
  send(frame: string): void {
    if (!this.handshakeSent || !this.socket) {
      throw new Error('Cannot send before the dial-back handshake frame');
    }
    this.socket.send(frame);
  }

  /** Closes the outbound connection. */
  close(): void {
    this.state = 'closed';
    this.socket?.close();
    this.socket = null;
  }
}
