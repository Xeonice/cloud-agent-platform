import { describe, expect, it } from "vitest";
import { isTerminalGeneratedResponse } from "./terminal-input-filter";

const ESC = "\x1b";

describe("isTerminalGeneratedResponse", () => {
  it("recognizes xterm device-attribute and cursor-position replies", () => {
    expect(isTerminalGeneratedResponse(`${ESC}[>0;276;0c`)).toBe(true);
    expect(isTerminalGeneratedResponse(`${ESC}[?1;2c`)).toBe(true);
    expect(isTerminalGeneratedResponse(`${ESC}[1;1R`)).toBe(true);
    expect(isTerminalGeneratedResponse(`${ESC}[0n`)).toBe(true);
  });

  it("recognizes consecutive generated replies in one data event", () => {
    expect(
      isTerminalGeneratedResponse(`${ESC}[>0;276;0c${ESC}[>0;276;0c`),
    ).toBe(true);
  });

  it("does not treat operator input as generated terminal replies", () => {
    expect(isTerminalGeneratedResponse("hello")).toBe(false);
    expect(isTerminalGeneratedResponse(`${ESC}[A`)).toBe(false);
    expect(isTerminalGeneratedResponse(`${ESC}[200~pasted${ESC}[201~`)).toBe(
      false,
    );
  });
});
