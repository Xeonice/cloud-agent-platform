/**
 * Pure formatter for the session page's per-task resource readout
 * (task-codex-process-metrics). Kept standalone (no React) so it is unit-testable
 * in the node-env vitest suite and importable by `$taskId.tsx`.
 *
 * The readout shows codex's OWN process figure as the PRIMARY value with the
 * container total as background context, labeled by the reading's `scope`:
 *   - `scope: 'process'` → `codex CPU x% · 内存 <rss> (<%>) · 容器 <container mem>`
 *   - `scope: 'container'` (fallback) → `容器 CPU x% · 内存 <mem> (<%>)`
 * degrading honestly to "未运行 / 未采样" only when there is no live reading, and
 * to "加载运行规格…" before the first read resolves. A still-running task that
 * merely missed a sampling tick keeps its (carried-forward) numbers — the backend
 * returns `sampled` with a larger `ageMs`, never `not-running`, on a transient miss.
 */
import type { ContainerResourceSample, TaskResourceResponse } from "@cap/contracts";

/** Human-readable bytes (MiB/GiB) for the resource readout. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
  return `${Math.round(bytes / mib)} MiB`;
}

/** `CPU x% · 内存 <mem> (<pct>)` for a single sample. */
function formatSample(sample: ContainerResourceSample): string {
  const pct =
    sample.memoryPercent != null ? ` (${sample.memoryPercent.toFixed(0)}%)` : "";
  return `CPU ${sample.cpuPercent.toFixed(0)}% · 内存 ${formatBytes(sample.memoryBytes)}${pct}`;
}

/** The per-task resource readout string, scope-aware (see module doc). */
export function formatTaskResource(
  resource: TaskResourceResponse | undefined,
): string {
  if (!resource) return "加载运行规格…";
  if (resource.state === "not-running") return "未运行 / 未采样";
  const primary = formatSample(resource.sample);
  if (resource.scope === "process") {
    const background = resource.container
      ? ` · 容器 ${formatBytes(resource.container.memoryBytes)}`
      : "";
    return `codex ${primary}${background}`;
  }
  // Container fallback: the in-sandbox process read was unavailable.
  return `容器 ${primary}`;
}
