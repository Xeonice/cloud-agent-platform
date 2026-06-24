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
 *   - Forward LIVE input as a true 1:1 surface: each xterm keystroke flows
 *     verbatim through `onData → sendKeystroke` (no separate command box, no
 *     submit hack). The command input is retained ONLY for the xterm-unavailable
 *     fallback line-view, where there is no terminal to type into.
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
//
// NOTE (rendering fidelity): `@xterm/xterm` is pinned ^5.5.0, which does NOT
// support DEC synchronized-output (mode 2026, landed in xterm 6.0.0). codex's
// TUI emits `ESC[?2026h/l` around each full-grid repaint; 5.5.0 ignores them
// harmlessly (no corruption), but rapid repaints may briefly FLICKER without
// atomic batching. A `@xterm/xterm` 6.x upgrade is a separate, OPTIONAL anti-
// flicker follow-up — it is NOT required for input/render correctness.
import "@xterm/xterm/css/xterm.css";

import type { ITheme } from "@xterm/xterm";
import { Terminal, type TerminalHandle, type TerminalGeometry } from "@cap/ui";
import type { ControlFrame } from "@cap/contracts";

import { TerminalSocket, decodeTailReplay } from "@/lib/ws-client";
import { getClientId } from "@/lib/client-id";
import { TerminalFallback, type FallbackLine } from "./terminal-fallback";
import { TerminalCommandInput } from "./terminal-command-input";
import { stripAltScreen, stripAltScreenBytes } from "./cast-log";

/** Live socket lifecycle as the terminal-head connection readout reflects it. */
export type ConnectionState = "connecting" | "open" | "closed" | "error";

/**
 * Imperative API. The terminal's OWN ⋯ menu drives copy/pause directly. (The
 * page-level approval banner + the lift of `pending`/`decide` to the route are
 * DEFERRED to a follow-up approval change; the approval stays in-terminal here.)
 */
export interface SessionTerminalHandle {
  /** Toggle the paused flag (暂停滚动 / 恢复滚动); returns the new paused state. */
  togglePause(): boolean;
  /** Serialize the current frame to the clipboard; resolves false on failure. */
  copySession(): Promise<boolean>;
}

export interface SessionTerminalProps {
  taskId: string;
  /** Left label of the terminal-head (`{agent} · {repo}#{branch}`). */
  headLabel: string;
  /** Statusline phase label (degraded: 等待审批 while pending | generic 运行中). */
  phaseLabel: string;
  /** Whether the phase is the in-flight write-gate (drives the amber tone). */
  phasePending?: boolean;
  /** Statusline CPU·内存 readout (already honest-rendered by `formatTaskResource`). */
  resourceLabel: string;
  /** Lifted so the header/topbar pills reflect the REAL socket state. */
  onConnectionChange?: (state: ConnectionState) => void;
  /** Lifted so the 暂停滚动 menu copy flips with the paused flag. */
  onPausedChange?: (paused: boolean) => void;
}

/**
 * How long to wait for xterm `onReady` before falling back to the DOM view.
 *
 * Tolerant of a SLOW init: on a wide viewport the terminal surface is large and
 * xterm's async build (dynamic import + `open` + `fit`) legitimately takes several
 * seconds, so a tight budget wrongly declared a merely-slow xterm "failed" and
 * stranded the terminal on the read-only fallback (an over-aggressive 4s did this
 * intermittently on wide screens). The watchdog is for a GENUINE failure (import
 * threw / canvas never mounts), not slowness — paired with the `onReady` recovery
 * (which clears `xtermFailed` if xterm becomes ready late), an over-budget-but-
 * eventually-ready terminal self-heals instead of staying degraded.
 */
const XTERM_READY_TIMEOUT_MS = 15_000;

