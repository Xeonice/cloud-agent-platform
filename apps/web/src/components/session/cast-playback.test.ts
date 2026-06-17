import { describe, it, expect, vi } from "vitest";
import type { AsciicastEvent } from "@cap/contracts";
import {
  parseResizeData,
  applyEvent,
  applyWindow,
  rebuildStateUpTo,
} from "./cast-playback";

function spyHandlers() {
  return { output: vi.fn(), resize: vi.fn() };
}

describe("parseResizeData", () => {
  it("parses COLSxROWS", () => {
    expect(parseResizeData("120x40")).toEqual({ cols: 120, rows: 40 });
    expect(parseResizeData("  80x24  ")).toEqual({ cols: 80, rows: 24 });
  });
  it("rejects malformed", () => {
    expect(parseResizeData("bad")).toBeNull();
    expect(parseResizeData("80x")).toBeNull();
    expect(parseResizeData("")).toBeNull();
  });
});

describe("applyEvent", () => {
  it("o → output", () => {
    const h = spyHandlers();
    applyEvent([0.5, "o", "hi"], h);
    expect(h.output).toHaveBeenCalledWith("hi");
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("r → resize when parseable", () => {
    const h = spyHandlers();
    applyEvent([1, "r", "100x30"], h);
    expect(h.resize).toHaveBeenCalledWith(100, 30);
  });
  it("r with bad data → no-op", () => {
    const h = spyHandlers();
    applyEvent([1, "r", "garbage"], h);
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("i/m → not replayed", () => {
    const h = spyHandlers();
    applyEvent([1, "i", "x"], h);
    applyEvent([1, "m", "marker"], h);
    expect(h.output).not.toHaveBeenCalled();
    expect(h.resize).not.toHaveBeenCalled();
  });
});

const EVENTS: AsciicastEvent[] = [
  [0.0, "o", "a"],
  [0.5, "r", "100x30"],
  [1.0, "o", "b"],
  [2.0, "o", "c"],
];

describe("applyWindow", () => {
  it("fires only events in (from, to], advancing the index", () => {
    const h = spyHandlers();
    // window (−1, 0.7] → a (0.0) + resize (0.5)
    const i1 = applyWindow(EVENTS, -1, 0.7, 0, h);
    expect(h.output.mock.calls.map((c) => c[0])).toEqual(["a"]);
    expect(h.resize).toHaveBeenCalledWith(100, 30);
    expect(i1).toBe(2);
    // window (0.7, 2.0] → b (1.0) + c (2.0)
    const i2 = applyWindow(EVENTS, 0.7, 2.0, i1, h);
    expect(h.output.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(i2).toBe(4);
  });
  it("each event fires exactly once across consecutive windows", () => {
    const h = spyHandlers();
    let idx = applyWindow(EVENTS, -1, 0.0, 0, h); // a
    idx = applyWindow(EVENTS, 0.0, 1.0, idx, h); // resize + b
    applyWindow(EVENTS, 1.0, 3.0, idx, h); // c (final window; index no longer needed)
    expect(h.output).toHaveBeenCalledTimes(3);
    expect(h.resize).toHaveBeenCalledTimes(1);
  });
});

describe("rebuildStateUpTo (seek)", () => {
  it("applies all events with time <= T in order, returns next index", () => {
    const h = spyHandlers();
    const next = rebuildStateUpTo(EVENTS, 1.0, h);
    expect(h.output.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(h.resize).toHaveBeenCalledTimes(1);
    expect(next).toBe(3); // c (2.0) is the next event
  });
  it("T before first event applies nothing", () => {
    const h = spyHandlers();
    const next = rebuildStateUpTo(EVENTS, -1, h);
    expect(h.output).not.toHaveBeenCalled();
    expect(next).toBe(0);
  });
});
