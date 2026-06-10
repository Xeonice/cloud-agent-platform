/**
 * `CapacityAside` — the dashboard `.capacity-panel` (Track 16, task 16.4).
 *
 * The right column of the workspace: an Agent-capacity summary, a `SlotMeter`
 * sized to the live ceiling (one cell AND one grid column per `occupancy.slots`
 * entry — works for any configured ceiling in 1–20), a `ResourceMeter` list
 * (CPU + memory bars), and a compact `ConfigList` (scheduling region / takeover
 * policy / write boundary). Reads `metricsQuery()` via `useQuery` — MOCK today
 * (the `/metrics` capability needs an OAuth session), non-blocking, so the panel
 * renders a quiet placeholder until the (mock) payload resolves rather than
 * blocking the route loader.
 *
 * Live data, never hardcoded:
 *  - 当前占用  ← `capacity.active` / `capacity.ceiling`
 *  - 空闲槽位  ← `capacity.free`
 *  - 槽位表    ← `occupancy.slots` (busy cells filled; the warn tint is
 *               derived from the per-slot container memory sample, not pinned)
 *  - CPU %     ← `resources.aggregateCpuPercent`
 *  - 内存 %    ← derived from `resources.aggregateMemoryBytes` vs the summed
 *               per-container `memoryLimitBytes` (falls back to a per-container
 *               `memoryPercent` average when no limit is reported).
 *
 * SSR-safe: pure render off query data; no window/clock/random.
 *
 * Fidelity (FINAL `.console-body` cascade): capacity-summary = white ringed card;
 * value mono 34px. Slot cells h-26 radius-4; busy = soft-green fill + 1px green
 * ring; busy.warn = soft-amber fill + amber ring. Bars h-8 rounded-full; memory
 * bar uses `.warn` (amber). ConfigList = ringed list, 44px rows, muted label.
 */
import { useQuery } from "@tanstack/react-query";

import type {
  ContainerResourceSample,
  MetricsResponse,
  SlotEntry,
} from "@cap/contracts";
import { metricsQuery } from "@/lib/api/queries";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";

/**
 * Derive the aggregate memory utilization percent (0–100) from the sampled
 * resource block. Prefers `aggregateMemoryBytes` against the summed per-container
 * cgroup limits; falls back to the mean of per-container `memoryPercent` when no
 * limit is reported; returns `null` when nothing usable exists (so the bar can
 * render an honest empty state rather than a fabricated number). PURE.
 */
export function deriveMemoryPercent(
  resources: MetricsResponse["resources"],
): number | null {
  const limit = resources.containers.reduce(
    (sum, c) => sum + (c.memoryLimitBytes ?? 0),
    0,
  );
  if (limit > 0 && resources.aggregateMemoryBytes >= 0) {
    return Math.round((resources.aggregateMemoryBytes / limit) * 100);
  }
  const withPercent = resources.containers.filter(
    (c): c is ContainerResourceSample & { memoryPercent: number } =>
      c.memoryPercent != null,
  );
  if (withPercent.length === 0) return null;
  const mean =
    withPercent.reduce((sum, c) => sum + c.memoryPercent, 0) / withPercent.length;
  return Math.round(mean);
}

/** A single slot cell: busy fills green, a warn-tinted busy cell fills amber. */
function SlotCell({ entry, warn }: { entry: SlotEntry; warn: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-[26px] rounded-[4px]",
        !entry.busy && "bg-[#f2f3f4] shadow-[rgba(0,0,0,0.06)_0_0_0_1px_inset]",
        entry.busy &&
          !warn &&
          "bg-[color-mix(in_oklch,var(--success)_18%,white)] shadow-[color-mix(in_oklch,var(--success)_32%,transparent)_0_0_0_1px_inset]",
        entry.busy &&
          warn &&
          "bg-[color-mix(in_oklch,var(--warning)_22%,white)] shadow-[color-mix(in_oklch,var(--warning)_36%,transparent)_0_0_0_1px_inset]",
      )}
    />
  );
}

