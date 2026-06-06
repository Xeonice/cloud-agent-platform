/**
 * `SessionTerminal` — the CLIENT-ONLY live xterm surface + WS bridge
 * (tasks 18.2 + 18.4). Mounts inside the `ssr: false` route only.
 *
 * Responsibilities:
 *   - Mount the @cap/ui `<Terminal>` with a theme resolved from the page's
 *     `--terminal-*` CSS variables via `getComputedStyle` (CLIENT-ONLY, in an
 *     effect — never during render/SSR).
 *   - Construct ONE {@link TerminalSocket} for the task and wire handlers:
 *       onRaw  → write bytes to the terminal; ACK on flush; track highest seq.
 *       onOpen → sendReconnect(lastSeq, cols, rows); mark connection open.
 *       onClose/onError → reflect the state; NEVER crash.
 *       onControl → the control-frame bridge (snapshot / tail_replay /
 *                   lease_state / permission_request / pause / resume).
 *   - Forward command input as `sendKeystroke(sessionId, input + "\n")` once a
 *     sessionId has been captured from a lease_state/snapshot frame.
 *   - Surface the {@link ApprovalSurface} for a `permission_request` and resolve
 *     it lock-INDEPENDENTLY via `sendDecision` (D7).
 *   - Degrade to the {@link TerminalFallback} DOM line-view if xterm never
 *     becomes ready (dynamic import threw OR `onReady` did not fire in time).
 *
 * HONESTY: end-to-end streaming pends the aio-execution-hardening merge. The
 * wiring here is correct-by-construction; with no reachable socket it simply
 * stays in the connecting/closed state and shows honest fallback notices — it
 * NEVER fakes a connected terminal.
 *
 * SSR-safe: every window touch (xterm mount, socket, getComputedStyle,
 * clipboard, client id) lives in an effect or an event handler; nothing
 * non-deterministic runs during render or at module top-level.
 */
import * as React from "react";

// xterm's stylesheet is loaded once on the client (task 18.3). This route is
// `ssr: false`, so this CSS-only import is reached on the client where xterm
// actually renders; it carries no JS side effects that touch `window`.
import "@xterm/xterm/css/xterm.css";

import type { ITheme } from "@xterm/xterm";
import { Terminal, type TerminalHandle, type TerminalGeometry } from "@cap/ui";
import type { ControlFrame, DecisionBehavior } from "@cap/contracts";

import { TerminalSocket, decodeTailReplay } from "@/lib/ws-client";
import { getClientId } from "@/lib/client-id";
import { TerminalFallback, type FallbackLine } from "./terminal-fallback";
import { TerminalCommandInput } from "./terminal-command-input";
import { ApprovalSurface, type PendingApprovalView } from "./approval-surface";

/** Live socket lifecycle as the topbar/header pills should reflect it. */
export type ConnectionState = "connecting" | "open" | "closed" | "error";

/** Imperative API the page's topbar buttons drive the terminal through. */
export interface SessionTerminalHandle {
  /** Toggle the paused flag (暂停输出 / 恢复输出); returns the new paused state. */
  togglePause(): boolean;
  /** Serialize the current frame to the clipboard; resolves false on failure. */
  copySession(): Promise<boolean>;
}

export interface SessionTerminalProps {
  taskId: string;
  /** Left label of the terminal-head (`{agent} · {repo}#{branch}`). */
  headLabel: string;
  /** Lifted so the header/topbar pills reflect the REAL socket state. */
  onConnectionChange?: (state: ConnectionState) => void;
  /** Lifted so the 暂停输出 button copy flips with the paused flag. */
  onPausedChange?: (paused: boolean) => void;
}

/** How long to wait for xterm `onReady` before falling back to the DOM view. */
const XTERM_READY_TIMEOUT_MS = 4000;

