import {
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from "@cap/contracts";

export type SessionMatrixScenario =
  | "quiet"
  | "continuous"
  | "failed"
  | "profile"
  | "matrix";

export type SessionMatrixRole = "writer" | "reader" | "other";

type ResponseKind = "da1" | "dsr";
type RejectionReason = "unsolicited" | "replayed" | "expired" | "cross-task";

interface QueryToken {
  readonly kind: ResponseKind;
  readonly response: Uint8Array;
  readonly boundTaskId: string;
  readonly expiresAt: number;
}

interface MatrixConnectionProbe {
  readonly role: SessionMatrixRole;
  readonly taskId: string;
  readonly rawCount: number;
  readonly readyRawCount: number | null;
  readonly emitting: boolean;
}

interface MatrixResponseProbe {
  readonly role: SessionMatrixRole;
  readonly bytes: number[];
  readonly outcome: "accepted" | RejectionReason;
}

interface MatrixKeystrokeProbe {
  readonly role: SessionMatrixRole;
  readonly bytes: number[];
  readonly outcome: "accepted" | "reader_rejected";
  readonly accountedResponses: number;
}

interface MatrixResizeProbe {
  readonly role: SessionMatrixRole;
  readonly cols: number;
  readonly rows: number;
  readonly outcome: "accepted" | "reader_rejected";
}

export interface SessionMatrixSocketProbe {
  readonly connections: readonly MatrixConnectionProbe[];
  readonly clientFrameTypes: readonly string[];
  readonly responses: readonly MatrixResponseProbe[];
  readonly keystrokes: readonly MatrixKeystrokeProbe[];
  readonly resizes: readonly MatrixResizeProbe[];
  readonly authoritativeGeometry: { readonly cols: number; readonly rows: number };
}

export interface SessionMatrixController {
  probe(): SessionMatrixSocketProbe;
  issueQuery(role: SessionMatrixRole, kind: ResponseKind): boolean;
  armQuery(
    role: SessionMatrixRole,
    kind: ResponseKind,
    state: "live" | "expired" | "cross-task",
  ): boolean;
}

declare global {
  interface Window {
    __capSessionMatrix?: SessionMatrixController;
  }
}

type FixtureFrame =
  | { readonly channel: "raw"; readonly data: string; readonly seq: number }
  | {
      readonly channel: "control";
      readonly type: string;
      readonly [key: string]: unknown;
    };

const encoder = new TextEncoder();
const DA1_QUERY = "\x1b[c";
const DA1_RESPONSE = encoder.encode("\x1b[?1;2c");
const DSR_QUERY = "\x1b[5n";
const DSR_RESPONSE = encoder.encode("\x1b[0n");

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.length < prefix.length) return false;
  return prefix.every((byte, index) => byte === value[index]);
}

function expectedResponse(kind: ResponseKind): Uint8Array {
  return kind === "da1" ? DA1_RESPONSE : DSR_RESPONSE;
}

function queryBytes(kind: ResponseKind): string {
  return kind === "da1" ? DA1_QUERY : DSR_QUERY;
}

function taskIdFromUrl(raw: string): string {
  try {
    return new URL(raw).searchParams.get("taskId") ?? "matrix-task";
  } catch {
    return "matrix-task";
  }
}

function taskGroup(taskId: string): string {
  return taskId === "matrix-task-writer" || taskId === "matrix-task-reader"
    ? "matrix-task"
    : taskId;
}

