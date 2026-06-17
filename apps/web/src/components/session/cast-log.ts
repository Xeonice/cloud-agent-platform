/**
 * Pure asciicast → static-log helpers (static-terminal-log).
 *
 * The 终端记录 tab shows a finished task's terminal as ONE static, scrollable log
 * (no timing player). The trick (proven on real production casts): codex's stream
 * is a full-screen ALTERNATE-screen-buffer TUI, and the alt-buffer has no
 * scrollback — so a continuous dump lands only on the final frame. But if we
 * SUPPRESS the alternate-screen switch and let the same stream play into xterm's
 * NORMAL buffer, every top-anchored scroll (the `1;N` scroll-region + scroll-up
 * that codex/tmux use) pushes the displaced lines into xterm's own scrollback —
 * reconstructing the full linear history for free, no VT simulation.
 *
 * Framework-free so the transform unit-tests without a real canvas. The React
 * component ({@link SessionCastLog}) owns the xterm mount; {@link feedCastLog}
 * decides WHAT bytes to write.
 */
import type { AsciicastEvent } from "@cap/contracts";

/** Matches the alternate-screen switch: `ESC [ ? (1049|1047|47) (h|l)`. */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;

/**
 * Remove ONLY the alternate-screen switch (`CSI ? (1049|1047|47) (h|l)`) so the
 * cast renders into xterm's normal buffer. Every other control sequence — scroll
 * regions (DECSTBM), cursor addressing, line/screen clears, scroll-up — is left
 * byte-intact, because those are exactly what drive the scrollback fill.
 */
export function stripAltScreen(data: string): string {
  return data.replace(ALT_SCREEN_RE, "");
}

/** Parse an asciicast `r` event's data (`"COLSxROWS"`) → geometry, or null. */
export function parseResizeData(
  data: string,
): { cols: number; rows: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(data.trim());
  if (!m) return null;
  const cols = m[1];
  const rows = m[2];
  if (cols === undefined || rows === undefined) return null;
  return { cols: Number(cols), rows: Number(rows) };
}

/** Sinks the static-log component wires to its read-only xterm. */
export interface CastLogSink {
  /** Write decoded terminal output (alt-screen already stripped) to the terminal. */
  output: (data: string) => void;
  /** Resize the terminal (an `r` event), so cursor-addressed redraws land right. */
  resize: (cols: number, rows: number) => void;
}

/**
 * Feed the whole recording into the sink, ONE-SHOT (no timing). Runs of `o`
 * output between `r` resizes are concatenated, then stripped of the alt-screen
 * switch and written as one chunk — so a switch sequence split across two output
 * events is rejoined before stripping. `r` events are applied at their position.
 *
 * Limitation (benign): a switch sequence split EXACTLY across an `o`/`r`/`o`
 * boundary is not rejoined (the `r` flushes the pending run first). Our recorder
 * never produces this — it emits a resize as its own event between COMPLETE
 * output chunks, never mid-escape-sequence — and the worst case would be one
 * un-stripped alt-switch (that segment stays in the alt buffer), not corruption.
 */
export function feedCastLog(events: AsciicastEvent[], sink: CastLogSink): void {
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) return;
    sink.output(stripAltScreen(pending));
    pending = "";
  };
  for (const ev of events) {
    const [, code, data] = ev;
    if (code === "o") {
      pending += data;
    } else if (code === "r") {
      flush();
      const geometry = parseResizeData(data);
      if (geometry) sink.resize(geometry.cols, geometry.rows);
    }
    // `i` (input) and `m` (marker) events are not part of the visible画面.
  }
  flush();
}
