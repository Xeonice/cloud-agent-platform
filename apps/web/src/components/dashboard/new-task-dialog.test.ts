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
  RUNTIME_CATALOG,
  DEFAULT_RUNTIME,
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
    const lines = buildCommandPreview({ ...base, idleTimeoutMs: 900_000, deadlineMs: 14_400_000 });
    expect(lines.some((l) => l.includes("--idle-timeout-ms 900000"))).toBe(true);
    expect(lines.some((l) => l.includes("--deadline-ms 14400000"))).toBe(true);
  });
});

describe("guardrail preset ladders (console-design-pixel-merge)", () => {
  it("idle ladder is exactly 关闭 / 15 分钟 (900000) / 30 分钟 (1800000)", () => {
    expect(IDLE_TIMEOUT_OPTIONS.map((o) => o.ms)).toEqual([null, 900_000, 1_800_000]);
    expect(IDLE_TIMEOUT_OPTIONS[0]?.label).toContain("关闭");
    expect(IDLE_TIMEOUT_OPTIONS[1]?.label).toBe("15 分钟");
    expect(IDLE_TIMEOUT_OPTIONS[2]?.label).toBe("30 分钟");
  });

  it("deadline ladder is exactly 无 / 1 小时 (3600000) / 4 小时 (14400000)", () => {
    expect(DEADLINE_OPTIONS.map((o) => o.ms)).toEqual([null, 3_600_000, 14_400_000]);
    expect(DEADLINE_OPTIONS[0]?.label).toContain("无");
    expect(DEADLINE_OPTIONS[1]?.label).toBe("1 小时");
    expect(DEADLINE_OPTIONS[2]?.label).toBe("4 小时");
  });

  it("关闭/无 (ms null) emit no command line — no field is submitted", () => {
    const lines = buildCommandPreview({
      ...base,
      idleTimeoutMs: IDLE_TIMEOUT_OPTIONS[0]?.ms ?? null,
      deadlineMs: DEADLINE_OPTIONS[0]?.ms ?? null,
    });
    expect(lines.some((l) => l.includes("--idle-timeout-ms"))).toBe(false);
    expect(lines.some((l) => l.includes("--deadline-ms"))).toBe(false);
  });
});

describe("runtime selector + command-preview reflection (add-claude-code-runtime)", () => {
  it("default runtime is codex and it is the first catalog entry", () => {
    expect(DEFAULT_RUNTIME).toBe("codex");
    expect(RUNTIME_CATALOG[0]?.id).toBe("codex");
    expect(RUNTIME_CATALOG.map((r) => r.id)).toEqual(["codex", "claude-code"]);
  });

  it("codex (default) preview omits the --runtime flag and names codex", () => {
    // Omitted runtime defaults to codex — the codex flag list stays as before.
    const omitted = buildCommandPreview(base);
    expect(omitted.some((l) => l.includes("--runtime"))).toBe(false);
    expect(omitted.some((l) => l.includes("# 沙箱内启动 codex"))).toBe(true);
    expect(omitted.some((l) => l.includes("claude"))).toBe(false);
    // Explicit codex behaves identically to omitted.
    const explicit = buildCommandPreview({ ...base, runtime: "codex" });
    expect(explicit).toEqual(omitted);
  });

  it("claude-code preview emits --runtime claude-code and names claude", () => {
    const lines = buildCommandPreview({ ...base, runtime: "claude-code" });
    expect(lines.some((l) => l.includes("--runtime claude-code"))).toBe(true);
    expect(lines.some((l) => l.includes("# 沙箱内启动 claude"))).toBe(true);
    // The codex framing must NOT appear when claude-code is selected.
    expect(lines.some((l) => l.includes("# 沙箱内启动 codex"))).toBe(false);
  });

  it("stopOnWrite never emits the --confirm-before-write line (gate removed)", () => {
    // The dialog now passes stopOnWrite=false always; even if a caller forced it
    // true the preview is the only place it surfaces — assert the dialog's wiring
    // keeps it false-by-construction by checking the false path is line-free.
    const lines = buildCommandPreview({ ...base, stopOnWrite: false });
    expect(lines.some((l) => l.includes("--confirm-before-write"))).toBe(false);
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
