/**
 * `SessionCastPlayer` — read-only asciicast timing player (session-terminal-replay,
 * Track 4). Replays a finished task's `session.cast` on the recorded clock into a
 * read-only xterm — NOT a continuous dump: codex is a full-screen alt-buffer TUI,
 * so only timed playback shows the session evolving. The timing/seek logic lives
 * in the pure {@link applyWindow}/{@link rebuildStateUpTo} helpers.
 *
 * SSR-safe: the xterm mount, the theme resolve (getComputedStyle), and the cast
 * fetch all live in effects (client-only); nothing non-deterministic at render.
 */
import * as React from "react";
import type { ITheme } from "@xterm/xterm";
import { Terminal, type TerminalHandle } from "@cap/ui";
import {
  parseCast,
  castDurationSeconds,
  type AsciicastEvent,
  type AsciicastHeader,
} from "@cap/contracts";
import { getSessionCast } from "@/lib/api/real";
import { applyWindow, rebuildStateUpTo, type CastHandlers } from "./cast-playback";

type Status = "loading" | "empty" | "error" | "ready";
const SPEEDS = [1, 2, 4] as const;
const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function resolveVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

/** `m:ss` for the progress readout. */
function fmtTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SessionCastPlayer({
  taskId,
}: {
  taskId: string;
}): React.ReactElement {
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const eventsRef = React.useRef<AsciicastEvent[]>([]);
  const headerRef = React.useRef<AsciicastHeader | null>(null);
  const idxRef = React.useRef(0); // index of the next event to apply
  const elapsedRef = React.useRef(0); // play head, seconds
  const lastTickRef = React.useRef<number | null>(null);
  const speedRef = React.useRef(1);
  const playingRef = React.useRef(false);

  const [status, setStatus] = React.useState<Status>("loading");
  const [duration, setDuration] = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState(1);
  const [theme, setTheme] = React.useState<ITheme | null>(null);
  const [fontFamily, setFontFamily] = React.useState(FONT_MONO);
  const [fontSize, setFontSize] = React.useState(13);
  const [xtermReady, setXtermReady] = React.useState(false);

  // ── Resolve the terminal theme from CSS vars (CLIENT-ONLY) ────────────────
  React.useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
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
    const mono = resolveVar(styles, "--font-mono");
    if (mono) setFontFamily(mono);
    const narrow =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px)").matches;
    setFontSize(narrow ? 12 : 13);
  }, []);

  // ── Fetch + parse the cast ────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getSessionCast(taskId)
      .then((text) => {
        if (cancelled) return;
        if (text.trim().length === 0) {
          setStatus("empty");
          return;
        }
        const { header, events } = parseCast(text);
        if (events.length === 0) {
          setStatus("empty");
          return;
        }
        eventsRef.current = events;
        headerRef.current = header;
        idxRef.current = 0;
        elapsedRef.current = 0;
        setDuration(castDurationSeconds(events));
        setElapsed(0);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const handlers = React.useMemo<CastHandlers>(
    () => ({
      output: (data) => handleRef.current?.write(data),
      resize: (cols, rows) => handleRef.current?.resize(cols, rows),
    }),
    [],
  );

  /** Reset the terminal to the recording's initial geometry, head at 0. */
  const resetToStart = React.useCallback(() => {
    handleRef.current?.clear();
    const header = headerRef.current;
    if (header) handleRef.current?.resize(header.width, header.height);
    idxRef.current = 0;
    elapsedRef.current = 0;
    setElapsed(0);
  }, []);

  // ── Auto-start once the cast is loaded AND xterm has mounted ───────────────
  React.useEffect(() => {
    if (status !== "ready" || !xtermReady) return;
    resetToStart();
    lastTickRef.current = null;
    playingRef.current = true;
    setPlaying(true);
  }, [status, xtermReady, resetToStart]);

  // ── rAF playback loop ─────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      const last = lastTickRef.current ?? now;
      lastTickRef.current = now;
      const dt = ((now - last) / 1000) * speedRef.current;
      const prev = elapsedRef.current;
      const next = Math.min(prev + dt, duration);
      idxRef.current = applyWindow(
        eventsRef.current,
        prev,
        next,
        idxRef.current,
        handlers,
      );
      elapsedRef.current = next;
      setElapsed(next);
      if (next >= duration) {
        playingRef.current = false;
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, handlers]);

  const togglePlay = React.useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    if (elapsedRef.current >= duration) resetToStart(); // replay from the start
    lastTickRef.current = null;
    playingRef.current = true;
    setPlaying(true);
  }, [duration, resetToStart]);

  const seek = React.useCallback(
    (t: number) => {
      playingRef.current = false;
      setPlaying(false);
      handleRef.current?.clear();
      const header = headerRef.current;
      if (header) handleRef.current?.resize(header.width, header.height);
      idxRef.current = rebuildStateUpTo(eventsRef.current, t, handlers);
      elapsedRef.current = t;
      setElapsed(t);
    },
    [handlers],
  );

  const changeSpeed = React.useCallback((s: number) => {
    speedRef.current = s;
    setSpeed(s);
  }, []);

  if (status === "loading") {
    return <CenteredFace title="读取终端回放…" />;
  }
  if (status === "empty") {
    return (
      <CenteredFace
        icon="▮"
        title="无终端回放"
        detail="该任务没有产生可回放的终端记录（agent 未运行或未写出记录）。"
      />
    );
  }
  if (status === "error") {
    return (
      <CenteredFace
        icon="×"
        title="终端回放加载失败"
        detail="无法读取该任务的终端记录，请稍后重试。"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            }}
          />
        ) : null}
      </div>
      {/* Player controls — play/pause · seekable progress · speed. */}
      <div className="flex flex-none items-center gap-3 border-t border-terminal-line bg-[#0d0d0d] px-3.5 py-2 font-mono text-[11px] text-terminal-muted">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "暂停" : "播放"}
          className="grid size-6 flex-none place-items-center rounded text-terminal-fg transition-colors hover:bg-white/10"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="flex-none tabular-nums">{fmtTime(elapsed)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(elapsed, duration)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="回放进度"
          className="h-1 flex-1 cursor-pointer accent-[#34d399]"
        />
        <span className="flex-none tabular-nums">{fmtTime(duration)}</span>
        <div className="flex flex-none items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeSpeed(s)}
              className={
                "rounded px-1.5 py-0.5 transition-colors " +
                (speed === s
                  ? "bg-white/15 text-terminal-fg"
                  : "text-terminal-muted hover:bg-white/10")
              }
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The honest centered face for loading / empty / error states. */
function CenteredFace({
  icon,
  title,
  detail,
}: {
  icon?: string;
  title: string;
  detail?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-12 py-12 text-center text-muted-foreground">
      {icon ? (
        <div className="grid h-11 w-11 place-items-center rounded-[11px] bg-secondary text-[22px] text-muted-2">
          {icon}
        </div>
      ) : null}
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {detail ? (
        <div className="max-w-[380px] text-[12.5px] leading-[1.5]">{detail}</div>
      ) : null}
    </div>
  );
}
