/**
 * Per-task resource readout formatting (task-codex-process-metrics 4.3). Pure,
 * node-env. Guards: codex `process` scope shows the codex primary + container
 * background; the `container` fallback shows only the container; not-running and
 * pre-read states degrade honestly.
 */
import { describe, it, expect } from "vitest";

import { formatTaskResource, formatBytes } from "./format-resource";

const sample = (cpu: number, memBytes: number, pct: number | null) => ({
  taskId: "t",
  cpuPercent: cpu,
  memoryBytes: memBytes,
  memoryLimitBytes: 8 * 1024 * 1024 * 1024,
  memoryPercent: pct,
});

describe("formatTaskResource", () => {
  it("process scope: codex primary + container background", () => {
    const out = formatTaskResource({
      state: "sampled",
      scope: "process",
      sample: sample(5, 126 * 1024 * 1024, 1.6),
      container: sample(2, 1.5 * 1024 * 1024 * 1024, 18),
      sampledAt: new Date(),
      ageMs: 1300,
    });
    expect(out).toContain("codex");
    expect(out).toContain("CPU 5%");
    expect(out).toContain("126 MiB");
    expect(out).toContain("容器 1.5 GiB"); // container total as background
  });

  it("container fallback: only the container figure, no codex/background", () => {
    const out = formatTaskResource({
      state: "sampled",
      scope: "container",
      sample: sample(2, 1.5 * 1024 * 1024 * 1024, 18),
      container: null,
      sampledAt: new Date(),
      ageMs: 1300,
    });
    expect(out.startsWith("容器 ")).toBe(true);
    expect(out).not.toContain("codex");
    expect(out).toContain("1.5 GiB");
  });

  it("omits the memory percent when null", () => {
    const out = formatTaskResource({
      state: "sampled",
      scope: "process",
      sample: sample(5, 126 * 1024 * 1024, null),
      container: null,
      sampledAt: new Date(),
      ageMs: 0,
    });
    expect(out).not.toMatch(/\(\d+%\)/);
  });

  it("not-running → honest placeholder, pre-read → loading", () => {
    expect(formatTaskResource({ state: "not-running" })).toBe("未运行 / 未采样");
    expect(formatTaskResource(undefined)).toBe("加载运行规格…");
  });
});

describe("formatBytes", () => {
  it("formats GiB and MiB", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GiB");
    expect(formatBytes(126 * 1024 * 1024)).toBe("126 MiB");
    expect(formatBytes(0)).toBe("0 B");
  });
});
