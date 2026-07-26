import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from "@cap/contracts";

vi.mock("./config", () => ({
  wsUrl: () => "wss://terminal.example.test",
  operatorToken: () => "operator-token",
}));

import { TerminalSocket } from "./ws-client";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols: string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : undefined;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(frame: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  fail(code = 1011): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

function frames(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe("TerminalSocket native attachment protocol", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("consumes exactly one versioned attach attempt on every physical socket", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const terminal = new TerminalSocket("task-a", {
      onOpen() {
        expect(terminal.sendTerminalAttach(120, 40)).toBe(true);
        expect(terminal.sendTerminalAttach(80, 24)).toBe(false);
      },
    });

    terminal.connect();
    const first = MockWebSocket.instances[0];
    expect(first).toBeDefined();
    first?.open();
    expect(new URL(first?.url ?? "https://invalid").searchParams.get("taskId")).toBe(
      "task-a",
    );
    expect(frames(first as MockWebSocket)).toEqual([
      {
        channel: "control",
        type: "terminal_attach",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
        cols: 120,
        rows: 40,
      },
    ]);

    first?.fail();
    vi.runOnlyPendingTimers();
    const second = MockWebSocket.instances[1];
    expect(second).toBeDefined();
    second?.open();
    expect(frames(second as MockWebSocket)).toHaveLength(1);
    expect(frames(second as MockWebSocket)[0]?.type).toBe("terminal_attach");
    terminal.close();
  });

  it("keeps task binding immutable and preserves explicit response/input bytes", () => {
    const terminal = new TerminalSocket("task-a");
    terminal.connect();
    const socket = MockWebSocket.instances[0] as MockWebSocket;
    socket.open();
    terminal.sendTerminalAttach(80, 24);
    terminal.sendKeystrokeBytes("task-b", new Uint8Array([0x41]));
    terminal.sendKeystrokeBytes(
      "task-a",
      new Uint8Array([0x00, 0x80, 0xff]),
    );
    terminal.sendTerminalResponse(
      new TextEncoder().encode("\x1b[>0;276;0c"),
    );

    expect(frames(socket).slice(1)).toEqual([
      {
        channel: "control",
        type: "keystroke",
        sessionId: "task-a",
        data: "AID/",
      },
      {
        channel: "control",
        type: "terminal_response",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        data: "G1s+MDsyNzY7MGM=",
      },
    ]);
    terminal.close();
  });

  it("delivers raw bytes and native attachment state/geometry as validated frames", () => {
    const raw: Array<{ bytes: number[]; seq: number }> = [];
    const control: ControlFrameLike[] = [];
    const terminal = new TerminalSocket("task-a", {
      onRaw(bytes, seq) {
        raw.push({ bytes: [...bytes], seq });
      },
      onControl(frame) {
        control.push(frame);
      },
    });
    terminal.connect();
    const socket = MockWebSocket.instances[0] as MockWebSocket;
    socket.open();
    socket.receive({ channel: "raw", data: "AID/", seq: 3 });
    socket.receive({
      channel: "control",
      type: "terminal_attachment_state",
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      state: "attaching",
      cols: 80,
      rows: 24,
    });
    socket.receive({
      channel: "control",
      type: "terminal_geometry",
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      cols: 100,
      rows: 30,
    });

    expect(raw).toEqual([{ bytes: [0x00, 0x80, 0xff], seq: 3 }]);
    expect(control.map((frame) => frame.type)).toEqual([
      "terminal_attachment_state",
      "terminal_geometry",
    ]);
    terminal.close();
  });
});

type ControlFrameLike = { readonly type: string };
