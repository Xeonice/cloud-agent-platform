/**
 * Central authenticated WebSocket client for the session page
 * (frontend-console spec 13.3/13.6; rebuild-console-tanstack-start D6).
 *
 * Connects to the env-configured cross-origin {@link wsUrl} (never same-origin)
 * and authenticates with the operator bearer token (D12). Browsers cannot set
 * an `Authorization` header on a WebSocket handshake, so the token is carried
 * both as a `token` query parameter and as a `bearer.<token>` subprotocol; the
 * orchestrator's connect-time auth accepts either. This is distinct from the
 * runner `TASK_TOKEN` dial-back handshake. Under multi-user the server-side WS
 * handshake will map this credential to the session/user (D6).
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
import { wsUrl, operatorToken } from "./config";

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

/**
 * Reconnection backoff (full jitter — AWS "Exponential Backoff and Jitter"):
 * each retry waits a random delay in `[0, min(cap, base · 2^attempt)]`, which
 * desynchronizes reconnect waves and avoids a tight loop. Tuned for a single
 * terminal socket behind Cloudflare's ~100s idle WebSocket window.
 */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 15;
/**
 * Forward-progress watchdog for a stalled handshake: if a socket sits in
 * CONNECTING past this deadline (a dead tunnel that completes TCP but never
 * returns the WS upgrade), force-close it so the reconnect path runs instead of
 * waiting out the browser's much longer handshake timeout.
 */
const CONNECT_TIMEOUT_MS = 12_000;

export interface TerminalSocketHandlers {
  /** Decoded raw PTY bytes (already base64-decoded). Carries the frame `seq`. */
  onRaw?: (bytes: Uint8Array, seq: number) => void;
  /** Any validated control frame, dispatched by the consumer on `type`. */
  onControl?: (frame: ControlFrame) => void;
  onOpen?: () => void;
  /**
   * The socket closed. `willReconnect` is true when the client will auto-retry
   * (a transient drop) so the consumer can show a "reconnecting" state rather
   * than a terminal "closed"; false on an intentional close, a clean (1000) or
   * policy/auth (1008) close, or once the retry budget is exhausted.
   */
  onClose?: (event: CloseEvent, willReconnect: boolean) => void;
  onError?: (event: Event) => void;
}

/**
 * A thin, typed wrapper over the browser `WebSocket` for one task session.
 * The session page constructs one of these, wires handlers, and uses the
 * `send*` helpers to drive keystrokes, ACKs, heartbeats, takeover, and
 * one-shot approval decisions.
 *
 * Resilience: the socket AUTO-RECONNECTS with exponential backoff + full jitter
 * on a transient drop (e.g. Cloudflare closing an idle tunnel after ~100s). A
 * clean close (1000), a policy/auth close (1008), an intentional {@link close},
 * or an exhausted retry budget stops the retries. On every (re)open the
 * consumer's `onOpen` re-sends the reconnect-restoration frame (snapshot + tail
 * from the last ACK'd seq) and re-arms takeover, so the live frame and the write
 * lease are restored without a page reload. A monotonic generation token fences
 * off a superseded socket's late events so a stale connection can never mutate
 * state for the live one. {@link ensureConnected} lets the page recover an
 * idle-dropped socket immediately on tab focus / network return.
 */