/**
 * Debounce (ms) for the live viewport scroll-area sync. xterm does NOT auto-sync
 * the viewport's scrollHeight to the buffer as live output accrues (measured: the
 * buffer accumulates scrollback but the viewport stays at one screen until
 * `syncScrollArea` fires), so the live terminal can't be scrolled back even though
 * the history is in the buffer (fix-live-terminal-scrollback). After writes settle
 * we trigger a local-only resize nudge once; a short window coalesces the bursty
 * live stream so it is not per-chunk.
 */
const VIEWPORT_SYNC_DEBOUNCE_MS = 120;

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

/**
 * Terminal-head connection readout — a dot + text reflecting the REAL socket
 * state (never hardcoded). Only the in-flight `connecting` dot pulses.
 */
const CONNECTION_META: Record<
  ConnectionState,
  { label: string; dot: string; pulse: boolean }
> = {
  open: { label: "已连接", dot: "bg-[#34d399]", pulse: false },
  connecting: { label: "连接中", dot: "bg-[#fbbf24]", pulse: true },
  error: { label: "连接失败", dot: "bg-[#ff7b72]", pulse: false },
  closed: { label: "未连接", dot: "bg-terminal-muted", pulse: false },
};

export const SessionTerminal = React.forwardRef<
  SessionTerminalHandle,
  SessionTerminalProps
