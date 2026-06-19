/**
 * `CapacityAside` — the dashboard `capacity-modern` pool panel
 * (console-design-pixel-merge 4.5; OUTRIGHT REPLACEMENT of the former
 * Agent-capacity aside, per design D6 — the new design shares no structure
 * with it).
 *
 * The right column of the workspace, composed of:
 *  - `mobile-pool-summary` (≤820px only): Runner dot + N/M 在线 + CPU/MEM;
 *  - `pool-hero`: the N/M 在线 online-capacity readout COMPUTED CLIENT-SIDE
 *    from the live ceiling + occupancy (never the design's 7/10 sample), and a
 *    zero-padded NUMBERED slot grid sized to `occupancy.slots.length` for any
 *    configured ceiling 1–20 — never a hardcoded ten-slot layout (the four
 *    archived configurable-task-slots decisions are preserved, not relitigated);
 *  - `pool-lane`: 空闲 → 已分配 → 可接管;
 *  - aggregate CPU/MEM `pool-stat` tiles;
 *  - per-runner resource rows: a CLIENT-SIDE JOIN of `occupancy.slots[].taskId`
 *    × the per-task samples carried in the ONE `/metrics` payload × the tasks
 *    query (repo/title/status). Each join leg degrades HONESTLY — a slotted
 *    task without a sample reads 未采样, a task the tasks query has not
 *    delivered reads as its id — never fabricated zeros;
 *  - the `pool-policy` block (调度区域 / 接管策略 / 写入边界).
 *
 * Data: EVERYTHING flows from the one existing `metricsQuery` poll (5s
 * `refetchInterval`) — `poolPanelQuery()` is its `select` projection over the
 * SAME query key — plus the tasks/repos data the page already owns. NO
 * per-task `GET /tasks/:taskId/metrics` fan-out, NO SSE.
 *
 * SSR-safe: pure render off query data + props; no window/clock/random.
 * Mobile: the `mobile-inbox` rules apply on the established ≤820px convention
 * (`max-[821px]` / `min-[821px]` utilities only — Tailwind v4 max-* is the
 * STRICT `width < N`, so `max-[821px]` IS the inclusive ≤820px the design's
 * `max-width: 820px` means) — the summary strip replaces the
 * hero/stats/list/policy blocks.
 */
import { useQuery } from "@tanstack/react-query";

import type { MetricsResponse, Task } from "@cap/contracts";
import {
  metricsQuery,
  poolPanelQuery,
  type PoolPanelMetrics,
} from "@/lib/api/queries";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { presentTaskStatus } from "./task-status";
import { shortTaskId } from "./queue-panel";

/**
 * Derive the aggregate memory utilization percent (0–100) from the sampled
 * resource block. Prefers `aggregateMemoryBytes` against the summed
 * per-container cgroup limits; falls back to the mean of per-container
 * `memoryPercent` when no limit is reported; returns `null` when nothing
 * usable exists (so the readout renders an honest "—" rather than a
 * fabricated number). PURE.
 */
export function deriveMemoryPercent(
  resources: MetricsResponse["resources"],
): number | null {
  if (!resources.hasActiveContainers) return null;
  const limit = resources.containers.reduce(
    (sum, c) => sum + (c.memoryLimitBytes ?? 0),
    0,
  );
  if (limit > 0 && resources.aggregateMemoryBytes >= 0) {
    return Math.round((resources.aggregateMemoryBytes / limit) * 100);
  }
  const withPercent = resources.containers.filter((c) => c.memoryPercent != null);
  if (withPercent.length === 0) return null;
  const mean =
    withPercent.reduce((sum, c) => sum + (c.memoryPercent ?? 0), 0) /
    withPercent.length;
  return Math.round(mean);
}

