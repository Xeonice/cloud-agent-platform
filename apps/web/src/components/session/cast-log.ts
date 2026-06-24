/**
 * Pure asciicast → static-log helpers (static-terminal-log + flow-control fix).
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
 * Flow control (fix-terminal-record-replay-flow-control): casts can be HUGE
 * (measured 137MB for an alt-screen codex run). xterm's `write` is non-blocking,
 * buffers, and DISCARDS past a hard 50MB cap ("write data discarded, use flow
 * control"). So this module no longer concatenates one giant string for a single
 * write — it produces an ORDERED, BOUNDED-CHUNK op list ({@link buildCastOps}),
 * and the React component ({@link SessionCastLog}) paces the writes with the
 * xterm write-flush callback (a high/low watermark). This file decides WHAT bytes
 * (pure, framework-free, unit-testable); the component decides the PACING.
 */
import type { AsciicastEvent } from "@cap/contracts";

/** Matches the alternate-screen switch: `ESC [ ? (1049|1047|47) (h|l)`. */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;

/** Max chars per output chunk — bounds each `handle.write` so the watermark can pace. */
export const DEFAULT_CAST_CHUNK_SIZE = 64 * 1024;

/**
 * Cap total replayed output (chars). Above this, only the most-recent slice is
 * kept (with a truncation notice) — a guard against pathologically large legacy
 * alt-screen casts (137MB) that are slow/memory-heavy through ANY VT even with
 * backpressure. Comfortably above a long inline task; far below a 137MB dump.
 * `0` disables the cap.
 */
export const DEFAULT_CAST_MAX_OUTPUT = 24 * 1024 * 1024;

/** Prepended (as an output op) when {@link buildCastOps} caps an oversized cast. */
export const CAST_TRUNCATION_NOTICE = "⋯ 较早的输出已省略（记录过大）\r\n";

/**
 * Remove ONLY the alternate-screen switch (`CSI ? (1049|1047|47) (h|l)`) so the
 * cast renders into xterm's normal buffer. Every other control sequence — scroll
 * regions (DECSTBM), cursor addressing, line/screen clears, scroll-up — is left
 * byte-intact, because those are exactly what drive the scrollback fill.
 */
export function stripAltScreen(data: string): string {
  return data.replace(ALT_SCREEN_RE, "");
}

/**
 * Strip the alternate-screen switch from a RAW byte chunk — the LIVE terminal's
 * `onRaw` bytes are `Uint8Array` (unlike the cast's string), and the alt-screen
 * there is the tmux ATTACH CLIENT's own (tmux options can't suppress it), so the
 * front-end strips it before writing to xterm (fix-live-terminal-scrollback-strip).
 *
 * UTF-8-SAFE: maps each byte 1:1 to a char (0–255) via `String.fromCharCode` —
 * deliberately NOT `TextDecoder("latin1")`, whose WHATWG label is windows-1252 and
 * would remap 0x80–0x9F and corrupt the round-trip. A multi-byte UTF-8 codepoint
 * (e.g. Chinese) split across chunks is preserved (its bytes survive as chars and
 * re-encode unchanged); the ASCII switch is matched by {@link stripAltScreen} and
 * removed. xterm does its own stateful UTF-8 decode on the result. Returns the
 * original array unchanged when no switch is present (the common case).
 */
export function stripAltScreenBytes(bytes: Uint8Array): Uint8Array {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  const stripped = stripAltScreen(s);
  if (stripped.length === s.length) return bytes;
  const out = new Uint8Array(stripped.length);
  for (let i = 0; i < stripped.length; i++) out[i] = stripped.charCodeAt(i);
  return out;
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

/** A bounded write of decoded terminal output (alt-screen already stripped). */
export interface CastOutputOp {
  readonly type: "output";
  readonly data: string;
}
/** A terminal resize (an `r` event), so cursor-addressed redraws land right. */
export interface CastResizeOp {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}
export type CastOp = CastOutputOp | CastResizeOp;

export interface BuildCastOpsOptions {
  /** Max chars per output chunk (default {@link DEFAULT_CAST_CHUNK_SIZE}). */
  chunkSize?: number;
  /** Cap total output chars (default {@link DEFAULT_CAST_MAX_OUTPUT}); `0` = uncapped. */
  maxOutputBytes?: number;
}

/**
 * Build the whole recording into an ORDERED op list, ONE-SHOT (no timing). Runs of
 * `o` output between `r` resizes are concatenated, then stripped of the alt-screen
 * switch (so a switch split across two output events is rejoined before stripping),
 * then SPLIT into bounded `output` chunks. `r` events become `resize` ops at their
 * position. `i` (input) and `m` (marker) events are not part of the visible 画面.
 *
 * The bounded chunks let the consumer pace writes with xterm's flush callback so
 * the 50MB write buffer is never overrun (no discarded data). xterm's parser is
 * stateful ACROSS `write` calls, so a control sequence split at a chunk boundary
 * resumes correctly on the next chunk — naive char-splitting is safe.
 *
 * If `maxOutputBytes > 0` and total output exceeds it, only the most-recent slice
 * within the cap is kept (resize ops preserved), with {@link CAST_TRUNCATION_NOTICE}
 * prepended.
 */
export function buildCastOps(
  events: AsciicastEvent[],
  opts: BuildCastOpsOptions = {},
): CastOp[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CAST_CHUNK_SIZE;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_CAST_MAX_OUTPUT;
  const ops: CastOp[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) return;
    const stripped = stripAltScreen(pending);
    pending = "";
    for (let i = 0; i < stripped.length; i += chunkSize) {
      ops.push({ type: "output", data: stripped.slice(i, i + chunkSize) });
    }
  };
  for (const ev of events) {
    const [, code, data] = ev;
    if (code === "o") {
      pending += data;
    } else if (code === "r") {
      flush();
      const geometry = parseResizeData(data);
      if (geometry) {
        ops.push({ type: "resize", cols: geometry.cols, rows: geometry.rows });
      }
    }
  }
  flush();
  return maxOutputBytes > 0 ? capCastOps(ops, maxOutputBytes) : ops;
}

/**
 * Cap total output to the most-recent `maxOutputBytes` chars: drop the EARLIEST
 * output chunks beyond the budget (keeping all resize ops and the tail), and
 * prepend a truncation notice. Returns the ops unchanged when already within cap.
 */
function capCastOps(ops: CastOp[], maxOutputBytes: number): CastOp[] {
  let total = 0;
  for (const op of ops) if (op.type === "output") total += op.data.length;
  if (total <= maxOutputBytes) return ops;
  const keptReversed: CastOp[] = [];
  let acc = 0;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.type === "output") {
      if (acc >= maxOutputBytes) continue; // drop earliest output beyond the cap
      acc += op.data.length;
    }
    keptReversed.push(op);
  }
  keptReversed.reverse();
  return [{ type: "output", data: CAST_TRUNCATION_NOTICE }, ...keptReversed];
}
