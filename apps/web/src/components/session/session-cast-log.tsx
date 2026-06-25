/**
 * `SessionCastLog` — the static 终端记录 view (static-terminal-log).
 *
 * Shows a finished task's `session.cast` as ONE static, scrollable terminal log —
 * NOT a timing player. It feeds the whole recording into a read-only xterm with
 * the alternate-screen switch suppressed (see {@link buildCastOps}/{@link stripAltScreen}),
 * so codex's full-screen TUI plays into the NORMAL buffer and xterm's own
 * scrollback reconstructs the entire session top-to-bottom. After the bulk write
 * the reader is parked at the start of the history.
 *
 * Flow control (fix-terminal-record-replay-flow-control): the cast is written in
 * bounded chunks paced by xterm's write-flush callback (a high/low watermark), so
 * xterm's 50MB write buffer is never overrun (no "write data discarded"). The view
 * shows a loading state until the WHOLE cast has been flushed, then reveals the
 * complete scrollable log — no "one screen now, fills in later" race.
 *
 * SSR-safe: the xterm mount, the theme resolve (getComputedStyle), and the cast
 * fetch all live in effects (client-only); nothing non-deterministic at render.
 */
import * as React from "react";
import type { ITheme } from "@xterm/xterm";
import { Terminal, type TerminalHandle } from "@cap/ui";
import {
  parseCast,
  type AsciicastEvent,
  type AsciicastHeader,
} from "@cap/contracts";
import { getSessionCast } from "@/lib/api/real";
import { buildCastOps } from "./cast-log";

type Status = "loading" | "empty" | "error" | "ready";

/** Generous scrollback so a long session's full history is retained, not truncated. */
const LOG_SCROLLBACK = 100_000;
const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Watermark thresholds (chars) for the replay backpressure — kept well under
 * xterm's hard 50MB write-buffer cap to leave headroom for its parse buffer. Pump
 * output while in-flight < HIGH; the flush callback resumes pumping below LOW.
 */
const WRITE_HIGH_WATERMARK = 2 * 1024 * 1024;
const WRITE_LOW_WATERMARK = 512 * 1024;

function resolveVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

export function SessionCastLog({
  taskId,
}: {
  taskId: string;
}): React.ReactElement {
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const eventsRef = React.useRef<AsciicastEvent[]>([]);
  const headerRef = React.useRef<AsciicastHeader | null>(null);
  const renderedRef = React.useRef(false); // guard: fill the log exactly once

  const [status, setStatus] = React.useState<Status>("loading");
  const [feedingDone, setFeedingDone] = React.useState(false);
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
    setFeedingDone(false);
    renderedRef.current = false;
    // Reset xtermReady too: on a same-route taskId change the old <Terminal>
    // unmounts (status→loading) and its handle is disposed. Without this reset
    // xtermReady stays true, so the fill effect would fire against the STALE
    // handle and latch renderedRef — leaving the new task's log blank. Clearing
    // it makes the fill effect wait for the fresh onReady (new handle).
    setXtermReady(false);
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
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // ── Fill the log once, with FLOW CONTROL, when parsed AND xterm has mounted ─
  React.useEffect(() => {
    if (status !== "ready" || !xtermReady || renderedRef.current) return;
    const handle = handleRef.current;
    const header = headerRef.current;
    if (!handle) return;
    renderedRef.current = true;
    let alive = true;

    handle.clear();
    if (header) handle.resize(header.width, header.height);

    // Build the bounded-chunk op list, then drive it with a high/low watermark:
    // never let xterm's write buffer approach its 50MB discard cap. The flush
    // callback decrements the in-flight count and resumes pumping below LOW; when
    // the op list is exhausted AND nothing is in flight, the replay is complete.
    const ops = buildCastOps(eventsRef.current);
    let i = 0;
    let inFlight = 0;
    let completed = false;

    const complete = (): void => {
      if (completed || !alive) return;
      completed = true;
      // The paced (watermark) fill leaves xterm's viewport scroll-area UNSYNCED:
      // the buffer holds scrollback but the viewport height is stuck at one screen,
      // so the log isn't scrollable (measured: baseY 199 yet vp.scrollHeight ==
      // clientHeight). scrollToTop()/refresh() do NOT sync it; syncViewport()
      // triggers xterm's resize path while keeping `cols` unchanged so there is
      // no wrap reflow (the cast's cursor-addressed redraws stay correct).
      handle.syncViewport();
      handle.scrollToTop();
      setFeedingDone(true);
    };

    const pump = (): void => {
      if (!alive) return;
      while (i < ops.length && inFlight < WRITE_HIGH_WATERMARK) {
        const op = ops[i++]!;
        if (op.type === "resize") {
          handle.resize(op.cols, op.rows);
          continue;
        }
        const bytes = op.data.length;
        inFlight += bytes;
        handle.write(op.data, () => {
          inFlight -= bytes;
          if (!alive) return;
          if (i < ops.length) {
            if (inFlight < WRITE_LOW_WATERMARK) pump();
          } else if (inFlight === 0) {
            complete();
          }
        });
      }
      // No output ops in flight (e.g. resize-only or empty op list): finish now.
      if (i >= ops.length && inFlight === 0) complete();
    };
    pump();

    return () => {
      alive = false;
    };
  }, [status, xtermReady]);

  if (status === "loading") {
    return <CenteredFace title="读取终端记录…" />;
  }
  if (status === "empty") {
    return (
      <CenteredFace
        icon="▮"
        title="无终端记录"
        detail="该任务没有产生可展示的终端记录（agent 未运行或未写出记录）。"
      />
    );
  }
  if (status === "error") {
    return (
      <CenteredFace
        icon="×"
        title="终端记录加载失败"
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
            scrollback={LOG_SCROLLBACK}
            className="h-full"
            onReady={(handle) => {
              handleRef.current = handle;
              setXtermReady(true);
            }}
          />
        ) : null}
        {/* Loading overlay while the cast is being paced into xterm. <Terminal>
            stays mounted UNDER it (so onReady fires and the watermark loop runs);
            the overlay drops only on the final flush, revealing the COMPLETE,
            scrolled-to-top log — never a partially-filled intermediate frame. */}
        {!feedingDone ? (
          <div className="absolute inset-0 z-10 bg-[#050505]">
            <CenteredFace title="读取终端记录…" />
          </div>
        ) : null}
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