export class TerminalSocket {
  private socket: WebSocket | null = null;
  /**
   * Monotonic connection id, bumped on every connect()/close(). Each socket's
   * event handlers capture their generation and no-op once superseded, so a
   * lingering old socket's late onclose/onmessage can't touch live state.
   */
  private generation = 0;
  /** Set by close() so the onclose-driven reconnect is suppressed on teardown. */
  private intentionallyClosed = false;
  /** Consecutive failed-connection count; reset to 0 on a healthy open. */
  private reconnectAttempt = 0;
  /** Pending backoff timer, or null when no reconnect is scheduled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Watchdog timer that abandons a handshake stuck in CONNECTING. */
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly taskId: string,
    private readonly handlers: TerminalSocketHandlers = {},
  ) {}

  /** Open the authenticated socket for this task (auto-reconnecting). */
  connect(): void {
    this.intentionallyClosed = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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

    // Fence this socket's events to its generation so a superseded socket that
    // settles late (a delayed close/message after we moved on) is ignored.
    const gen = (this.generation += 1);
    const isCurrent = () => gen === this.generation && this.socket === socket;

    socket.onopen = () => {
      if (!isCurrent()) return;
      this.clearConnectWatchdog();
      this.reconnectAttempt = 0; // a healthy open resets the backoff ramp
      this.handlers.onOpen?.();
    };
    socket.onclose = (event) => {
      if (!isCurrent()) return;
      this.clearConnectWatchdog();
      this.socket = null;
      const willReconnect = this.shouldReconnect(event);
      this.handlers.onClose?.(event, willReconnect);
      if (willReconnect) this.scheduleReconnect();
    };
    socket.onerror = (event) => {
      if (!isCurrent()) return;
      // A WebSocket error is always followed by a close event; the reconnect
      // decision is made there to avoid double-scheduling.
      this.handlers.onError?.(event);
    };
    socket.onmessage = (event) => {
      if (!isCurrent()) return;
      this.handleMessage(event.data);
    };

    // Force-close a handshake that stalls in CONNECTING so onclose drives a
    // retry instead of the page hanging on a half-open socket.
    this.armConnectWatchdog(socket, isCurrent);
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

  /** Decide whether a close warrants an auto-reconnect. */
  private shouldReconnect(event: CloseEvent): boolean {
    if (this.intentionallyClosed) return false;
    // 1000 = normal closure (clean shutdown); 1008 = policy violation (e.g. an
    // expired/invalid session) — neither is resolved by retrying.
    if (event.code === 1000 || event.code === 1008) return false;
    return this.reconnectAttempt < RECONNECT_MAX_ATTEMPTS;
  }

  /** Schedule a reconnect after a full-jitter backoff delay. */
  private scheduleReconnect(): void {
    const cap = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
    );
    const delay = Math.random() * cap; // full jitter: random in [0, cap]
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.connect();
      } catch {
        // wsUrl()/config unresolved — a permanent error, not a transient drop;
        // stop retrying and surface it (the consumer maps onError → error UI).
        this.handlers.onError?.(new Event("error"));
      }
    }, delay);
  }

  /** Arm the handshake watchdog for `socket`, replacing any prior one. */
  private armConnectWatchdog(socket: WebSocket, isCurrent: () => boolean): void {
    this.clearConnectWatchdog();
    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = null;
      if (isCurrent() && socket.readyState === WebSocket.CONNECTING) {
        // Still handshaking past the deadline — abandon it. close() makes the
        // browser fire onclose (abnormal), which runs the normal reconnect path.
        socket.close();
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /** Cancel a pending handshake watchdog, if any. */
  private clearConnectWatchdog(): void {
    if (this.connectWatchdog !== null) {
      clearTimeout(this.connectWatchdog);
      this.connectWatchdog = null;
    }
  }

  /**
   * Re-open the socket immediately if it is not already open/connecting and was
   * not intentionally closed. The page calls this when the tab regains focus or
   * the network returns, so a silently-dropped connection recovers at once
   * instead of waiting out the backoff. `reconnectAttempt` is deliberately NOT
   * reset here: resetting on a mere connect attempt would collapse the backoff
   * ramp and defeat the give-up budget every time the tab refocuses against a
   * still-down server. A genuine recovery resets the ramp honestly in onopen.
   */
  ensureConnected(): void {
    if (this.intentionallyClosed) return;
    const state = this.socket?.readyState ?? WebSocket.CLOSED;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.connect();
    } catch {
      this.handlers.onError?.(new Event("error"));
    }
  }

  /** Close the socket and stop auto-reconnecting. */
  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectWatchdog();
    // Bump the generation so any in-flight event is fenced off, and detach the
    // handlers before closing so the onclose-driven reconnect never fires for an
    // intentional teardown (taskId change / unmount).
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }
}
