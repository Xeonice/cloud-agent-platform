/**
 * Central authenticated WebSocket client for the session page
 * (frontend-console spec 13.3/13.6).
 *
 * Connects to the env-configured cross-origin {@link wsUrl} (never same-origin)
 * and authenticates with the operator bearer token (D12). Browsers cannot set
 * an `Authorization` header on a WebSocket handshake, so the token is carried
 * both as a `token` query parameter and as a `bearer.<token>` subprotocol; the
 * orchestrator's connect-time auth (wired in Track 14) accepts either.
 *
 * Every inbound message is validated against the contracts `WsFrameSchema`, so
 * a raw byte frame is never parsed as a control frame and vice-versa (D4). Raw
 * frames are decoded from base64 and handed to {@link TerminalSocketHandlers.onRaw};
 * control frames are dispatched by `type`.
 */
import {
  WsFrameSchema,
  FRAME_CHANNEL,
  type ControlFrame,
  type RawFrame,
  type AckFrame,
  type KeystrokeFrame,
  type HeartbeatFrame,
  type TakeoverRequestFrame,
  type DecisionFrame,
  type ReconnectFrame,
  type ResizeFrame,
  type Decision,
} from "@cap/contracts";
import { wsUrl, operatorToken } from "./config.js";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/** Encode a string of raw input as the base64 payload the keystroke frame carries. */
function encodeInput(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64(bytes);
}

/**
 * Decode the base64 `data` of a `tail_replay` frame into raw bytes the terminal
 * can render on reconnect. Exposed so the session page can replay the tail.
 */
export function decodeTailReplay(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

export interface TerminalSocketHandlers {
  /** Decoded raw PTY bytes (already base64-decoded). Carries the frame `seq`. */
  onRaw?: (bytes: Uint8Array, seq: number) => void;
  /** Any validated control frame, dispatched by the consumer on `type`. */
  onControl?: (frame: ControlFrame) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

/**
 * A thin, typed wrapper over the browser `WebSocket` for one task session.
 * The session page constructs one of these, wires handlers, and uses the
 * `send*` helpers to drive keystrokes, ACKs, heartbeats, takeover, and
 * one-shot approval decisions.
 */
export class TerminalSocket {
  private socket: WebSocket | null = null;

  constructor(
    private readonly taskId: string,
    private readonly handlers: TerminalSocketHandlers = {},
  ) {}

  /** Open the authenticated socket for this task. */
  connect(): void {
    const token = operatorToken();
    const base = wsUrl();
    const url = new URL(`${base}/terminal`);
    url.searchParams.set("taskId", this.taskId);
    if (token) url.searchParams.set("token", token);

    // Carry the token in a subprotocol as well; the orchestrator accepts either.
    const protocols = token ? [`bearer.${token}`] : undefined;
    const socket = new WebSocket(url.toString(), protocols);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => this.handlers.onOpen?.();
    socket.onclose = (event) => this.handlers.onClose?.(event);
    socket.onerror = (event) => this.handlers.onError?.(event);
    socket.onmessage = (event) => this.handleMessage(event.data);
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // Non-JSON traffic is not part of the frame protocol.
    }

    const result = WsFrameSchema.safeParse(parsed);
    if (!result.success) return; // Reject anything that is not a valid frame.

    const frame = result.data;
    if (frame.channel === FRAME_CHANNEL.RAW) {
      const raw = frame as RawFrame;
      this.handlers.onRaw?.(base64ToBytes(raw.data), raw.seq);
    } else {
      this.handlers.onControl?.(frame as ControlFrame);
    }
  }

  private sendFrame(frame: ControlFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  /** Acknowledge raw output drained up to `seq` (drives server backpressure). */
  sendAck(seq: number): void {
    const frame: AckFrame = { channel: FRAME_CHANNEL.CONTROL, type: "ack", seq };
    this.sendFrame(frame);
  }

  /**
   * Request reconnect restoration (5.5): ask the server for the latest snapshot
   * plus the `session.log` tail appended after `lastSeq`, carrying the client's
   * current geometry so a differently-sized client can reconcile. Sent on
   * (re)connect so a refreshed tab is restored to the live frame.
   */
  sendReconnect(lastSeq?: number, cols?: number, rows?: number): void {
    const frame: ReconnectFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "reconnect",
      ...(lastSeq !== undefined ? { lastSeq } : {}),
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
    };
    this.sendFrame(frame);
  }

  /** Forward raw keystroke input — only honored server-side when this client holds the lease. */
  sendKeystroke(sessionId: string, input: string): void {
    const frame: KeystrokeFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "keystroke",
      sessionId,
      data: encodeInput(input),
    };
    this.sendFrame(frame);
  }

  /** Renew the write lease for this session. */
  sendHeartbeat(sessionId: string, writerClientId: string): void {
    const frame: HeartbeatFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "heartbeat",
      sessionId,
      writerClientId,
    };
    this.sendFrame(frame);
  }

  /** Preemptively take over the write lease, demoting the current holder to reader. */
  sendTakeover(sessionId: string, clientId: string): void {
    const frame: TakeoverRequestFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "takeover_request",
      sessionId,
      clientId,
    };
    this.sendFrame(frame);
  }

  /**
   * Submit a one-shot approval decision for a pending permission request. This
   * is lock-INDEPENDENT (D7): it is accepted regardless of who holds the lease.
   */
  sendDecision(requestId: string, decision: Decision): void {
    const frame: DecisionFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "decision",
      requestId,
      decision,
    };
    this.sendFrame(frame);
  }

  /**
   * Notify the server that the browser terminal has been resized (VR.8).
   * The server dispatches this to the runner PTY so cols/rows stay in sync,
   * making the "identical cols and rows" live-frame parity precondition
   * reachable at runtime.
   */
  sendResize(cols: number, rows: number): void {
    const frame: ResizeFrame = {
      channel: FRAME_CHANNEL.CONTROL,
      type: "resize",
      cols,
      rows,
    };
    this.sendFrame(frame);
  }

  /** Close the socket. */
  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }
}