/** The honest fallback notice lines per connection state (no fake output). */
function fallbackLines(state: ConnectionState): FallbackLine[] {
  const base: FallbackLine[] = [
    { text: "Agent 控制台 · 实时 CLI", tone: "dim" },
    { text: "", tone: "dim" },
  ];
  switch (state) {
    case "open":
      return [
        ...base,
        { text: "● 已连接，等待 PTY 输出…", tone: "ok" },
        { text: "终端渲染器不可用，已降级为文本视图。", tone: "warn" },
      ];
    case "connecting":
      return [
        ...base,
        { text: "○ 正在连接会话…", tone: "warn" },
        {
          text: "实时流将在 AIO 执行层接入后可用（待合并）。",
          tone: "dim",
        },
      ];
    case "error":
      return [
        ...base,
        { text: "× 连接失败。", tone: "err" },
        { text: "实时执行层尚未接入；这是预期内的降级状态。", tone: "dim" },
      ];
    case "closed":
    default:
      return [
        ...base,
        { text: "○ 未连接。", tone: "dim" },
        {
          text: "实时流将在 AIO 执行层接入后可用（待合并）。",
          tone: "dim",
        },
      ];
  }
}

/** Resolve a `--terminal-*` CSS variable to a hex/color string (client-only). */
function resolveVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

export const SessionTerminal = React.forwardRef<
  SessionTerminalHandle,
  SessionTerminalProps
