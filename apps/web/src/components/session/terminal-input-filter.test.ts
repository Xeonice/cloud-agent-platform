import { describe, expect, it } from "vitest";
import {
  terminalBinaryStringToBytes,
  terminalDataToBytes,
  tokenizeTerminalResponseBurst,
} from "./terminal-input-filter";

const ESC = "\x1b";
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("tokenizeTerminalResponseBurst", () => {
  it("recognizes every enabled response family from the active profile", () => {
    const responses = [
      `${ESC}[?1;2c`,
      `${ESC}[>0;276;0c`,
      `${ESC}[0n`,
      `${ESC}[1;1R`,
      `${ESC}[?24;80R`,
      `${ESC}[4;2$y`,
      `${ESC}[?2026;0$y`,
      `${ESC}P1$r0m${ESC}\\`,
      `${ESC}P1$r1;24r${ESC}\\`,
      `${ESC}P1$r2 q${ESC}\\`,
      `${ESC}P1$r0"q${ESC}\\`,
      `${ESC}P1$r61;1"p${ESC}\\`,
      `${ESC}P0$r${ESC}\\`,
      `${ESC}]4;0;rgb:0000/0000/0000${ESC}\\`,
      `${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\`,
      `${ESC}]11;rgb:0000/0000/0000${ESC}\\`,
      `${ESC}]12;rgb:ffff/ffff/ffff${ESC}\\`,
    ];

    for (const response of responses) {
      expect(tokenizeTerminalResponseBurst(response)?.map(decode)).toEqual([
        response,
      ]);
    }
  });

  it("splits a response-only multi-token burst in exact order", () => {
    const first = `${ESC}[>0;276;0c`;
    const second = `${ESC}[?7;9R`;
    const third = `${ESC}P0$r${ESC}\\`;
    expect(
      tokenizeTerminalResponseBurst(`${first}${second}${third}`)?.map(decode),
    ).toEqual([first, second, third]);
  });

  it("rejects the entire burst for human, mixed, incomplete, or interstitial data", () => {
    const response = `${ESC}[>0;276;0c`;
    for (const value of [
      "hello",
      `${ESC}[A`,
      `${ESC}[200~pasted${ESC}[201~`,
      `${response}x`,
      `x${response}`,
      `${response}x${response}`,
      `${response}${ESC}[?`,
      `${ESC}]10;rgb:ffff/ffff/ffff`,
    ]) {
      expect(tokenizeTerminalResponseBurst(value)).toBeNull();
    }
  });

  it("rejects response classes disabled by the production window options", () => {
    expect(tokenizeTerminalResponseBurst(`${ESC}[4;600;800t`)).toBeNull();
    expect(tokenizeTerminalResponseBurst(`${ESC}[6;16;8t`)).toBeNull();
    expect(tokenizeTerminalResponseBurst(`${ESC}[8;24;80t`)).toBeNull();
  });
});

describe("terminal input byte conversion", () => {
  it("UTF-8 encodes onData text", () => {
    expect([...terminalDataToBytes("A中")]).toEqual([0x41, 0xe4, 0xb8, 0xad]);
  });

  it("maps onBinary code units to low 8-bit bytes without UTF-8 expansion", () => {
    expect([...terminalBinaryStringToBytes("\x00\x80\xff\u1234")]).toEqual([
      0x00, 0x80, 0xff, 0x34,
    ]);
  });
});
