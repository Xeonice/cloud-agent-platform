/**
 * Pure command-preview + guardrail-select logic (task-guardrail-controls 5.6).
 * Only the exported PURE helpers are exercised (no React render) so this runs in
 * the node-env vitest suite. Guards that idle/deadline are opt-in in the preview
 * (no line unless chosen) and the OFF sentinel round-trips to null.
 */
import { describe, it, expect } from "vitest";

import {
  buildCommandPreview,
  guardrailSelectValue,
  parseGuardrailSelectValue,
  GUARDRAIL_OFF,
  IDLE_TIMEOUT_OPTIONS,
  DEADLINE_OPTIONS,
} from "./new-task-dialog";

const base = {
  repoFullName: "owner/repo",
  branch: "main",
  strategy: null,
  prompt: "do the thing",
  stopOnWrite: false,
};

describe("buildCommandPreview guardrail lines", () => {
  it("omits idle/deadline lines when null or absent (opt-in)", () => {
    const lines = buildCommandPreview({ ...base, idleTimeoutMs: null, deadlineMs: null });
    expect(lines.some((l) => l.includes("--idle-timeout-ms"))).toBe(false);
    expect(lines.some((l) => l.includes("--deadline-ms"))).toBe(false);
    // Absent (undefined) behaves the same.
    const lines2 = buildCommandPreview(base);
    expect(lines2.some((l) => l.includes("--idle-timeout-ms"))).toBe(false);
    expect(lines2.some((l) => l.includes("--deadline-ms"))).toBe(false);
  });

  it("emits idle/deadline lines (with the chosen ms) when set", () => {
    const lines = buildCommandPreview({ ...base, idleTimeoutMs: 1_800_000, deadlineMs: 7_200_000 });
    expect(lines.some((l) => l.includes("--idle-timeout-ms 1800000"))).toBe(true);
    expect(lines.some((l) => l.includes("--deadline-ms 7200000"))).toBe(true);
  });
});

describe("guardrail select value round-trip", () => {
  it("OFF sentinel maps to/from null", () => {
    expect(guardrailSelectValue(null)).toBe(GUARDRAIL_OFF);
    expect(parseGuardrailSelectValue(GUARDRAIL_OFF)).toBe(null);
  });

  it("a ms value round-trips through the string Select value", () => {
    expect(guardrailSelectValue(1_800_000)).toBe("1800000");
    expect(parseGuardrailSelectValue("1800000")).toBe(1_800_000);
  });

  it("the default (first) option in each catalog is OFF/none (ms null)", () => {
    expect(IDLE_TIMEOUT_OPTIONS[0]?.ms).toBe(null);
    expect(DEADLINE_OPTIONS[0]?.ms).toBe(null);
  });
});