/** One resource bar (CPU or memory) with its head row + filled track. */
function ResourceMeter({
  label,
  percent,
  warn = false,
}: {
  label: string;
  percent: number | null;
  warn?: boolean;
}) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2.5 text-[13px] text-muted-foreground">
        <span>{label}</span>
        <strong className="font-mono text-foreground">
          {percent == null ? "—" : `${percent}%`}
        </strong>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#eeeeee]">
        <span
          className={cn(
            "block h-full rounded-[inherit]",
            warn ? "bg-warning" : "bg-success",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/** A row of the compact ConfigList (muted label / right-aligned ink value). */
function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 bg-card px-3 text-[13px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line">
      <span className="text-muted-foreground">{label}</span>
      <strong className="text-right font-semibold text-ink">{value}</strong>
    </div>
  );
}

/** The capacity aside panel; reads `metricsQuery` (mock today, non-blocking). */
export function CapacityAside() {
  const { data: metrics } = useQuery(metricsQuery());

  return (
    <aside className="sticky top-[78px] min-w-0 rounded-lg bg-card p-[18px] shadow-card">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-foreground">Agent 容量</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {metrics ? `${metrics.capacity.ceiling} 个槽位` : "—"}
        </span>
      </div>

      {metrics ? (
        <CapacityBody metrics={metrics} />
      ) : (
        <p className="text-[13px] text-muted-foreground">正在读取容量…</p>
      )}

      <div className="mt-4 grid overflow-hidden rounded-md shadow-ring">
        <ConfigRow label="调度区域" value="iad-02" />
        <ConfigRow label="接管策略" value="任务级终端" />
        <ConfigRow label="写入边界" value="确认后执行" />
      </div>
    </aside>
  );
}

/** The data-driven capacity body (summary + slot meter + resource bars). */
function CapacityBody({ metrics }: { metrics: MetricsResponse }) {
  const { capacity, occupancy, resources } = metrics;
  const memoryPercent = deriveMemoryPercent(resources);

  // A busy slot is rendered with the warn tint when its occupying container's
  // sampled memory is the hottest band (>= 60% of its limit) — derived, not
  // pinned to the prototype's static slot indices.
  const warnTaskIds = new Set(
    resources.containers
      .filter((c) => (c.memoryPercent ?? 0) >= 60)
      .map((c) => c.taskId),
  );

  return (
    <>
      <div className="mb-4 grid gap-3 rounded-md bg-card p-3.5 shadow-ring">
        <div>
          <span className="font-mono text-xs font-semibold text-muted-foreground">
            当前占用
          </span>
          <strong className="mt-1.5 block font-mono text-[34px] tracking-[-1px] text-ink">
            {capacity.active} / {capacity.ceiling}
          </strong>
        </div>
        <StatusPill variant="green" className="w-fit">
          {capacity.free} 个空闲槽位
        </StatusPill>
      </div>

      <div
        aria-label={`${capacity.ceiling} 个 Agent 槽位，${capacity.active} 个已占用`}
        className="mb-4 grid gap-1"
        // One column per live slot (occupancy.slots.length, ceiling 1–20) —
        // never a hardcoded ten-column grid (configurable-task-slots).
        style={{
          gridTemplateColumns: `repeat(${Math.max(occupancy.slots.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {occupancy.slots.map((entry) => (
          <SlotCell
            key={entry.slot}
            entry={entry}
            warn={entry.busy && entry.taskId != null && warnTaskIds.has(entry.taskId)}
          />
        ))}
      </div>

      <div
        aria-label="当前资源占比"
        className="grid gap-3.5 pt-3.5 shadow-[rgba(0,0,0,0.06)_0_-1px_0_0]"
      >
        <ResourceMeter
          label="当前 CPU 占比"
          percent={Math.round(resources.aggregateCpuPercent)}
        />
        <ResourceMeter label="当前内存占比" percent={memoryPercent} warn />
      </div>
    </>
  );
}