>(function SessionTerminal(
  {
    taskId,
    headLabel,
    phaseLabel,
    phasePending = false,
    resourceLabel,
    onConnectionChange,
    onPausedChange,
  },
  ref,
): React.ReactElement {
  const socketRef = React.useRef<TerminalSocket | null>(null);
  const handleRef = React.useRef<TerminalHandle | null>(null);
  /** The terminal `<article>` — the fullscreen target (full window, no overlay). */
  const shellRef = React.useRef<HTMLElement | null>(null);
  const lastSeqRef = React.useRef(0);
  const sessionIdRef = React.useRef<string | null>(null);
  const pausedRef = React.useRef(false);
  const clientIdRef = React.useRef<string>("server");
  /** True once this connection has seized the write lease via takeover. */
  const claimedRef = React.useRef(false);
  /** Debounce handle for the live viewport scroll-area sync (see syncViewportSoon). */
  const viewportSyncTimerRef = React.useRef<number | null>(null);
  /** True during a viewport-sync resize nudge so onResize skips sendResize — the
   *  nudge is a LOCAL-ONLY trigger for xterm's syncScrollArea and must NOT perturb
   *  the codex PTY (fix-live-terminal-scrollback). */
  const suppressResizeRef = React.useRef(false);

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
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");
  // `paused` mirrors `pausedRef` for the ⋯ menu label (暂停滚动/恢复滚动); the ref
  // stays the source of truth on the hot onRaw path. `fullscreen` tracks the
  // article's fullscreen state for the 全屏/退出全屏 toggle icon.
  const [paused, setPaused] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);

  // Keep lifted-state callbacks fresh without re-running the mount effect.
  const onConnectionChangeRef = React.useRef(onConnectionChange);
  const onPausedChangeRef = React.useRef(onPausedChange);
  onConnectionChangeRef.current = onConnectionChange;
  onPausedChangeRef.current = onPausedChange;

  const setConnectionState = React.useCallback((state: ConnectionState) => {
    setConnection(state);
    onConnectionChangeRef.current?.(state);
  }, []);

  // Sync xterm's viewport scroll-area to the accumulating buffer on the LIVE
  // stream so the operator can scroll back through history while the task runs.
  // xterm does NOT auto-sync the viewport as output accrues (the buffer fills but
  // `.xterm-viewport.scrollHeight` lags until syncScrollArea fires), so without
  // this the live terminal stays pinned to one screen. Debounced (coalesces the
  // bursty live stream). The trigger is a LOCAL-ONLY resize nudge: `cols`
  // unchanged (no wrap reflow), `rows` +1 then back; `suppressResizeRef` makes
  // onResize skip sendResize so the codex PTY is never perturbed by the nudge.
  const syncViewportSoon = React.useCallback(() => {
    if (viewportSyncTimerRef.current !== null) return;
    viewportSyncTimerRef.current = window.setTimeout(() => {
      viewportSyncTimerRef.current = null;
      const handle = handleRef.current;
      const g = handle?.geometry();
      if (!handle || !g) return;
      suppressResizeRef.current = true;
      handle.resize(g.cols, g.rows + 1);
      handle.resize(g.cols, g.rows);
      suppressResizeRef.current = false;
    }, VIEWPORT_SYNC_DEBOUNCE_MS);
  }, []);
  // Held in a ref so the once-constructed socket's onRaw closure always calls the
  // latest (stable) syncViewportSoon without re-running the socket effect.
  const syncViewportSoonRef = React.useRef(syncViewportSoon);
  syncViewportSoonRef.current = syncViewportSoon;

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
          // Strip the alt-screen switch (the tmux client's) so the restored frame
          // lands in the normal buffer — otherwise the snapshot puts xterm into the
          // alternate buffer and every later onRaw write (even stripped) accrues no
          // scrollback (fix-live-terminal-scrollback-strip). snapshot.data is a string.
          handleRef.current?.write(stripAltScreen(frame.data));
          lastSeqRef.current = frame.seq;
          break;
        }
        case "tail_replay": {
          // Same alt-screen strip on the reconnect tail (Uint8Array bytes).
          handleRef.current?.write(
            stripAltScreenBytes(decodeTailReplay(frame.data)),
          );
          lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
          break;
        }
        case "lease_state": {
          // The server AUTO-GRANTS this connection the write lease the moment its
          // auth resolves (gateway grantWriteLeaseIfFree), then broadcasts here.
          // Ignore a foreign sessionId defensively (the broadcast is already
          // recipient-filtered by task server-side). A NON-NULL lease means write
          // access is held for this session, so capture the sessionId (== taskId)
          // that the keystroke/heartbeat sends use — which also enables the
          // command input (commandDisabled = !sessionId). We do NOT compare
          // `writerClientId` (the server keys the lease by its own connection id,
          // never our getClientId()), and once captured we KEEP the sessionId so
          // the 15s heartbeat keeps renewing/self-healing across a transient
          // lease=null frame rather than going silently read-only.
          if (frame.sessionId !== taskId) break;
          if (frame.lease) {
            sessionIdRef.current = frame.sessionId;
            setSessionId(frame.sessionId);
          }
          break;
        }
        case "permission_request": {
          // Track 8: the agent runs ungated inside the sandbox, so a
          // permission_request is never expected. Ignore it (no approval surface).
          break;
        }
        case "pause": {
          pausedRef.current = true;
          setPaused(true);
          onPausedChangeRef.current?.(true);
          break;
        }
        case "resume": {
          pausedRef.current = false;
          setPaused(false);
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
    // `taskId` is read in the lease_state guard, so the closure must track it
    // (the route can swap params without remounting this component).
    [taskId],
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
        // before xterm mounted. Strip the alt-screen switch first (the tmux attach
        // client's own — tmux options can't suppress it) so the live stream lands
        // in the NORMAL buffer and accrues scrollback (fix-live-terminal-scrollback-strip).
        handle.write(stripAltScreenBytes(bytes), () => {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
          socketRef.current?.sendAck(seq);
          // Keep the viewport scrollable as live output accrues (debounced).
          syncViewportSoonRef.current();
        });
      },
      onControl(frame) {
        handleControlRef.current(frame);
      },
      onOpen() {
        const geo = handleRef.current?.geometry();
        socket.sendReconnect(lastSeqRef.current, geo?.cols, geo?.rows);
        // Sync the sandbox PTY to the browser size NOW that the socket is OPEN.
        // The xterm `onResize` that fires at mount races this open and is dropped
        // (sendFrame only transmits when OPEN), and the reconnect frame above does
        // not resize the PTY — so without this the sandbox PTY stays at the AIO
        // default 80×24 while the browser auto-fits wider, misaligning codex's
        // cursor-addressed history. Drives gateway.onResize → pty.resize +
        // snapshot headless resize.
        if (geo) socket.sendResize(geo.cols, geo.rows);
        // sessionId == taskId; capture it on connect so the command input is
        // enabled. Safe (no longer the swallowed-keystroke hazard) because the
        // operator's first interaction SEIZES the write lease (sendCommand /
        // onData), so an enabled input the operator types into always becomes the
        // writer rather than silently dropping. Reset the claim flag so a fresh
        // connection re-seizes on the next interaction.
        claimedRef.current = false;
        sessionIdRef.current = taskId;
        setSessionId(taskId);
        setConnectionState("open");
      },
      onClose(_event, willReconnect) {
        // A transient drop auto-reconnects (backoff): surface "connecting" so the
        // pill reads as reconnecting rather than a dead session. A terminal close
        // (clean / auth / retry budget exhausted) stays "closed".
        setConnectionState(willReconnect ? "connecting" : "closed");
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
      if (viewportSyncTimerRef.current !== null) {
        window.clearTimeout(viewportSyncTimerRef.current);
        viewportSyncTimerRef.current = null;
      }
    };
  }, [taskId, setConnectionState]);

  // ── Lease heartbeat: renew the write lease by CONNECTION identity ──────────
  // The server keys the lease by the socket's own clientId and IGNORES the
  // frame's `writerClientId`, so a heartbeat from THIS connection renews ITS
  // lease (and is a harmless Denied no-op from a non-writer reader). We cannot
  // gate on a clientId compare here — the server's lease holder is a
  // server-assigned connection id, never our `getClientId()`. Gating on a known
  // sessionId is sufficient: only a session we've joined gets a heartbeat.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const sid = sessionIdRef.current;
      if (sid) {
        socketRef.current?.sendHeartbeat(sid, clientIdRef.current);
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Recover a silently-dropped socket on focus / network return ───────────
  // A backgrounded tab's WS can be closed by the proxy (Cloudflare's ~100s idle
  // timeout) or by a laptop sleep without the page noticing until the operator
  // returns. When the tab regains visibility or the browser reports the network
  // is back, eagerly re-open the socket (skipping the backoff wait) so the
  // operator never types into a dead connection. `ensureConnected` is a no-op
  // when the socket is already open/connecting or was intentionally closed.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        socketRef.current?.ensureConnected();
      }
    };
    const onOnline = () => socketRef.current?.ensureConnected();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // WRITE-LEASE MODEL: the gateway auto-grants the lease on connect-time auth
  // (when free), AND the operator SEIZES it on first interaction via takeover
  // (see sendCommand / onData) — so the ACTIVE operator is always the writer,
  // even when a stale/ghost connection (e.g. a navigated-away tab whose WS
  // lingered server-side over the tunnel) still holds the lease. The takeover is
  // interaction-triggered, i.e. well after connect-time auth, so it never races
  // the async auth the way an earlier connect-time claim did. The 15s heartbeat
  // renews the held lease; the gateway self-heals a lapsed lease for its prior
  // holder and re-grants a freed lease to a still-connected operator on disconnect.
  //
  // Trade-off (fine for the single-operator owner model): two operators on the
  // SAME task is last-typer-wins — whoever types takes the lease. There is no
  // per-recipient ownership signal on the wire, so a reader's input box still
  // shows enabled, but typing now CLAIMS the lease rather than being dropped.
  // RESILIENCE: a transient WS close (e.g. Cloudflare's ~100s idle timeout) now
  // AUTO-RECONNECTS with backoff inside TerminalSocket; onOpen re-sends the
  // restoration frame and the next interaction re-seizes the lease, so a network
  // blip self-heals without a reload. The tab also eagerly reconnects on focus /
  // network-return via ensureConnected (see the visibility/online effect above).

  // (Approval-decision handler removed — Track 8: the agent runs ungated; no
  // permission_request is ever surfaced, so there is nothing to decide.)

  // ── Pause + copy (driven by the terminal's OWN ⋯ menu and the handle) ─────
  const togglePause = React.useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    onPausedChangeRef.current?.(next);
    return next;
  }, []);

  const copySession = React.useCallback(async () => {
    // Custom copy (NOT native selection): xterm sets user-select:none on its
    // a11y tree, so rely on the serialized frame + Clipboard API.
    const serialized = handleRef.current?.serialize() ?? null;
    if (serialized == null) return false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(serialized);
        return true;
      }
    } catch {
      // Clipboard may be unavailable/denied; degrade gracefully.
    }
    return false;
  }, []);

  // ── Fullscreen the terminal window (the `<article>`, no overlay) ──────────
  const toggleFullscreen = React.useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen?.();
    } else {
      void el.requestFullscreen?.();
    }
  }, []);
  React.useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ── Command send — FALLBACK line-view ONLY ────────────────────────────────
  // The LIVE xterm is 1:1 direct-input via onData (this submit path is NOT wired
  // there). This remains only for the xterm-unavailable fallback, where there is
  // no terminal to type into and a line input is the only way to drive codex.
  const sendCommand = React.useCallback(() => {
    const value = input.trim();
    if (!value) return;
    const sock = socketRef.current;
    if (!sock) return;
    // sessionId == taskId in this protocol. SEIZE the write lease for THIS
    // connection first (takeover) so the active operator's command is never
    // silently dropped because a stale/ghost connection still holds the lease,
    // then send the text and a CARRIAGE RETURN (codex's TUI submits the composer
    // on `\r`, the Enter key; a `\n` linefeed is an inserted newline, not submit).
    sock.sendTakeover(taskId, clientIdRef.current);
    claimedRef.current = true;
    sock.sendKeystroke(taskId, value);
    // Send Enter (CR) as a SEPARATE, slightly-delayed keystroke. NOTE: the prior
    // rationale (codex coalesces a text+immediate-CR burst into a PASTE) was found
    // INACCURATE — paste is detected by the ESC[200~/201~ bracketed-paste markers
    // a terminal adds, never by arrival timing. The small delay is retained here
    // only as a conservative belt-and-suspenders for this rarely-exercised,
    // PROGRAMMATIC burst in the degraded fallback; the live 1:1 path (human typing
    // via onData) needs no such delay and has none.
    window.setTimeout(() => socketRef.current?.sendKeystroke(taskId, "\r"), 150);
    setInput("");
  }, [input, taskId]);

  // ── xterm readiness watchdog → fallback if it never mounts ────────────────
  React.useEffect(() => {
    if (xtermReady) return;
    const timer = window.setTimeout(() => {
      if (!handleRef.current) setXtermFailed(true);
    }, XTERM_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [xtermReady]);

  // ── Focus the live xterm on mount ─────────────────────────────────────────
  // With the command input removed from the live path, focus the terminal so
  // keystrokes are captured without requiring a click first. Uses the scoped
  // TerminalHandle.focus() (xterm's public Terminal.focus()) — NOT an unscoped
  // document.querySelector on xterm's internal class. (Track 8: the approval
  // surface is gone, so focus no longer needs to defer to it.)
  React.useEffect(() => {
    if (!xtermReady) return;
    handleRef.current?.focus();
  }, [xtermReady]);

  // ── Imperative API for the terminal ⋯ menu / page ─────────────────────────
  React.useImperativeHandle(
    ref,
    () => ({ togglePause, copySession }),
    [togglePause, copySession],
  );

  const showFallback = xtermFailed;
  // Disable unless we have a session AND the socket is actually OPEN: a frame
  // sent while reconnecting/closed/errored is silently dropped by the socket
  // (sendFrame only sends when OPEN), which is the exact "command had no effect"
  // trap — so the input must not invite typing into a non-deliverable socket.
  const commandDisabled = !sessionId || connection !== "open";

  const conn = CONNECTION_META[connection];

  return (
    <article
      ref={shellRef}
      // FILLS its flex slot rather than sizing itself off a fixed `100dvh − Npx`
      // magic number. The route wraps this in a `flex-1 min-h-0` section inside
      // the app-shell inset, which is pinned to the viewport on the session route
      // (`h-dvh overflow-hidden` in `_app.tsx`). So `h-full min-h-0` makes the
      // terminal occupy exactly the space below the (variable-height) page header
      // down to the inset's bottom padding — no page overflow, no empty gap.
      // `overflow-hidden` keeps the xterm scrolling INSIDE (its viewport scrollbar
      // is hidden via app.css). Fullscreen fills the whole screen.
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-terminal-bg text-terminal-fg shadow-terminal [&:fullscreen]:h-screen [&:fullscreen]:rounded-none"
    >
      {/* terminal-head (three-segment, dark) — `{agent} · {repo}#{branch}` label
          + connection readout (left); ⋯ menu (复制 / 暂停滚动) + 全屏 (right). The
          design mock's `pty: /dev/pts/4` line is intentionally NOT rendered: no
          backend field backs a pty path, and fabricated values are prohibited. */}
      <div className="flex min-h-[38px] flex-none items-center justify-between gap-3 border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate font-semibold text-terminal-fg">
            {headLabel}
          </span>
          <span className="inline-flex flex-none items-center gap-1.5 text-[11px]">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${conn.dot} ${conn.pulse ? "animate-status-pulse" : ""}`}
            />
            {conn.label}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1">
          <details className="relative">
            <summary
              aria-label="更多终端操作"
              className="grid size-7 cursor-pointer list-none place-items-center rounded-md text-terminal-muted transition-colors hover:bg-white/10 hover:text-terminal-fg [&::-webkit-details-marker]:hidden"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                className="size-[15px]"
              >
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </summary>
            <div className="absolute right-0 top-[calc(100%+8px)] z-10 grid min-w-[148px] gap-0.5 rounded-lg bg-[#111] p-1 shadow-[0_0_0_1px_var(--terminal-line),0_14px_36px_rgba(0,0,0,0.4)]">
              <button
                type="button"
                data-copy-session
                onClick={(e) => {
                  void copySession();
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="min-h-[30px] rounded-md px-2.5 text-left text-terminal-fg transition-colors hover:bg-white/10"
              >
                复制记录
              </button>
              <button
                type="button"
                data-terminal-pause
                onClick={(e) => {
                  togglePause();
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="min-h-[30px] rounded-md px-2.5 text-left text-terminal-fg transition-colors hover:bg-white/10"
              >
                {paused ? "恢复滚动" : "暂停滚动"}
              </button>
            </div>
          </details>
          <button
            type="button"
            data-terminal-fullscreen
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            aria-label="切换终端全屏"
            className="grid size-7 place-items-center rounded-md text-terminal-muted transition-colors hover:bg-white/10 hover:text-terminal-fg"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-[14px]"
            >
              {fullscreen ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" x2="21" y1="10" y2="3" />
                  <line x1="3" x2="10" y1="21" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" x2="14" y1="3" y2="10" />
                  <line x1="3" x2="10" y1="21" y2="14" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* The write-gate / permission_request approval surface is REMOVED
          (pixel-restore-console-to-od Track 8): both runtimes run ungated inside
          the sandbox (the trust boundary), so no approval is ever surfaced. */}

      {/* xterm-host — live terminal (direct 1:1 input via onData), OR the
          fallback line-view (which keeps the command input) when xterm fails. */}
      {/* xterm-host — the live terminal is ALWAYS mounted (when theme is ready) so
          a slow/wide init can finish and fire onReady EVEN AFTER the readiness
          watchdog fired; the read-only fallback renders as an OVERLAY on top while
          `xtermFailed`, NOT as a sibling that unmounts <Terminal>. Unmounting
          <Terminal> would set disposed=true so the late onReady never lands and the
          watchdog flip would be permanent (the V.1 defect) — with the overlay a
          late onReady calls setXtermFailed(false) and the real xterm self-heals. */}
      <div className="relative min-h-0 flex-1 bg-[#050505] px-4 py-3.5">
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
              // Recover from a LATE onReady: if the readiness watchdog already
              // flipped `xtermFailed` (a slow/wide init that overran the budget),
              // clear it so the live xterm replaces the fallback overlay. Because
              // <Terminal> stays MOUNTED under the overlay, this onReady DOES fire
              // even after the flip (unlike the prior sibling-unmount structure).
              setXtermFailed(false);
            }}
            onResize={(geometry: TerminalGeometry) => {
              // Skip the local-only viewport-sync nudge (rows ±1) — it must not
              // resize the codex PTY (fix-live-terminal-scrollback).
              if (suppressResizeRef.current) return;
              socketRef.current?.sendResize(geometry.cols, geometry.rows);
            }}
            onData={(data) => {
              // THE sole live input path (the command box is gone from this
              // path). Each xterm keystroke flows verbatim through the
              // lease-gated channel. Seize the write lease ONCE per connection
              // on first input (the act of typing claims control) so the active
              // operator is the writer even if a stale connection still held the
              // lease. xterm already encodes Enter as `\r`, so NO newline
              // translation here — a real Enter submits codex's composer.
              const sock = socketRef.current;
              if (!sock) return;
              if (!claimedRef.current) {
                sock.sendTakeover(taskId, clientIdRef.current);
                claimedRef.current = true;
              }
              sock.sendKeystroke(taskId, data);
            }}
          />
        ) : null}
        {/* Connection-state affordance: with the command box gone from the live
            path, keystrokes typed while the socket is not OPEN are silently
            dropped by sendFrame. Surface that as a small NON-blocking corner
            badge — NOT a full overlay — so an auto-reconnect window never hides
            the last codex frame the operator was watching. pointer-events-none
            keeps the terminal interactive; role=status/aria-live announces the
            state to assistive tech. */}
        {connection !== "open" ? (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="pointer-events-none absolute right-3 top-3 rounded border border-terminal-line bg-black/70 px-2 py-1 font-mono text-xs text-terminal-muted"
          >
            {connection === "connecting"
              ? "○ 正在连接…键入暂不发送"
              : connection === "error"
                ? "× 连接失败…键入暂不发送"
                : "○ 连接已断开…键入暂不发送"}
          </div>
        ) : null}
        {/* Read-only fallback OVERLAY — shown while xtermFailed, layered ON TOP of
            the still-mounted <Terminal> so a late onReady can recover. Retains the
            command input (the fallback's only input path); the live xterm path
            uses direct onData with no command box. */}
        {showFallback ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-[#050505]">
            <TerminalFallback lines={fallbackLines(connection)} />
            <TerminalCommandInput
              value={input}
              onValueChange={setInput}
              onSubmit={sendCommand}
              disabled={commandDisabled}
            />
          </div>
        ) : null}
      </div>

      {/* statusline footer (tmux-style) — the per-task resource readout + a
          degraded phase, INSIDE the terminal window (D3). CPU·内存 is already
          honest-rendered (未运行/未采样) by the route's `formatTaskResource`; the
          phase degrades to {等待审批 while pending | generic 运行中}. */}
      <div className="flex min-h-[30px] flex-none items-center justify-between gap-3 border-t border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-[11px] text-terminal-muted">
        <span
          className={
            "font-semibold " +
            (phasePending ? "text-[#fbbf24]" : "text-terminal-fg")
          }
        >
          {phaseLabel}
        </span>
        <span className="truncate">{resourceLabel}</span>
      </div>
    </article>
  );
});
