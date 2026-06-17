import { describe, it, expect, vi } from "vitest";
import type { AsciicastEvent } from "@cap/contracts";
import { stripAltScreen, parseResizeData, feedCastLog } from "./cast-log";

const ESC = "\x1b";

describe("stripAltScreen", () => {
  it("removes every alternate-screen switch variant", () => {
    for (const code of ["1049", "1047", "47"]) {
      for (const flag of ["h", "l"]) {
        const seq = `${ESC}[?${code}${flag}`;
        expect(stripAltScreen(`a${seq}b`)).toBe("ab");
      }
    }
  });

  it("removes multiple occurrences in one chunk", () => {
    const input = `${ESC}[?1049hX${ESC}[?1049lY`;
    expect(stripAltScreen(input)).toBe("XY");
  });

  it("leaves all other control sequences byte-intact", () => {
    // DECSTBM scroll region, cursor address, erase line, scroll-up, CR/LF, text.
    const keep =
      `${ESC}[1;18r` + // DECSTBM region (top-anchored — feeds scrollback)
      `${ESC}[12;3H` + // cursor address
      `${ESC}[K` + // erase to end of line
      `${ESC}[3S` + // scroll up 3
      `hello\r\n`;
    expect(stripAltScreen(keep)).toBe(keep);
  });

  it("removes only the switch from a realistic mixed chunk", () => {
    const input = `${ESC}[?1049h${ESC}[1;18r${ESC}[1;1Hcodex\r\n`;
    expect(stripAltScreen(input)).toBe(`${ESC}[1;18r${ESC}[1;1Hcodex\r\n`);
  });

  it("does not touch a DECSTBM region (it is not an alt-screen switch)", () => {
    // `[?47` only matters with a trailing h/l; a bare region must survive.
    expect(stripAltScreen(`${ESC}[1;47r`)).toBe(`${ESC}[1;47r`);
  });
});

describe("parseResizeData", () => {
  it("parses COLSxROWS", () => {
    expect(parseResizeData("115x18")).toEqual({ cols: 115, rows: 18 });
    expect(parseResizeData("  80x24  ")).toEqual({ cols: 80, rows: 24 });
  });
  it("rejects malformed", () => {
    expect(parseResizeData("bad")).toBeNull();
    expect(parseResizeData("80x")).toBeNull();
    expect(parseResizeData("")).toBeNull();
  });
});

describe("feedCastLog", () => {
  function sink() {
    return { output: vi.fn(), resize: vi.fn() };
  }

  it("writes output with the alt-screen switch stripped", () => {
    const s = sink();
    const events: AsciicastEvent[] = [[0, "o", `${ESC}[?1049hhello`]];
    feedCastLog(events, s);
    expect(s.output).toHaveBeenCalledTimes(1);
    expect(s.output).toHaveBeenCalledWith("hello");
  });

  it("rejoins a switch split across two output events before stripping", () => {
    const s = sink();
    const events: AsciicastEvent[] = [
      [0, "o", `${ESC}[?104`],
      [0.1, "o", `9hhello`],
    ];
    feedCastLog(events, s);
    // The two `o` runs concatenate to one chunk, so the split switch is removed.
    expect(s.output).toHaveBeenCalledTimes(1);
    expect(s.output).toHaveBeenCalledWith("hello");
  });

  it("flushes pending output before a resize, in order", () => {
    const s = sink();
    const calls: string[] = [];
    s.output.mockImplementation((d: string) => calls.push(`out:${d}`));
    s.resize.mockImplementation((c: number, r: number) =>
      calls.push(`resize:${c}x${r}`),
    );
    const events: AsciicastEvent[] = [
      [0, "o", "a"],
      [0.5, "r", "80x24"],
      [1, "o", "b"],
    ];
    feedCastLog(events, s);
    expect(calls).toEqual(["out:a", "resize:80x24", "out:b"]);
  });

  it("ignores input (`i`) and marker (`m`) events", () => {
    const s = sink();
    const events: AsciicastEvent[] = [
      [0, "i", "typed"],
      [0.1, "m", "marker"],
      [0.2, "o", "real"],
    ];
    feedCastLog(events, s);
    expect(s.output).toHaveBeenCalledTimes(1);
    expect(s.output).toHaveBeenCalledWith("real");
    expect(s.resize).not.toHaveBeenCalled();
  });
});
