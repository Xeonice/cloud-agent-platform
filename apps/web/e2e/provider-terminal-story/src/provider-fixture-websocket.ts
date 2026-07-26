import {
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from "@cap/contracts";
import type { ProviderTerminalFixture } from "./provider-terminal-fixtures";

type FixtureSocketFrame =
  | { readonly channel: "raw"; readonly data: string; readonly seq: number }
  | {
      readonly channel: "control";
      readonly type: string;
      readonly [key: string]: unknown;
    };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

type ProviderFixtureWindow = Window &
  typeof globalThis & {
    __capProviderFixtureAttachFrames?: Array<Record<string, unknown>>;
    __capProviderFixtureConnectionOrigins?: number[];
    __capProviderFixtureAckSeqs?: number[];
    __capProviderFixtureResponses?: number[][];
    __capProviderFixtureQueries?: Array<{
      readonly name: string;
      readonly bytes: number[];
    }>;
    __capProviderFixtureProviderWrites?: Array<{
      readonly type: "keystroke" | "terminal_response";
      readonly bytes: number[];
    }>;
    __capProviderFixtureCloseOpenSockets?: (code?: number) => void;
    __capProviderFixtureEmitRaw?: (text: string) => void;
  };

function taskIdFromUrl(raw: string): string {
  try {
    return new URL(raw).searchParams.get("taskId") ?? "provider-fixture-session";
  } catch {
    return "provider-fixture-session";
  }
}

export function installProviderFixtureWebSocket(
  fixture: ProviderTerminalFixture,
): () => void {
  const NativeWebSocket = window.WebSocket;
  const fixtureWindow = window as ProviderFixtureWindow;
  const sockets = new Set<FixtureWebSocket>();
  const failure = new URLSearchParams(window.location.search).get("attachFailure");
  let nextSocketId = 1;
  fixtureWindow.__capProviderFixtureAttachFrames = [];
  fixtureWindow.__capProviderFixtureConnectionOrigins = [];
  fixtureWindow.__capProviderFixtureAckSeqs = [];
  fixtureWindow.__capProviderFixtureResponses = [];
  fixtureWindow.__capProviderFixtureQueries = [];
  fixtureWindow.__capProviderFixtureProviderWrites = [];
  fixtureWindow.__capProviderFixtureCloseOpenSockets = (code = 1011) => {
    for (const socket of [...sockets]) socket.close(code, "fixture reconnect");
  };
  fixtureWindow.__capProviderFixtureEmitRaw = (text) => {
    for (const socket of [...sockets]) socket.emitRaw(text);
  };

  class FixtureWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    readyState = FixtureWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    private readonly socketId = nextSocketId++;
    private readonly taskId: string;
    private seq = 0;
    private attached = false;
    private inputBytes: number[] = [];

    constructor(url: string | URL) {
      this.url = String(url);
      this.taskId = taskIdFromUrl(this.url);
      sockets.add(this);
      window.setTimeout(() => {
        if (this.readyState !== FixtureWebSocket.CONNECTING) return;
        this.readyState = FixtureWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }, 20);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== FixtureWebSocket.OPEN || typeof data !== "string") {
        return;
      }
      try {
        const frame = JSON.parse(data) as FixtureSocketFrame;
        if (frame.channel === "control") this.handleClientControl(frame);
      } catch {
        // Ignore malformed fixture traffic exactly like the real gateway.
      }
    }

    close(code = 1000, reason = "fixture closed"): void {
      if (this.readyState === FixtureWebSocket.CLOSED) return;
      this.readyState = FixtureWebSocket.CLOSING;
      window.setTimeout(() => {
        this.readyState = FixtureWebSocket.CLOSED;
        sockets.delete(this);
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
      if (type === "message") {
        this.onmessage = invoke as (event: MessageEvent) => void;
      }
    }

    removeEventListener(): void {
      // TerminalSocket uses property handlers; retained for WebSocket parity.
    }

    dispatchEvent(event: Event): boolean {
      if (event.type === "open") this.onopen?.(event);
      if (event.type === "close") this.onclose?.(event as CloseEvent);
      if (event.type === "error") this.onerror?.(event);
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
      return true;
    }

    emitRaw(text: string): void {
      if (this.attached) this.sendRaw(text);
    }

    private handleClientControl(frame: Extract<FixtureSocketFrame, { channel: "control" }>): void {
      switch (frame.type) {
        case "terminal_attach":
          this.attach(frame);
          break;
        case "ack":
          if (typeof frame.seq === "number") {
            fixtureWindow.__capProviderFixtureAckSeqs?.push(frame.seq);
          }
          break;
        case "terminal_response":
          if (typeof frame.data === "string") {
            const bytes = [...base64ToBytes(frame.data)];
            fixtureWindow.__capProviderFixtureResponses?.push(bytes);
            fixtureWindow.__capProviderFixtureProviderWrites?.push({
              type: "terminal_response",
              bytes,
            });
          }
          break;
        case "resize":
          if (typeof frame.cols === "number" && typeof frame.rows === "number") {
            const cols = Math.max(1, Math.round(frame.cols));
            const rows = Math.max(1, Math.round(frame.rows));
            this.dispatch({
              channel: "control",
              type: "terminal_geometry",
              protocolVersion: TERMINAL_PROTOCOL_VERSION,
              cols,
              rows,
            });
            this.sendRaw(`PROVIDER_FIXTURE_RESIZE:${cols}x${rows}\r\n`);
          }
          break;
        case "takeover_request":
          this.sendLeaseState();
          break;
        case "keystroke":
          if (typeof frame.data === "string") {
            fixtureWindow.__capProviderFixtureProviderWrites?.push({
              type: "keystroke",
              bytes: [...base64ToBytes(frame.data)],
            });
            this.handleKeystroke(frame.data);
          }
          break;
        default:
          break;
      }
    }

    private attach(frame: Extract<FixtureSocketFrame, { channel: "control" }>): void {
      fixtureWindow.__capProviderFixtureAttachFrames?.push({ ...frame });
      if (
        this.attached ||
        frame.protocolVersion !== TERMINAL_PROTOCOL_VERSION ||
        frame.responseProfileId !== XTERM_5_5_0_RESPONSE_PROFILE_ID ||
        failure === "profile"
      ) {
        this.dispatch({
          channel: "control",
          type: "terminal_attachment_state",
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          state: "failed",
          reason: "response_profile_mismatch",
          reloadRequired: true,
          cols: typeof frame.cols === "number" ? frame.cols : 80,
          rows: typeof frame.rows === "number" ? frame.rows : 24,
        });
        return;
      }
      this.attached = true;
      const cols = typeof frame.cols === "number" ? Math.round(frame.cols) : 80;
      const rows = typeof frame.rows === "number" ? Math.round(frame.rows) : 24;
      fixtureWindow.__capProviderFixtureConnectionOrigins?.push(this.seq);
      this.dispatch({
        channel: "control",
        type: "terminal_attachment_state",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        state: "attaching",
        cols,
        rows,
      });
      this.sendLeaseState();

      fixture.frames.bootstrap.forEach((chunk, index) => {
        window.setTimeout(() => this.sendRaw(chunk), 60 + index * 80);
      });
      const readyDelay = 80 + fixture.frames.bootstrap.length * 80;
      window.setTimeout(() => {
        this.dispatch({
          channel: "control",
          type: "terminal_attachment_state",
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          state: "ready",
          cols,
          rows,
        });
      }, readyDelay);
      fixture.frames.live.forEach((line, index) => {
        window.setTimeout(
          () => this.sendRaw(line),
          readyDelay + 120 + index * 100,
        );
      });
    }

    private sendLeaseState(): void {
      this.dispatch({
        channel: "control",
        type: "lease_state",
        sessionId: this.taskId,
        lease: {
          writerClientId: `provider-fixture-writer-${this.socketId}`,
          leaseExpiry: Date.now() + 30_000,
        },
      });
    }

    private handleKeystroke(data: string): void {
      for (const byte of base64ToBytes(data)) {
        if (byte === 0x0d || byte === 0x0a) {
          const value = new TextDecoder().decode(
            Uint8Array.from(this.inputBytes),
          );
          this.inputBytes = [];
          if (value) this.sendRaw(`PROVIDER_FIXTURE_ECHO:${value}\r\n`);
        } else {
          this.inputBytes.push(byte);
        }
      }
    }

    private sendRaw(text: string): void {
      const bytes = new TextEncoder().encode(text);
      if (text.includes("\x1b[c")) {
        fixtureWindow.__capProviderFixtureQueries?.push({
          name: "da1",
          bytes: [0x1b, 0x5b, 0x63],
        });
      }
      this.seq += bytes.length;
      this.dispatch({
        channel: "raw",
        data: textToBase64(text),
        seq: this.seq,
      });
    }

    private dispatch(frame: FixtureSocketFrame): void {
      if (this.readyState !== FixtureWebSocket.OPEN) return;
      this.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(frame) }),
      );
    }
  }

  window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket;
  return () => {
    for (const socket of sockets) socket.close(1000, "fixture restored");
    delete fixtureWindow.__capProviderFixtureAttachFrames;
    delete fixtureWindow.__capProviderFixtureConnectionOrigins;
    delete fixtureWindow.__capProviderFixtureAckSeqs;
    delete fixtureWindow.__capProviderFixtureResponses;
    delete fixtureWindow.__capProviderFixtureQueries;
    delete fixtureWindow.__capProviderFixtureProviderWrites;
    delete fixtureWindow.__capProviderFixtureCloseOpenSockets;
    delete fixtureWindow.__capProviderFixtureEmitRaw;
    window.WebSocket = NativeWebSocket;
  };
}