/** Zero-padded 1-based slot label ("01" … "20"), design-style. */
export function slotLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** Format a percent figure honestly ("42%" or "—" when not derivable). */
function percentText(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

export interface CapacityAsideProps {
  /** The live task list (the page owns `tasksQuery`; join leg for rows). */
  tasks: readonly Task[];
  /** repoId → repo full display name (`owner/name`), built from `reposQuery`. */
  repoLookup: ReadonlyMap<string, string>;
}

/** The capacity-modern pool panel (reads the one `/metrics` poll, non-blocking). */
export function CapacityAside({ tasks, repoLookup }: CapacityAsideProps) {
  const { data: pool } = useQuery(poolPanelQuery());
  // The aggregate CPU/MEM stat tiles read the sampled block off the SAME
  // `/metrics` cache entry (same query key + cadence — still one poll).
  const { data: metrics } = useQuery(metricsQuery());

  const resources = metrics?.resources;
  const cpuPercent =
    resources && resources.hasActiveContainers
      ? Math.round(resources.aggregateCpuPercent)
      : null;
  const memoryPercent = resources ? deriveMemoryPercent(resources) : null;

  return (
    <aside
      aria-label="远端 Agent 运行池"
      className="min-w-0 overflow-hidden rounded-[10px] bg-card shadow-card min-[821px]:rounded-xl min-[1181px]:sticky min-[1181px]:top-[78px]"
    >
      {/* mobile-pool-summary (≤820px): the hero/stats/list/policy collapse */}
      <div
        aria-label="运行池摘要"
        className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-3.5 py-3 text-[11px] text-muted-foreground shadow-[inset_0_-1px_0_var(--border)] min-[821px]:hidden"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-success shadow-[0_0_0_3px_rgba(26,127,55,0.12)]"
          />
          Runner
        </span>
        <strong className="font-mono text-xs font-semibold whitespace-nowrap text-foreground">
          {pool ? `${pool.active} / ${pool.ceiling} 在线` : "—"}
        </strong>
        <span>CPU {percentText(cpuPercent)}</span>
        <span>MEM {percentText(memoryPercent)}</span>
      </div>

      {pool ? (
        <PoolHero pool={pool} />
      ) : (
        <p className="p-3.5 text-[13px] text-muted-foreground max-[821px]:hidden">
          正在读取容量…
        </p>
      )}

      {/* Aggregate pool stats */}
      <div className="grid grid-cols-2 gap-2 px-3.5 pb-3.5 max-[821px]:hidden">
        <article className="min-w-0 rounded-lg bg-card p-2.5 shadow-ring">
          <span className="text-xs text-muted-foreground">CPU</span>
          <strong className="mt-1.5 block font-mono text-lg text-foreground">
            {percentText(cpuPercent)}
          </strong>
        </article>
        <article className="min-w-0 rounded-lg bg-card p-2.5 shadow-ring">
          <span className="text-xs text-muted-foreground">MEM</span>
          <strong className="mt-1.5 block font-mono text-lg text-foreground">
            {percentText(memoryPercent)}
          </strong>
        </article>
      </div>

      {/* Per-runner resource rows (client-side join over the one poll) */}
      {pool ? (
        <RunnerList pool={pool} tasks={tasks} repoLookup={repoLookup} />
      ) : null}

      {/* Pool policy */}
      <div className="grid grid-cols-3 gap-px bg-border max-[821px]:hidden">
        <PolicyCell label="调度区域" value="iad-02" />
        <PolicyCell label="接管策略" value="任务级终端" />
        <PolicyCell label="执行边界" value="沙箱内自治" />
      </div>
    </aside>
  );
}

/** The pool-hero block: head + N/M 在线 readout + slot grid + pool-lane. */
function PoolHero({ pool }: { pool: PoolPanelMetrics }) {
  return (
    <div className="grid gap-2.5 bg-card p-3.5 shadow-[inset_0_-1px_0_var(--border)] max-[821px]:hidden">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="block text-xs text-muted-foreground">
            REMOTE RUNNER POOL
          </span>
          <h3 className="mt-1.5 text-base font-semibold tracking-[-0.42px] text-foreground">
            远端 Agent 运行池
          </h3>
        </div>
        <span className="inline-flex min-h-6 items-center gap-[7px] rounded-full bg-success-soft px-[9px] font-mono text-[11px] font-semibold whitespace-nowrap text-success">
          <span aria-hidden="true" className="size-2 rounded-full bg-success" />
          healthy
        </span>
      </div>

      {/* online capacity — computed client-side from the live payload */}
      <div className="grid min-h-[66px] min-w-0 content-center rounded-lg bg-[#fafafa] px-3 py-[11px] shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="font-mono text-[10px] uppercase leading-[1.2] text-muted-foreground">
          online capacity
        </span>
        <strong className="my-1 block font-mono text-[28px] font-semibold tracking-[-1.1px] leading-[0.96] text-foreground">
          {pool.active} / {pool.ceiling} 在线
        </strong>
        <small className="font-mono text-[10px] uppercase leading-[1.2] text-muted-foreground">
          iad-02 private runners
        </small>
      </div>

      {/* Numbered slot grid — exactly ceiling-many cells (1–20, runtime-mutable) */}
      <div
        aria-label={`${pool.ceiling} 个 Agent 槽位，${pool.active} 个已占用`}
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${Math.max(pool.slots.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {pool.slots.map((entry) => {
          const sample =
            entry.taskId != null ? pool.taskSamples[entry.taskId] : undefined;
          const hot =
            entry.busy && sample != null && (sample.sample.memoryPercent ?? 0) >= 60;
          return (
            <span
              key={entry.slot}
              className={cn(
                "grid min-h-[26px] place-items-center rounded-[5px]",
                !entry.busy &&
                  "bg-[#f2f3f4] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]",
                entry.busy &&
                  !hot &&
                  "bg-[#303030] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]",
                entry.busy &&
                  hot &&
                  "bg-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]",
              )}
            >
              <span
                className={cn(
                  "font-mono text-[10px] font-semibold",
                  entry.busy ? "text-white/70" : "text-muted-foreground",
                )}
              >
                {slotLabel(entry.slot)}
              </span>
            </span>
          );
        })}
      </div>

      {/* pool-lane: 空闲 → 已分配 → 可接管 */}
      <div
        aria-label="当前调度状态"
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 font-mono text-[10px] text-muted-foreground"
      >
        <span>空闲</span>
        <i
          aria-hidden="true"
          className="block h-px min-w-0 bg-[linear-gradient(90deg,var(--border),var(--info),var(--border))]"
        />
        <strong className="min-w-0 truncate text-[11px] font-semibold text-foreground">
          已分配
        </strong>
        <i
          aria-hidden="true"
          className="block h-px min-w-0 bg-[linear-gradient(90deg,var(--border),var(--info),var(--border))]"
        />
        <span>可接管</span>
      </div>
    </div>
  );
}

/**
 * The per-runner rows: one row per BUSY slot, joined client-side with the
 * per-task sample (resources leg) and the tasks query (repo/title/status leg).
 * Either leg may lag the occupancy snapshot — each degrades honestly.
 */
function RunnerList({
  pool,
  tasks,
  repoLookup,
}: {
  pool: PoolPanelMetrics;
  tasks: readonly Task[];
  repoLookup: ReadonlyMap<string, string>;
}) {
  const busySlots = pool.slots.filter(
    (entry): entry is typeof entry & { taskId: string } =>
      entry.busy && entry.taskId != null,
  );

  return (
    <div
      aria-label="运行中的 runner"
      className="mx-3.5 mb-3.5 grid gap-px overflow-hidden rounded-lg bg-border shadow-ring max-[821px]:hidden"
    >
      {busySlots.length === 0 ? (
        <p className="grid min-h-12 place-items-center bg-card px-2.5 text-xs text-muted-foreground">
          暂无运行中的任务
        </p>
      ) : (
        busySlots.map((entry) => {
          const task = tasks.find((t) => t.id === entry.taskId);
          const sample = pool.taskSamples[entry.taskId];
          const present = task ? presentTaskStatus(task.status) : null;
          return (
            <article
              key={entry.slot}
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 bg-card px-2.5 py-[9px]"
            >
              <div className="min-w-0">
                <strong className="block truncate font-mono text-xs text-foreground">
                  {task ? (repoLookup.get(task.repoId) ?? task.repoId) : shortTaskId(entry.taskId)}
                </strong>
                <span className="mt-[3px] block truncate text-xs text-muted-foreground">
                  {task ? task.prompt : "任务详情未同步"}
                </span>
              </div>
              {sample ? (
                <div
                  aria-label={`${task ? shortTaskId(task.id) : shortTaskId(entry.taskId)} 资源`}
                  className="grid grid-cols-[repeat(2,48px)] gap-[5px]"
                >
                  <span className="grid min-w-0 gap-[3px] rounded-md bg-[#fafafa] px-1.5 py-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                    <small className="font-mono text-[9px] font-semibold leading-none text-muted-foreground">
                      CPU
                    </small>
                    <strong className="font-mono text-xs font-semibold leading-none text-foreground">
                      {Math.round(sample.sample.cpuPercent)}%
                    </strong>
                  </span>
                  <span className="grid min-w-0 gap-[3px] rounded-md bg-[#fafafa] px-1.5 py-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                    <small className="font-mono text-[9px] font-semibold leading-none text-muted-foreground">
                      MEM
                    </small>
                    <strong className="font-mono text-xs font-semibold leading-none text-foreground">
                      {sample.sample.memoryPercent != null
                        ? `${Math.round(sample.sample.memoryPercent)}%`
                        : "—"}
                    </strong>
                  </span>
                </div>
              ) : (
                // Honest degradation: the slot is occupied but no per-task
                // frame exists in the latest snapshot — never zero-filled.
                <span className="font-mono text-[11px] text-muted-foreground">
                  未采样
                </span>
              )}
              {present ? (
                <StatusPill variant={present.variant}>{present.label}</StatusPill>
              ) : (
                <StatusPill variant="neutral">未知</StatusPill>
              )}
            </article>
          );
        })
      )}
    </div>
  );
}

/** A pool-policy cell (muted label over a semibold value). */
function PolicyCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[#fafafa] p-3">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <strong className="mt-[5px] block text-xs font-semibold text-foreground">
        {value}
      </strong>
    </div>
  );
}
