import type { ProviderTerminalFixture } from "./provider-terminal-fixtures";

type FixtureSocketFrame =
  | {
      readonly channel: "raw";
      readonly data: string;
      readonly seq: number;
    }
  | {
      readonly channel: "control";
      readonly type: string;
      readonly [key: string]: unknown;
    };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToText(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

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
  const sockets = new Set<FixtureWebSocket>();

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
    private seq = 0;
    private input = "";
    private readonly taskId: string;

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
      let frame: FixtureSocketFrame | null = null;
      try {
        frame = JSON.parse(data) as FixtureSocketFrame;
      } catch {
        return;
      }
      if (!frame || frame.channel !== "control") return;
      this.handleClientControl(frame);
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
      if (type === "message") this.onmessage = invoke as (event: MessageEvent) => void;
    }

    removeEventListener(): void {
      // TerminalSocket uses property handlers. The fixture keeps this method only
      // for WebSocket shape compatibility.
    }

    dispatchEvent(event: Event): boolean {
      if (event.type === "open") this.onopen?.(event);
      if (event.type === "close") this.onclose?.(event as CloseEvent);
      if (event.type === "error") this.onerror?.(event);
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
      return true;
    }

    private handleClientControl(frame: FixtureSocketFrame): void {
      if (frame.channel !== "control") return;
      switch (frame.type) {
        case "reconnect":
          this.sendReconnectFrames(frame);
          break;
        case "resize":
          if (
            typeof frame.cols === "number" &&
            Number.isFinite(frame.cols) &&
            typeof frame.rows === "number" &&
            Number.isFinite(frame.rows)
          ) {
            this.sendRaw(
              `PROVIDER_FIXTURE_RESIZE:${Math.round(frame.cols)}x${Math.round(frame.rows)}\r\n`,
            );
          }
          break;
        case "takeover_request":
          this.sendLeaseState();
          break;
        case "keystroke":
          if (typeof frame.data === "string") this.handleKeystroke(frame.data);
          break;
        default:
          break;
      }
    }

    private sendReconnectFrames(frame: FixtureSocketFrame): void {
      const cols =
        frame.channel === "control" && typeof frame.cols === "number"
          ? Math.max(1, Math.round(frame.cols))
          : 80;
      const rows =
        frame.channel === "control" && typeof frame.rows === "number"
          ? Math.max(1, Math.round(frame.rows))
          : 24;
      this.seq += new TextEncoder().encode(fixture.frames.snapshot).byteLength;
      this.dispatch({
        channel: "control",
        type: "snapshot",
        data: fixture.frames.snapshot,
        cols,
        rows,
        seq: this.seq,
      });
      this.seq += new TextEncoder().encode(fixture.frames.tail).byteLength;
      this.dispatch({
        channel: "control",
        type: "tail_replay",
        data: textToBase64(fixture.frames.tail),
        seq: this.seq,
        final: true,
      });
      this.sendLeaseState();
      this.sendRaw(`PROVIDER_FIXTURE_RESIZE:${cols}x${rows}\r\n`);
      fixture.frames.live.forEach((line, index) => {
        window.setTimeout(() => this.sendRaw(line), 80 + index * 80);
      });
    }

    private sendLeaseState(): void {
      this.dispatch({
        channel: "control",
        type: "lease_state",
        sessionId: this.taskId,
        lease: {
          writerClientId: "provider-fixture-writer",
          leaseExpiry: Date.now() + 30_000,
        },
      });
    }

    private handleKeystroke(data: string): void {
      const text = base64ToText(data);
      if (text === "\r" || text === "\n") {
        const value = this.input;
        this.input = "";
        if (value) {
          this.sendRaw(`PROVIDER_FIXTURE_ECHO:${value}\r\n`);
        }
        return;
      }
      this.input += text;
    }

    private sendRaw(text: string): void {
      this.seq += new TextEncoder().encode(text).byteLength;
      this.dispatch({
        channel: "raw",
        data: textToBase64(text),
        seq: this.seq,
      });
    }

    private dispatch(frame: FixtureSocketFrame): void {
      if (this.readyState !== FixtureWebSocket.OPEN) return;
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify(frame),
        }),
      );
    }
  }

  window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket;
  return () => {
    for (const socket of sockets) {
      socket.close(1000, "fixture restored");
    }
    window.WebSocket = NativeWebSocket;
  };
}
