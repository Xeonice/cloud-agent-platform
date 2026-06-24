import { describe, it, expect } from "vitest";
import type { AsciicastEvent } from "@cap/contracts";
import {
  stripAltScreen,
  stripAltScreenBytes,
  parseResizeData,
  buildCastOps,
  CAST_TRUNCATION_NOTICE,
} from "./cast-log";

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

describe("buildCastOps", () => {
  it("emits output with the alt-screen switch stripped", () => {
    const events: AsciicastEvent[] = [[0, "o", `${ESC}[?1049hhello`]];
    expect(buildCastOps(events)).toEqual([{ type: "output", data: "hello" }]);
  });

  it("rejoins a switch split across two output events before stripping", () => {
    const events: AsciicastEvent[] = [
      [0, "o", `${ESC}[?104`],
      [0.1, "o", `9hhello`],
    ];
    // The two `o` runs concatenate before stripping, so the split switch is removed.
    expect(buildCastOps(events)).toEqual([{ type: "output", data: "hello" }]);
  });

  it("flushes pending output before a resize, in order", () => {
    const events: AsciicastEvent[] = [
      [0, "o", "a"],
      [0.5, "r", "80x24"],
      [1, "o", "b"],
    ];
    expect(buildCastOps(events)).toEqual([
      { type: "output", data: "a" },
      { type: "resize", cols: 80, rows: 24 },
      { type: "output", data: "b" },
    ]);
  });

  it("ignores input (`i`) and marker (`m`) events", () => {
    const events: AsciicastEvent[] = [
      [0, "i", "typed"],
      [0.1, "m", "marker"],
      [0.2, "o", "real"],
    ];
    expect(buildCastOps(events)).toEqual([{ type: "output", data: "real" }]);
  });

  it("splits a long output run into bounded chunks (flow control)", () => {
    const events: AsciicastEvent[] = [[0, "o", "abcdef"]];
    expect(buildCastOps(events, { chunkSize: 4, maxOutputBytes: 0 })).toEqual([
      { type: "output", data: "abcd" },
      { type: "output", data: "ef" },
    ]);
  });

  it("does not split when under the chunk size", () => {
    const events: AsciicastEvent[] = [[0, "o", "abc"]];
    expect(buildCastOps(events, { chunkSize: 64, maxOutputBytes: 0 })).toEqual([
      { type: "output", data: "abc" },
    ]);
  });

  it("caps oversized output to the most-recent slice with a notice", () => {
    // "OLD"+"NEW" concat → "OLDNEW", chunked by 3 → ["OLD","NEW"]; cap 3 keeps
    // only the tail chunk plus a truncation notice.
    const events: AsciicastEvent[] = [
      [0, "o", "OLD"],
      [0.1, "o", "NEW"],
    ];
    const ops = buildCastOps(events, { chunkSize: 3, maxOutputBytes: 3 });
    expect(ops[0]).toEqual({ type: "output", data: CAST_TRUNCATION_NOTICE });
    expect(ops).toContainEqual({ type: "output", data: "NEW" });
    expect(ops).not.toContainEqual({ type: "output", data: "OLD" });
  });

  it("does not cap when total output is within the budget", () => {
    const events: AsciicastEvent[] = [[0, "o", "small"]];
    const ops = buildCastOps(events, { maxOutputBytes: 1024 });
    expect(ops).toEqual([{ type: "output", data: "small" }]);
    expect(ops[0]).not.toEqual({ type: "output", data: CAST_TRUNCATION_NOTICE });
  });
});

describe("stripAltScreenBytes", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);

  it("strips the alt-screen switch from a byte chunk", () => {
    expect(dec(stripAltScreenBytes(enc(`${ESC}[?1049hhello`)))).toBe("hello");
  });

  it("returns the SAME array (no copy) when no switch is present", () => {
    const bytes = enc("plain output");
    expect(stripAltScreenBytes(bytes)).toBe(bytes);
  });

  it("does not corrupt multi-byte UTF-8 alongside the switch", () => {
    expect(dec(stripAltScreenBytes(enc(`${ESC}[?1049h你好世界`)))).toBe("你好世界");
  });

  it("preserves raw multi-byte codepoint bytes (no decode split)", () => {
    // 你 = E4 BD A0; switch then the raw UTF-8 bytes — byte-level strip must keep them intact
    const bytes = new Uint8Array([
      0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68, // ESC[?1049h
      0xe4, 0xbd, 0xa0, // 你
    ]);
    expect([...stripAltScreenBytes(bytes)]).toEqual([0xe4, 0xbd, 0xa0]);
  });
});