>(function SessionTerminal(
  { taskId, headLabel, onConnectionChange, onPausedChange },
  ref,
): React.ReactElement {
  const socketRef = React.useRef<TerminalSocket | null>(null);
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const lastSeqRef = React.useRef(0);
  const sessionIdRef = React.useRef<string | null>(null);
  const pausedRef = React.useRef(false);
  const clientIdRef = React.useRef<string>("server");
  /** True while THIS client holds the write lease (drives heartbeat renewal). */
  const holdsLeaseRef = React.useRef(false);

  // Resolved xterm theme (client-only). `null` until the effect resolves it.
  const [theme, setTheme] = React.useState<ITheme | null>(null);
  const [fontSize, setFontSize] = React.useState(13);
  // Resolved `--font-mono` stack ("JetBrains Mono" …) so the live canvas matches
  // the prototype's `.xterm-host`/`.terminal-body`. Falls back to the literal
  // stack if the variable is unset; resolved client-only in the theme effect.
  const [fontFamily, setFontFamily] = React.useState(
    '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  );
  const [connection, setConnection] = React.useState<ConnectionState>(
    "connecting",
  );
  const [xtermReady, setXtermReady] = React.useState(false);
  const [xtermFailed, setXtermFailed] = React.useState(false);
  const [pending, setPending] = React.useState<PendingApprovalView | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");

  // Keep lifted-state callbacks fresh without re-running the mount effect.
  const onConnectionChangeRef = React.useRef(onConnectionChange);
  const onPausedChangeRef = React.useRef(onPausedChange);
  onConnectionChangeRef.current = onConnectionChange;
  onPausedChangeRef.current = onPausedChange;

  const setConnectionState = React.useCallback((state: ConnectionState) => {
    setConnection(state);
    onConnectionChangeRef.current?.(state);
  }, []);

  // ── Resolve the terminal theme from CSS vars (CLIENT-ONLY) ────────────────
  React.useEffect(() => {
    clientIdRef.current = getClientId();
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const bg = resolveVar(styles, "--terminal-bg") || "#050505";
    const fg = resolveVar(styles, "--terminal-fg") || "#e8e8e8";
    const muted = resolveVar(styles, "--terminal-muted") || "#8a8a8a";
    setTheme({
      background: bg,
      foreground: fg,
      cursor: fg,
      cursorAccent: bg,
      selectionBackground: muted,
    });
    // Resolve `--font-mono` so the live canvas renders in JetBrains Mono, matching
    // the prototype's `.xterm-host`/`.terminal-body` (and the DOM fallback view).
    const mono = resolveVar(styles, "--font-mono");
    if (mono) setFontFamily(mono);
    // 13px desktop / 12px on narrow viewports (matches the prototype scaling).
    const narrow =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px)").matches;
    setFontSize(narrow ? 12 : 13);
  }, []);

  // ── Control-frame bridge (task 18.4) ──────────────────────────────────────
  // Defined before the socket effect and held in a ref so the socket is
  // constructed exactly once (the effect depends only on `taskId`) while always
  // dispatching through the latest closure.
  const handleControl = React.useCallback(
    (frame: ControlFrame) => {
      switch (frame.type) {
        case "snapshot": {
          // Restore the serialized frame; align the ACK cursor to its offset.
          // (A snapshot carries no sessionId; lease_state supplies that.)
          handleRef.current?.write(frame.data);
          lastSeqRef.current = frame.seq;
          break;
        }
        case "tail_replay": {
          handleRef.current?.write(decodeTailReplay(frame.data));
          lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
          break;
        }
        case "lease_state": {
          // Capture the sessionId used by keystroke sends, and track whether
          // THIS client holds the write lease (drives heartbeat renewal). The
          // write-lease ownership is read via `holdsLeaseRef` (the heartbeat),
          // so it lives in a ref, not render state.
          sessionIdRef.current = frame.sessionId;
          setSessionId(frame.sessionId);
          holdsLeaseRef.current =
            frame.lease?.writerClientId === clientIdRef.current;
          break;
        }
        case "permission_request": {
          // Surface the approval; resolves lock-INDEPENDENTLY (D7).
          setPending({
            requestId: frame.requestId,
            toolName: frame.toolName,
          });
          break;
        }
        case "pause": {
          pausedRef.current = true;
          onPausedChangeRef.current?.(true);
          break;
        }
        case "resume": {
          pausedRef.current = false;
          onPausedChangeRef.current?.(false);
          break;
        }
        default:
          // Other control frames (ack/decision/heartbeat/dialback/connect_auth/
          // post_tool_use_report/reconnect/resize/takeover_request) are not
          // consumed by the browser session view.
          break;
      }
    },
    [],
  );
  const handleControlRef = React.useRef(handleControl);
  handleControlRef.current = handleControl;

  // ── Construct the socket + wire handlers (CLIENT-ONLY) ────────────────────
  React.useEffect(() => {
    const socket = new TerminalSocket(taskId, {
      onRaw(bytes, seq) {
        const handle = handleRef.current;
        if (!handle) return;
        // Paused: stop draining (don't write, don't ACK, don't advance the
        // reconnect cursor) so the server's un-ACK'd high-water mark applies
        // backpressure (pause the PTY) AND so a later reconnect still replays
        // this un-rendered window.
        if (pausedRef.current) return;
        // Write straight to the terminal (raw bytes bypass Query, D5.4). Advance
        // the reconnect high-water mark and ACK ONLY after xterm has flushed the
        // chunk — `lastSeq` must track only bytes the client actually rendered,
        // or reconnect would skip replaying output that arrived while paused or
        // before xterm mounted.
        handle.write(bytes, () => {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
          socketRef.current?.sendAck(seq);
        });
      },
      onControl(frame) {
        handleControlRef.current(frame);
      },
      onOpen() {
        const geo = handleRef.current?.geometry();
        socket.sendReconnect(lastSeqRef.current, geo?.cols, geo?.rows);
        setConnectionState("open");
      },
      onClose() {
        setConnectionState("closed");
      },
      onError() {
        setConnectionState("error");
      },
    });
    socketRef.current = socket;
    setConnectionState("connecting");
    // `connect()` can throw SYNCHRONOUSLY before the socket ever opens — e.g.
    // `wsUrl()` throws when `VITE_WS_URL` is unset. That must NOT crash the page
    // (the route has no errorComponent); degrade to the error state so the
    // fallback line-view + 连接失败 pill render and the page stays usable.
    try {
      socket.connect();
    } catch {
      setConnectionState("error");
    }

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [taskId, setConnectionState]);

  // ── Lease heartbeat: renew the write lease while THIS client holds it ──────
  // Only renews when a lease was actually granted to this client (D7); a no-op
  // otherwise (no session/lease yet, or another client is the writer).
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const sid = sessionIdRef.current;
      if (sid && holdsLeaseRef.current) {
        socketRef.current?.sendHeartbeat(sid, clientIdRef.current);
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Decision (lock-independent approval resolution, D7) ───────────────────
  const decide = React.useCallback(
    (requestId: string, behavior: DecisionBehavior) => {
      socketRef.current?.sendDecision(requestId, { behavior });
      setPending((current) =>
        current?.requestId === requestId ? null : current,
      );
    },
    [],
  );

  // ── Command send (lease-constrained server-side) ──────────────────────────
  const sendCommand = React.useCallback(() => {
    const value = input.trim();
    if (!value) return;
    const sid = sessionIdRef.current;
    // No-op without a captured sessionId/socket (no lease established yet).
    if (sid) socketRef.current?.sendKeystroke(sid, `${input}\n`);
    setInput("");
  }, [input]);

  // ── xterm readiness watchdog → fallback if it never mounts ────────────────
  React.useEffect(() => {
    if (xtermReady) return;
    const timer = window.setTimeout(() => {
      if (!handleRef.current) setXtermFailed(true);
    }, XTERM_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [xtermReady]);

  // ── Imperative API for the topbar buttons ─────────────────────────────────
  React.useImperativeHandle(
    ref,
    () => ({
      togglePause() {
        const next = !pausedRef.current;
        pausedRef.current = next;
        onPausedChangeRef.current?.(next);
        return next;
      },
      async copySession() {
        const serialized = handleRef.current?.serialize() ?? null;
        if (serialized == null) return false;
        try {
          if (
            typeof navigator !== "undefined" &&
            navigator.clipboard?.writeText
          ) {
            await navigator.clipboard.writeText(serialized);
            return true;
          }
        } catch {
          // Clipboard may be unavailable/denied; degrade gracefully.
        }
        return false;
      },
    }),
    [],
  );

  const showFallback = xtermFailed;
  const commandDisabled = !sessionId; // No lease/session captured → send is a no-op.

  return (
    <article className="overflow-hidden rounded-md bg-terminal-bg text-terminal-fg shadow-terminal min-h-[min(820px,calc(100vh-210px))]">
      {/* terminal-head */}
      <div className="flex min-h-[40px] items-center justify-between border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
        <span>{headLabel}</span>
        <span className="font-mono">pty: /dev/pts/4</span>
      </div>

      {/* permission_request approval (lock-independent, D7) */}
      {pending ? <ApprovalSurface request={pending} onDecide={decide} /> : null}

      {/* xterm-host — live terminal, OR the fallback line-view when unavailable */}
      {showFallback ? (
        <TerminalFallback lines={fallbackLines(connection)} />
      ) : (
        <div className="min-h-[min(680px,calc(100vh-348px))] bg-[#050505] px-4 py-3.5">
          {theme ? (
            <Terminal
              theme={theme}
              fontSize={fontSize}
              lineHeight={1.45}
              fontFamily={fontFamily}
              className="h-full"
              onReady={(handle) => {
                handleRef.current = handle;
                setXtermReady(true);
              }}
              onResize={(geometry: TerminalGeometry) => {
                socketRef.current?.sendResize(geometry.cols, geometry.rows);
              }}
              onData={(data) => {
                // Direct xterm keystrokes are lease-gated server-side; forward
                // them through the same keystroke path when a session is known.
                const sid = sessionIdRef.current;
                if (sid) socketRef.current?.sendKeystroke(sid, data);
              }}
            />
          ) : null}
        </div>
      )}

      {/* command input (shared with the fallback) */}
      <TerminalCommandInput
        value={input}
        onValueChange={setInput}
        onSubmit={sendCommand}
        disabled={commandDisabled}
      />
    </article>
  );
});
