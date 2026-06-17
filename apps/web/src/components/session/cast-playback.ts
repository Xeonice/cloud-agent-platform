/**
 * Pure asciicast playback helpers (session-terminal-replay, Track 4).
 *
 * Framework-free so the timing/seek logic unit-tests without a real canvas. The
 * React player ({@link SessionCastPlayer}) owns the xterm mount + the rAF clock;
 * these helpers decide WHAT to apply to the terminal for a given play head.
 *
 * Why timed playback at all: codex's TUI is a full-screen alternate-screen-buffer
 * app, so a continuous dump only shows the final (post-exit) frame. Replaying
 * events on the recorded clock is the only way to see the session evolve.
 */
import type { AsciicastEvent } from "@cap/contracts";

/** Sinks the player wires to the read-only xterm. */
export interface CastHandlers {
  /** Write decoded terminal output (an `o` event's data) to the terminal. */
  output: (data: string) => void;
  /** Resize the terminal (an `r` event). */
  resize: (cols: number, rows: number) => void;
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

/**
 * Apply one event to the handlers: `o` → output, `r` → resize (when parseable).
 * `i`/`m` events are not replayed into the visible画面.
 */
export function applyEvent(ev: AsciicastEvent, handlers: CastHandlers): void {
  const [, code, data] = ev;
  if (code === "o") {
    handlers.output(data);
  } else if (code === "r") {
    const geometry = parseResizeData(data);
    if (geometry) handlers.resize(geometry.cols, geometry.rows);
  }
}

/**
 * Apply every event whose `time` falls in the half-open window `(from, to]`, in
 * order. The player calls this each rAF tick with `from` = previous elapsed and
 * `to` = current elapsed, so each event fires exactly once as the head crosses
 * its timestamp. Returns the new event index (the next event past `to`).
 *
 * `startIndex` lets the caller resume scanning from the last index instead of
 * re-scanning from 0 every tick (O(events) total over a full playback).
 */
export function applyWindow(
  events: AsciicastEvent[],
  from: number,
  to: number,
  startIndex: number,
  handlers: CastHandlers,
): number {
  let i = Math.max(0, startIndex);
  for (; i < events.length; i++) {
    const ev = events[i];
    if (!ev) break;
    if (ev[0] <= from) continue; // already applied in an earlier window
    if (ev[0] > to) break; // not reached yet
    applyEvent(ev, handlers);
  }
  return i;
}

/**
 * Rebuild terminal state up to (and including) time `t`: apply every event with
 * `time <= t` in order. Returns the index of the NEXT event after `t` (the head
 * to resume from). Used for seek — the caller CLEARS the terminal first, since
 * the terminal is a state machine (esp. the alt-buffer) and intermediate frames
 * cannot be skipped.
 */
export function rebuildStateUpTo(
  events: AsciicastEvent[],
  t: number,
  handlers: CastHandlers,
): number {
  let i = 0;
  for (; i < events.length; i++) {
    const ev = events[i];
    if (!ev || ev[0] > t) break;
    applyEvent(ev, handlers);
  }
  return i;
}