export function installSessionMatrixWebSocket(
  scenario: SessionMatrixScenario,
): () => void {
  const NativeWebSocket = window.WebSocket;
  const sockets = new Set<MatrixWebSocket>();
  const socketsByRole = new Map<SessionMatrixRole, MatrixWebSocket>();
  const writerByGroup = new Map<string, MatrixWebSocket>();
  const clientFrameTypes: string[] = [];
  const responses: MatrixResponseProbe[] = [];
  const keystrokes: MatrixKeystrokeProbe[] = [];
  const resizes: MatrixResizeProbe[] = [];
  let authoritativeGeometry = { cols: 80, rows: 24 };

  function roleFor(taskId: string): SessionMatrixRole {
    if (scenario !== "matrix") return "writer";
    if (taskId === "matrix-other-task") return "other";
    return taskId === "matrix-task-reader" ? "reader" : "writer";
  }

  function broadcastLease(group: string): void {
    const writer = writerByGroup.get(group);
    for (const socket of sockets) {
      if (socket.group !== group) continue;
      socket.dispatch({
        channel: "control",
        type: "lease_state",
        sessionId: socket.taskId,
        lease: writer
          ? {
              writerClientId: writer.writerClientId,
              leaseExpiry: Date.now() + 30_000,
            }
          : null,
      });
    }
  }

  function broadcastGeometry(group: string): void {
    for (const socket of sockets) {
      if (socket.group !== group) continue;
      socket.dispatch({
        channel: "control",
        type: "terminal_geometry",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        ...authoritativeGeometry,
      });
    }
  }

  class MatrixWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    readonly taskId: string;
    readonly group: string;
    readonly role: SessionMatrixRole;
    readonly writerClientId: string;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    readyState = MatrixWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    rawCount = 0;
    readyRawCount: number | null = null;
    emitting = false;
    private seq = 0;
    private attached = false;
    private readonly queries: QueryToken[] = [];
    private readonly consumedResponses: Uint8Array[] = [];
    private readonly timers = new Set<number>();

    constructor(url: string | URL) {
      this.url = String(url);
      this.taskId = taskIdFromUrl(this.url);
      this.group = taskGroup(this.taskId);
      this.role = roleFor(this.taskId);
      this.writerClientId = `matrix-${this.role}-${sockets.size + 1}`;
      sockets.add(this);
      socketsByRole.set(this.role, this);
      this.defer(() => {
        if (this.readyState !== MatrixWebSocket.CONNECTING) return;
        this.readyState = MatrixWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }, 10);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== MatrixWebSocket.OPEN || typeof data !== "string") return;
      try {
        const frame = JSON.parse(data) as FixtureFrame;
        if (frame.channel !== "control") return;
        clientFrameTypes.push(frame.type);
        this.handleControl(frame);
      } catch {
        // Match TerminalSocket/Gateway behavior: malformed fixture traffic is ignored.
      }
    }

    close(code = 1000, reason = "matrix fixture closed"): void {
      if (this.readyState === MatrixWebSocket.CLOSED) return;
      this.readyState = MatrixWebSocket.CLOSING;
      for (const timer of this.timers) window.clearTimeout(timer);
      this.timers.clear();
      window.setTimeout(() => {
        this.readyState = MatrixWebSocket.CLOSED;
        sockets.delete(this);
        if (socketsByRole.get(this.role) === this) socketsByRole.delete(this.role);
        if (writerByGroup.get(this.group) === this) writerByGroup.delete(this.group);
        this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
      }, 0);
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
    ): void {
      if (!listener) return;
      const invoke = (event: Event) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      };
      if (type === "open") this.onopen = invoke;
      if (type === "close") this.onclose = invoke as (event: CloseEvent) => void;
      if (type === "error") this.onerror = invoke;
      if (type === "message") this.onmessage = invoke as (event: MessageEvent) => void;
    }

    removeEventListener(): void {
      // TerminalSocket uses property handlers; present for WebSocket parity.
    }

    dispatchEvent(event: Event): boolean {
      if (event.type === "open") this.onopen?.(event);
      if (event.type === "close") this.onclose?.(event as CloseEvent);
      if (event.type === "error") this.onerror?.(event);
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
      return true;
    }

    armQuery(kind: ResponseKind, state: "live" | "expired" | "cross-task"): void {
      this.queries.push({
        kind,
        response: expectedResponse(kind),
        boundTaskId: state === "cross-task" ? `${this.taskId}-other` : this.taskId,
        expiresAt: state === "expired" ? performance.now() - 1 : performance.now() + 5_000,
      });
    }

    issueQuery(kind: ResponseKind): void {
      this.armQuery(kind, "live");
      this.sendRaw(queryBytes(kind));
    }

    dispatch(frame: FixtureFrame): void {
      if (this.readyState !== MatrixWebSocket.OPEN) return;
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }

    private defer(callback: () => void, delay: number): void {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        callback();
      }, delay);
      this.timers.add(timer);
    }

    private handleControl(frame: Extract<FixtureFrame, { channel: "control" }>): void {
      switch (frame.type) {
        case "terminal_attach":
          this.attach(frame);
          break;
        case "terminal_response":
          if (typeof frame.data === "string") {
            this.handleResponse(base64ToBytes(frame.data));
          }
          break;
        case "takeover_request":
          if (this.role !== "reader") {
            writerByGroup.set(this.group, this);
            broadcastLease(this.group);
          }
          break;
        case "resize":
          if (typeof frame.cols === "number" && typeof frame.rows === "number") {
            this.handleResize(Math.round(frame.cols), Math.round(frame.rows));
          }
          break;
        case "keystroke":
          if (typeof frame.data === "string") {
            this.handleKeystroke(base64ToBytes(frame.data));
          }
          break;
        default:
          break;
      }
    }

    private attach(frame: Extract<FixtureFrame, { channel: "control" }>): void {
      const cols = typeof frame.cols === "number" ? Math.round(frame.cols) : 80;
      const rows = typeof frame.rows === "number" ? Math.round(frame.rows) : 24;
      authoritativeGeometry = { cols, rows };
      if (
        this.attached ||
        frame.protocolVersion !== TERMINAL_PROTOCOL_VERSION ||
        frame.responseProfileId !== XTERM_5_5_0_RESPONSE_PROFILE_ID ||
        scenario === "profile"
      ) {
        this.dispatch({
          channel: "control",
          type: "terminal_attachment_state",
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          state: "failed",
          reason: "response_profile_mismatch",
          reloadRequired: true,
          cols,
          rows,
        });
        return;
      }
      this.attached = true;
      this.dispatch({
        channel: "control",
        type: "terminal_attachment_state",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        state: "attaching",
        cols,
        rows,
      });
      broadcastLease(this.group);

      if (scenario === "failed") {
        this.defer(() => {
          this.dispatch({
            channel: "control",
            type: "terminal_attachment_state",
            protocolVersion: TERMINAL_PROTOCOL_VERSION,
            state: "failed",
            reason: "provider_failed",
            reloadRequired: false,
            cols,
            rows,
          });
        }, 80);
        return;
      }
      if (scenario === "continuous") {
        this.startContinuousFrame(cols, rows);
        return;
      }
      if (scenario === "matrix") {
        this.defer(
          () =>
            this.sendRaw(
              `\x1b[?1049h\x1b[2J\x1b[H\x1b[1;36mMATRIX_${this.role.toUpperCase()}\x1b[0m\x1b[?25l`,
            ),
          40,
        );
        this.defer(() => this.sendReady(cols, rows), 110);
        return;
      }

      const chunks = [
        "\x1b[?1049h\x1b[2J\x1b[H",
        "\x1b[1;38;2;52;211;153mQUIET_CURRENT_FRAME\x1b[0m",
        "\x1b[2;3H中文静止画面\x1b[4;12H\x1b[?25l",
      ];
      chunks.forEach((chunk, index) => this.defer(() => this.sendRaw(chunk), 80 + index * 55));
      this.defer(() => this.sendReady(cols, rows), 300);
    }

    private startContinuousFrame(cols: number, rows: number): void {
      this.emitting = true;
      for (let index = 1; index <= 24; index += 1) {
        this.defer(() => {
          this.sendRaw(
            `\x1b[?1049h\x1b[2J\x1b[HCONTINUOUS_FRAME_${String(index).padStart(2, "0")}\x1b[2;1H持续刷新中文\x1b[?25l`,
          );
          if (index === 24) this.emitting = false;
        }, 45 + index * 35);
      }
      this.defer(() => this.sendReady(cols, rows), 310);
    }

    private sendReady(cols: number, rows: number): void {
      this.readyRawCount = this.rawCount;
      this.dispatch({
        channel: "control",
        type: "terminal_attachment_state",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        state: "ready",
        cols,
        rows,
      });
    }

    private sendRaw(text: string): void {
      const bytes = encoder.encode(text);
      this.seq += bytes.length;
      this.rawCount += 1;
      this.dispatch({
        channel: "raw",
        data: bytesToBase64(bytes),
        seq: this.seq,
      });
    }

    private handleResponse(bytes: Uint8Array): void {
      const tokenIndex = this.queries.findIndex((token) => equalBytes(token.response, bytes));
      if (tokenIndex >= 0) {
        const token = this.queries[tokenIndex] as QueryToken;
        this.queries.splice(tokenIndex, 1);
        if (token.boundTaskId !== this.taskId) {
          responses.push({ role: this.role, bytes: [...bytes], outcome: "cross-task" });
          return;
        }
        if (performance.now() >= token.expiresAt) {
          responses.push({ role: this.role, bytes: [...bytes], outcome: "expired" });
          return;
        }
        this.consumedResponses.push(bytes.slice());
        responses.push({ role: this.role, bytes: [...bytes], outcome: "accepted" });
        return;
      }
      const replayed = this.consumedResponses.some((response) => equalBytes(response, bytes));
      responses.push({
        role: this.role,
        bytes: [...bytes],
        outcome: replayed ? "replayed" : "unsolicited",
      });
    }

    private handleKeystroke(bytes: Uint8Array): void {
      let accountedResponses = 0;
      if (writerByGroup.get(this.group) === this) {
        for (const response of [DA1_RESPONSE, DSR_RESPONSE]) {
          if (!startsWithBytes(bytes, response)) continue;
          const tokenIndex = this.queries.findIndex(
            (token) =>
              token.boundTaskId === this.taskId &&
              performance.now() < token.expiresAt &&
              equalBytes(token.response, response),
          );
          if (tokenIndex >= 0) {
            this.queries.splice(tokenIndex, 1);
            this.consumedResponses.push(response.slice());
            accountedResponses += 1;
          }
        }
      }
      keystrokes.push({
        role: this.role,
        bytes: [...bytes],
        outcome: writerByGroup.get(this.group) === this ? "accepted" : "reader_rejected",
        accountedResponses,
      });
    }

    private handleResize(cols: number, rows: number): void {
      const accepted = writerByGroup.get(this.group) === this;
      resizes.push({
        role: this.role,
        cols,
        rows,
        outcome: accepted ? "accepted" : "reader_rejected",
      });
      if (!accepted) return;
      authoritativeGeometry = { cols, rows };
      broadcastGeometry(this.group);
    }
  }

  window.WebSocket = MatrixWebSocket as unknown as typeof WebSocket;
  window.__capSessionMatrix = {
    probe: () => ({
      connections: [...sockets].map((socket) => ({
        role: socket.role,
        taskId: socket.taskId,
        rawCount: socket.rawCount,
        readyRawCount: socket.readyRawCount,
        emitting: socket.emitting,
      })),
      clientFrameTypes: [...clientFrameTypes],
      responses: responses.map((entry) => ({ ...entry, bytes: [...entry.bytes] })),
      keystrokes: keystrokes.map((entry) => ({ ...entry, bytes: [...entry.bytes] })),
      resizes: resizes.map((entry) => ({ ...entry })),
      authoritativeGeometry: { ...authoritativeGeometry },
    }),
    issueQuery: (role, kind) => {
      const socket = socketsByRole.get(role);
      if (!socket) return false;
      socket.issueQuery(kind);
      return true;
    },
    armQuery: (role, kind, state) => {
      const socket = socketsByRole.get(role);
      if (!socket) return false;
      socket.armQuery(kind, state);
      return true;
    },
  };

  return () => {
    for (const socket of [...sockets]) socket.close(1000, "matrix fixture restored");
    delete window.__capSessionMatrix;
    window.WebSocket = NativeWebSocket;
  };
}
