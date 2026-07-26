/**
 * Client-only native live terminal. Each physical browser WebSocket owns one
 * fresh viewer PTY; reconnect restores the current tmux frame from that viewer's
 * native byte stream and never consumes durable snapshot/tail history.
 */
import * as React from "react";
import "@xterm/xterm/css/xterm.css";

import type { ITheme } from "@xterm/xterm";
import { Terminal, type TerminalGeometry, type TerminalHandle } from "@cap/ui";
import type { ControlFrame } from "@cap/contracts";

import { TerminalSocket } from "@/lib/ws-client";
import { getClientId } from "@/lib/client-id";
import { TerminalCommandInput } from "./terminal-command-input";
import { TerminalFallback, type FallbackLine } from "./terminal-fallback";
import {
  terminalBinaryStringToBytes,
  terminalDataToBytes,
  tokenizeTerminalResponseBurst,
} from "./terminal-input-filter";

export type ConnectionState =
  | "connecting"
  | "attaching"
  | "open"
  | "unavailable"
  | "reload-required"
  | "closed"
  | "error";

export interface SessionTerminalHandle {
  togglePause(): boolean;
  copySession(): Promise<boolean>;
  fit(): TerminalGeometry | null;
  /** Read-only current xterm state for opt-in conformance stories. */
  serialize(): string | null;
  /** Read-only active viewport state; excludes hidden attach-shell history. */
  activeBufferSnapshot(): string | null;
  /** Read-only authoritative xterm grid for same-geometry comparisons. */
  geometry(): TerminalGeometry | null;
}

export interface SessionTerminalProps {
  taskId: string;
  headLabel: string;
  phaseLabel: string;
  phasePending?: boolean;
  resourceLabel: string;
  onConnectionChange?: (state: ConnectionState) => void;
  onPausedChange?: (paused: boolean) => void;
}

interface PendingRawWrite {
  readonly bytes: Uint8Array;
  readonly seq: number;
  readonly ordinal: number;
}

const XTERM_READY_TIMEOUT_MS = 15_000;
const LIVE_TERMINAL_SCROLLBACK = 100_000;
const DEFAULT_GEOMETRY: TerminalGeometry = { cols: 80, rows: 24 };

function resolveVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

function fallbackLines(state: ConnectionState): FallbackLine[] {
  const base: FallbackLine[] = [
    { text: "Agent 控制台 · 实时 CLI", tone: "dim" },
    { text: "", tone: "dim" },
  ];
  if (state === "open") {
    return [
      ...base,
      { text: "● 已连接，终端渲染器不可用。", tone: "warn" },
    ];
  }
  if (state === "reload-required") {
    return [
      ...base,
      { text: "× 终端协议或响应配置已变更，请刷新页面。", tone: "err" },
    ];
  }
  if (state === "unavailable") {
    return [...base, { text: "× 当前无法创建实时终端附件。", tone: "err" }];
  }
  if (state === "error") {
    return [...base, { text: "× 终端连接失败。", tone: "err" }];
  }
  return [
    ...base,
    {
      text: state === "attaching" ? "○ 正在还原当前终端画面…" : "○ 正在重连终端…",
      tone: "warn",
    },
  ];
}

const CONNECTION_META: Record<
  ConnectionState,
  { label: string; dot: string; pulse: boolean }
> = {
  open: { label: "已连接", dot: "bg-[#34d399]", pulse: false },
  connecting: { label: "连接中", dot: "bg-[#fbbf24]", pulse: true },
  attaching: { label: "正在还原", dot: "bg-[#fbbf24]", pulse: true },
  unavailable: { label: "附件不可用", dot: "bg-[#ff7b72]", pulse: false },
  "reload-required": { label: "需要刷新", dot: "bg-[#ff7b72]", pulse: false },
  error: { label: "连接失败", dot: "bg-[#ff7b72]", pulse: false },
  closed: { label: "未连接", dot: "bg-terminal-muted", pulse: false },
};

function attachmentStatusText(
  state: ConnectionState,
  reason: string | null,
): string {
  if (state === "reload-required") {
    return "终端协议不匹配，请刷新页面后重试";
  }
  if (state === "unavailable") {
    return `实时终端附件不可用${reason ? `：${reason}` : ""}`;
  }
  if (state === "error") {
    return `实时终端附件失败${reason ? `：${reason}` : ""}`;
  }
  if (state === "closed") return "终端连接已断开";
  return state === "attaching"
    ? "正在通过新终端附件还原当前画面…"
    : "正在重连终端…";
}

