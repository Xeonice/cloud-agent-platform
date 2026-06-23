/**
 * Regression guard for the load-bearing premise of static-terminal-log: feeding
 * an alternate-screen-buffer recording into xterm's NORMAL buffer (alt-screen
 * switch stripped) makes the scrolled-off content accumulate in scrollback, so
 * the reconstructed log holds materially MORE than the final frame — whereas
 * keeping the alt-screen switch leaves only the last screenful.
 *
 * Runs against the real `@xterm/headless` emulator (the same family as the
 * shipped `@xterm/xterm`) so a future xterm upgrade that broke normal-buffer
 * scrollback would fail here, not silently in production.
 */
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { parseCast, type AsciicastEvent } from "@cap/contracts";
import { buildCastOps } from "./cast-log";

const ESC = "\x1b";
const ROWS = 5;
const TOTAL_LINES = 14;

/** A tiny synthetic asciicast: enter alt-buffer, top-anchored scroll region,
 *  then write more lines than fit so the screen scrolls. */
function buildFixtureCast(): string {
  const head = `{"version":2,"width":40,"height":${ROWS}}`;
  const lines: string[] = [
    `[0,"o",${JSON.stringify(`${ESC}[?1049h`)}]`, // enter alternate screen
    `[0.01,"o",${JSON.stringify(`${ESC}[1;${ROWS}r`)}]`, // top-anchored region
  ];
  for (let i = 1; i <= TOTAL_LINES; i++) {
    const t = (0.01 + i * 0.01).toFixed(2);
    lines.push(`[${t},"o",${JSON.stringify(`line-${i}\r\n`)}]`);
  }
  return [head, ...lines].join("\n");
}

function makeTerm(): Terminal {
  return new Terminal({ cols: 40, rows: ROWS, scrollback: 1000, allowProposedApi: true });
}

function drain(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write("", () => resolve()));
}

function countNonEmpty(term: Terminal): number {
  const buf = term.buffer.active;
  let n = 0;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line && line.translateToString(true).trim().length > 0) n += 1;
  }
  return n;
}

describe("cast-log flatten (headless xterm)", () => {
  it("alt stripped recovers far more lines than alt kept", async () => {
    const { events } = parseCast(buildFixtureCast());

    // OUR path: buildCastOps strips the alt-screen switch → normal buffer, as a
    // bounded-chunk op list the consumer paces into xterm.
    const stripped = makeTerm();
    for (const op of buildCastOps(events)) {
      if (op.type === "output") stripped.write(op.data);
      else stripped.resize(op.cols, op.rows);
    }
    await drain(stripped);

    // Control: feed the raw output unchanged → stays in the alt buffer.
    const kept = makeTerm();
    for (const ev of events as AsciicastEvent[]) {
      if (ev[1] === "o") kept.write(ev[2]);
    }
    await drain(kept);

    const strippedLines = countNonEmpty(stripped);
    const keptLines = countNonEmpty(kept);

    // Alt kept: capped at the screenful (no scrollback in the alt buffer).
    expect(keptLines).toBeLessThanOrEqual(ROWS);
    // Alt stripped: the scrolled-off lines survive in scrollback.
    expect(strippedLines).toBeGreaterThan(keptLines);
    expect(strippedLines).toBeGreaterThanOrEqual(TOTAL_LINES - 1);
  });
});