function concatBytes(items: readonly PendingRawWrite[]): Uint8Array {
  const length = items.reduce((total, item) => total + item.bytes.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const item of items) {
    output.set(item.bytes, offset);
    offset += item.bytes.length;
  }
  return output;
}

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
  const socketStartedRef = React.useRef(false);
  const startSocketRef = React.useRef<() => void>(() => undefined);
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const shellRef = React.useRef<HTMLElement | null>(null);
  const desiredGeometryRef = React.useRef<TerminalGeometry>(DEFAULT_GEOMETRY);
  const authoritativeGeometryRef = React.useRef<TerminalGeometry | null>(null);
  const sessionIdRef = React.useRef<string | null>(null);
  const clientIdRef = React.useRef("server");
  const pausedRef = React.useRef(false);
  const socketOpenRef = React.useRef(false);
  const terminalAttachOutcomeRef = React.useRef<
    "unavailable" | "reload-required" | "error" | null
  >(null);

  const pendingWritesRef = React.useRef<PendingRawWrite[]>([]);
  const writeInFlightRef = React.useRef(false);
  const animationFrameRef = React.useRef<number | null>(null);
  const attachmentEpochRef = React.useRef(0);
  const resettingRef = React.useRef(false);
  const receivedOrdinalRef = React.useRef(0);
  const flushedOrdinalRef = React.useRef(0);
  const readyOrdinalRef = React.useRef<number | null>(null);
  const terminalRevealedRef = React.useRef(false);

  const pendingTakeoverRef = React.useRef(false);
  const ownWriterIdRef = React.useRef<string | null>(null);
  const ownsLeaseRef = React.useRef(false);

  const [theme, setTheme] = React.useState<ITheme | null>(null);
  const [fontSize, setFontSize] = React.useState(13);
  const [fontFamily, setFontFamily] = React.useState(
    '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  );
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [attachmentReason, setAttachmentReason] = React.useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = React.useState(false);
  const [xtermReady, setXtermReady] = React.useState(false);
  const [xtermFailed, setXtermFailed] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");
  const [paused, setPaused] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);

  const onConnectionChangeRef = React.useRef(onConnectionChange);
  const onPausedChangeRef = React.useRef(onPausedChange);
  onConnectionChangeRef.current = onConnectionChange;
  onPausedChangeRef.current = onPausedChange;

  const setConnectionState = React.useCallback((state: ConnectionState) => {
    setConnection(state);
    onConnectionChangeRef.current?.(state);
  }, []);

  const applyAuthoritativeGeometry = React.useCallback(
    (geometry: TerminalGeometry): void => {
      authoritativeGeometryRef.current = geometry;
      handleRef.current?.resize(geometry.cols, geometry.rows);
    },
    [],
  );

  const maybeRevealRef = React.useRef<() => void>(() => undefined);
  const maybeReveal = React.useCallback(() => {
    const readyOrdinal = readyOrdinalRef.current;
    if (
      readyOrdinal === null ||
      resettingRef.current ||
      receivedOrdinalRef.current === 0 ||
      flushedOrdinalRef.current < readyOrdinal
    ) {
      return;
    }
    // Focus is part of the first reveal, not part of every subsequent xterm
    // write. A repaint or live agent chunk arriving after the operator clicked
    // elsewhere must never steal keyboard focus back into the terminal.
    if (terminalRevealedRef.current) return;
    terminalRevealedRef.current = true;
    setTerminalVisible(true);
    setAttachmentReason(null);
    setConnectionState("open");
    handleRef.current?.focus();
  }, [setConnectionState]);
  maybeRevealRef.current = maybeReveal;

  const flushPendingRef = React.useRef<() => void>(() => undefined);
  const scheduleFlushRef = React.useRef<() => void>(() => undefined);

  const flushPending = React.useCallback(() => {
    if (
      writeInFlightRef.current ||
      resettingRef.current ||
      pausedRef.current ||
      pendingWritesRef.current.length === 0
    ) {
      return;
    }
    const handle = handleRef.current;
    if (!handle) return;

    const epoch = attachmentEpochRef.current;
    const batch = pendingWritesRef.current.splice(0);
    const bytes = concatBytes(batch);
    const last = batch[batch.length - 1];
    if (!last) return;
    writeInFlightRef.current = true;
    handle.write(bytes, () => {
      if (epoch !== attachmentEpochRef.current) return;
      writeInFlightRef.current = false;
      flushedOrdinalRef.current = Math.max(
        flushedOrdinalRef.current,
        last.ordinal,
      );
      socketRef.current?.sendAck(last.seq);
      maybeRevealRef.current();
      scheduleFlushRef.current();
    });
  }, []);
  flushPendingRef.current = flushPending;

  const scheduleFlush = React.useCallback(() => {
    if (
      animationFrameRef.current !== null ||
      writeInFlightRef.current ||
      resettingRef.current ||
      pausedRef.current ||
      pendingWritesRef.current.length === 0
    ) {
      return;
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      flushPendingRef.current();
    });
  }, []);
  scheduleFlushRef.current = scheduleFlush;

  const beginAttachmentReset = React.useCallback(() => {
    terminalRevealedRef.current = false;
    setTerminalVisible(false);
    setAttachmentReason(null);
    terminalAttachOutcomeRef.current = null;
    setConnectionState("attaching");
    readyOrdinalRef.current = null;
    resettingRef.current = true;
    const epoch = attachmentEpochRef.current;
    const handle = handleRef.current;
    if (!handle) {
      resettingRef.current = false;
      return;
    }
    // Drain any old-generation xterm write callback before the synchronous full
    // reset. New-generation raw bytes remain in our queue until reset completes.
    handle.write(new Uint8Array(0), () => {
      if (epoch !== attachmentEpochRef.current) return;
      handle.reset();
      resettingRef.current = false;
      scheduleFlushRef.current();
      maybeRevealRef.current();
    });
  }, [setConnectionState]);

  const reportDesiredGeometry = React.useCallback(() => {
    if (!ownsLeaseRef.current && !pendingTakeoverRef.current) return;
    const geometry = desiredGeometryRef.current;
    socketRef.current?.sendResize(geometry.cols, geometry.rows);
  }, []);

  const claimWriter = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || ownsLeaseRef.current || pendingTakeoverRef.current) return;
    pendingTakeoverRef.current = true;
    socket.sendTakeover(taskId, clientIdRef.current);
    // WebSocket frame ordering makes this resize arrive after takeover. The
    // gateway remains authoritative and rejects it if takeover did not succeed.
    reportDesiredGeometry();
  }, [reportDesiredGeometry, taskId]);

  const handleControl = React.useCallback(
    (frame: ControlFrame) => {
      switch (frame.type) {
        case "terminal_attachment_state": {
          applyAuthoritativeGeometry({ cols: frame.cols, rows: frame.rows });
          if (frame.state === "attaching") {
            beginAttachmentReset();
          } else if (frame.state === "ready") {
            readyOrdinalRef.current = receivedOrdinalRef.current;
            maybeRevealRef.current();
          } else if (frame.state === "unavailable") {
            terminalRevealedRef.current = false;
            setTerminalVisible(false);
            setAttachmentReason(frame.reason);
            terminalAttachOutcomeRef.current = "unavailable";
            setConnectionState("unavailable");
          } else {
            terminalRevealedRef.current = false;
            setTerminalVisible(false);
            setAttachmentReason(frame.reason);
            const outcome = frame.reloadRequired ? "reload-required" : "error";
            terminalAttachOutcomeRef.current = outcome;
            setConnectionState(outcome);
          }
          break;
        }
        case "terminal_geometry":
          applyAuthoritativeGeometry({ cols: frame.cols, rows: frame.rows });
          break;
        case "lease_state": {
          if (frame.sessionId !== taskId) break;
          sessionIdRef.current = taskId;
          setSessionId(taskId);
          if (pendingTakeoverRef.current && frame.lease) {
            ownWriterIdRef.current = frame.lease.writerClientId;
            pendingTakeoverRef.current = false;
            ownsLeaseRef.current = true;
            reportDesiredGeometry();
          } else if (ownWriterIdRef.current) {
            ownsLeaseRef.current =
              frame.lease?.writerClientId === ownWriterIdRef.current;
          } else {
            ownsLeaseRef.current = false;
          }
          break;
        }
        case "permission_request":
        case "pause":
        case "resume":
          break;
        default:
          break;
      }
    },
    [
      applyAuthoritativeGeometry,
      beginAttachmentReset,
      reportDesiredGeometry,
      setConnectionState,
      taskId,
    ],
  );
  const handleControlRef = React.useRef(handleControl);
  handleControlRef.current = handleControl;

  React.useEffect(() => {
    clientIdRef.current = getClientId();
    const styles = getComputedStyle(document.documentElement);
    const background = resolveVar(styles, "--terminal-bg") || "#050505";
    const foreground = resolveVar(styles, "--terminal-fg") || "#e8e8e8";
    const muted = resolveVar(styles, "--terminal-muted") || "#8a8a8a";
    setTheme({
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: muted,
    });
    const mono = resolveVar(styles, "--font-mono");
    if (mono) setFontFamily(mono);
    setFontSize(window.matchMedia("(max-width: 820px)").matches ? 12 : 13);
  }, []);

  React.useEffect(() => {
    socketStartedRef.current = false;
    const socket = new TerminalSocket(taskId, {
      onRaw(bytes, seq) {
        const ordinal = receivedOrdinalRef.current + 1;
        receivedOrdinalRef.current = ordinal;
        pendingWritesRef.current.push({ bytes, seq, ordinal });
        scheduleFlushRef.current();
      },
      onControl(frame) {
        handleControlRef.current(frame);
      },
      onOpen() {
        socketOpenRef.current = true;
        attachmentEpochRef.current += 1;
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        pendingWritesRef.current = [];
        writeInFlightRef.current = false;
        resettingRef.current = false;
        receivedOrdinalRef.current = 0;
        flushedOrdinalRef.current = 0;
        readyOrdinalRef.current = null;
        terminalRevealedRef.current = false;
        pendingTakeoverRef.current = false;
        ownWriterIdRef.current = null;
        ownsLeaseRef.current = false;
        terminalAttachOutcomeRef.current = null;
        setTerminalVisible(false);
        setAttachmentReason(null);
        setConnectionState("attaching");
        const geometry =
          handleRef.current?.proposeFit() ?? desiredGeometryRef.current;
        desiredGeometryRef.current = geometry;
        socket.sendTerminalAttach(geometry.cols, geometry.rows);
        sessionIdRef.current = taskId;
        setSessionId(taskId);
      },
      onClose(_event, willReconnect) {
        socketOpenRef.current = false;
        terminalRevealedRef.current = false;
        ownsLeaseRef.current = false;
        pendingTakeoverRef.current = false;
        setTerminalVisible(false);
        setConnectionState(
          terminalAttachOutcomeRef.current ??
            (willReconnect ? "connecting" : "closed"),
        );
      },
      onError() {
        terminalRevealedRef.current = false;
        setTerminalVisible(false);
        setConnectionState("error");
      },
    });
    socketRef.current = socket;
    setConnectionState("connecting");

    startSocketRef.current = () => {
      if (socketStartedRef.current || socketRef.current !== socket) return;
      socketStartedRef.current = true;
      try {
        socket.connect();
      } catch {
        setConnectionState("error");
      }
    };
    if (handleRef.current) startSocketRef.current();

    return () => {
      startSocketRef.current = () => undefined;
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [setConnectionState, taskId]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (ownsLeaseRef.current && sessionIdRef.current) {
        socketRef.current?.sendHeartbeat(taskId, clientIdRef.current);
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [taskId]);

  React.useEffect(() => {
    const ensure = () => socketRef.current?.ensureConnected();
    const onVisible = () => {
      if (document.visibilityState === "visible") ensure();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", ensure);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", ensure);
    };
  }, []);

  const togglePause = React.useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    onPausedChangeRef.current?.(next);
    if (!next) scheduleFlushRef.current();
    return next;
  }, []);

  const copySession = React.useCallback(async () => {
    const serialized = handleRef.current?.serialize() ?? null;
    if (serialized === null) return false;
    try {
      await navigator.clipboard?.writeText(serialized);
      return Boolean(navigator.clipboard?.writeText);
    } catch {
      return false;
    }
  }, []);

  const fit = React.useCallback((): TerminalGeometry | null => {
    const geometry =
      handleRef.current?.proposeFit() ??
      handleRef.current?.geometry() ??
      desiredGeometryRef.current;
    desiredGeometryRef.current = geometry;
    reportDesiredGeometry();
    return geometry;
  }, [reportDesiredGeometry]);

  const serialize = React.useCallback(
    (): string | null => handleRef.current?.serialize() ?? null,
    [],
  );

  const activeBufferSnapshot = React.useCallback(
    (): string | null => handleRef.current?.activeBufferSnapshot() ?? null,
    [],
  );

  const geometry = React.useCallback(
    (): TerminalGeometry | null =>
      handleRef.current?.geometry() ?? authoritativeGeometryRef.current,
    [],
  );

  const toggleFullscreen = React.useCallback(() => {
    const element = shellRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) void document.exitFullscreen?.();
    else void element.requestFullscreen?.();
  }, []);

  React.useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const sendCommand = React.useCallback(() => {
    const value = input.trim();
    if (!value) return;
    claimWriter();
    socketRef.current?.sendKeystrokeBytes(taskId, terminalDataToBytes(value));
    window.setTimeout(
      () =>
        socketRef.current?.sendKeystrokeBytes(
          taskId,
          terminalDataToBytes("\r"),
        ),
      150,
    );
    setInput("");
  }, [claimWriter, input, taskId]);

  React.useEffect(() => {
    if (xtermReady) return;
    const timer = window.setTimeout(() => {
      if (!handleRef.current) {
        setXtermFailed(true);
        startSocketRef.current();
      }
    }, XTERM_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [xtermReady]);

  React.useImperativeHandle(
    ref,
    () => ({
      togglePause,
      copySession,
      fit,
      serialize,
      activeBufferSnapshot,
      geometry,
    }),
    [
      activeBufferSnapshot,
      copySession,
      fit,
      geometry,
      serialize,
      togglePause,
    ],
  );

  const commandDisabled = !sessionId || !socketOpenRef.current;
  const conn = CONNECTION_META[connection];

  return (
    <article
      ref={shellRef}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-terminal-bg text-terminal-fg shadow-terminal [&:fullscreen]:h-screen [&:fullscreen]:rounded-none"
    >
      <div className="flex min-h-[38px] flex-none items-center justify-between gap-3 border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate font-semibold text-terminal-fg">{headLabel}</span>
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
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-[15px]">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </summary>
            <div className="absolute right-0 top-[calc(100%+8px)] z-30 grid min-w-[148px] gap-0.5 rounded-lg bg-[#111] p-1 shadow-[0_0_0_1px_var(--terminal-line),0_14px_36px_rgba(0,0,0,0.4)]">
              <button
                type="button"
                data-copy-session
                onClick={(event) => {
                  void copySession();
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="min-h-[30px] rounded-md px-2.5 text-left text-terminal-fg hover:bg-white/10"
              >
                复制记录
              </button>
              <button
                type="button"
                data-terminal-pause
                onClick={(event) => {
                  togglePause();
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="min-h-[30px] rounded-md px-2.5 text-left text-terminal-fg hover:bg-white/10"
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
            className="grid size-7 place-items-center rounded-md text-terminal-muted hover:bg-white/10 hover:text-terminal-fg"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className="size-[14px]">
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

      <div className="relative min-h-0 flex-1 bg-[#050505] px-4 py-3.5">
        {theme ? (
          <Terminal
            theme={theme}
            fontSize={fontSize}
            lineHeight={1.45}
            fontFamily={fontFamily}
            scrollback={LIVE_TERMINAL_SCROLLBACK}
            controlledGrid
            className={`h-full transition-opacity ${terminalVisible ? "opacity-100" : "opacity-0"}`}
            onReady={(handle) => {
              handleRef.current = handle;
              desiredGeometryRef.current =
                handle.proposeFit() ?? handle.geometry() ?? DEFAULT_GEOMETRY;
              setXtermReady(true);
              setXtermFailed(false);
              startSocketRef.current();
              scheduleFlushRef.current();
            }}
            onFit={(geometry) => {
              desiredGeometryRef.current = geometry;
              reportDesiredGeometry();
            }}
            onData={(data) => {
              const responses = tokenizeTerminalResponseBurst(data);
              if (responses) {
                for (const response of responses) {
                  socketRef.current?.sendTerminalResponse(response);
                }
                return;
              }
              claimWriter();
              socketRef.current?.sendKeystrokeBytes(
                taskId,
                terminalDataToBytes(data),
              );
            }}
            onBinary={(data) => {
              claimWriter();
              socketRef.current?.sendKeystrokeBytes(
                taskId,
                terminalBinaryStringToBytes(data),
              );
            }}
          />
        ) : null}

        {!terminalVisible && !xtermFailed ? (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="terminal-attachment-status"
            className="absolute inset-0 z-10 grid place-items-center bg-[#050505] px-6 text-center font-mono text-xs text-terminal-muted"
          >
            <span>{attachmentStatusText(connection, attachmentReason)}</span>
          </div>
        ) : null}

        {xtermFailed ? (
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

      <div className="flex min-h-[30px] flex-none items-center justify-between gap-3 border-t border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-[11px] text-terminal-muted">
        <span className={`font-semibold ${phasePending ? "text-[#fbbf24]" : "text-terminal-fg"}`}>
          {phaseLabel}
        </span>
        <span className="truncate">{resourceLabel}</span>
      </div>
    </article>
  );
});
