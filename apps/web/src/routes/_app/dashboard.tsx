/**
 * `/dashboard` — 运行工作台 / 任务控制台 (app-shell, SSR; Track 16 fe-page-dashboard).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (the sidebar +
 * topbar + mobile-nav already exist in Track 11 — this route does NOT rebuild the
 * shell). Composes:
 *   - the workbench header (eyebrow / title / lead + the 观察窗口 time-range
 *     `SegmentedControl` + the 新建任务 button that opens the dialog),
 *   - the 4-up `MetricStrip` (live `metricsQuery` capacity scalars + runner
 *     minutes — NEVER hardcoded),
 *   - the 2-column workspace (`QueuePanel` : `CapacityAside`),
 *   - the `NewTaskDialog`.
 *
 * Data wiring:
 *   - The route loader ensures `tasksQuery()` + `reposQuery()` in PARALLEL (no
 *     waterfall) so the queue + the create form's repo list are hydrated before
 *     render. `metricsQuery` is read via `useQuery` inside the metric strip +
 *     capacity aside (MOCK today; non-blocking — it must not block the route).
 *   - The task list polls every 5s (the factory's `refetchInterval`); this route
 *     adds NO manual interval.
 *   - The search + status filter are CLIENT-ONLY view state inside `QueuePanel`
 *     (they never mutate the cache); the repoId→name lookup is built off
 *     `reposQuery` here and passed down.
 *
 * SSR-safe: deterministic render off query data; the time-range + dialog-open
 * flags are plain `useState`. No window/clock/random during render.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { MetricsResponse, Repo } from "@cap/contracts";
import { metricsQuery, reposQuery, tasksQuery } from "@/lib/api/queries";
import { SegmentedControl } from "@/components/segmented-control";
import { MetricStrip, MetricTile } from "@/components/dashboard/metric-tile";
import { QueuePanel } from "@/components/dashboard/queue-panel";
import { CapacityAside } from "@/components/dashboard/capacity-aside";
import { NewTaskDialog } from "@/components/dashboard/new-task-dialog";

export const Route = createFileRoute("/_app/dashboard")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between the queue + the repo list.
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
    ]);
  },
  component: DashboardPage,
});

/** The 观察窗口 time-range values (client-only view switch). */
type TimeRange = "24h" | "7d" | "30d";

const RANGE_OPTIONS: readonly { value: TimeRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/** Resolve a repo's `owner/name` display from its gitSource (or fall back to name). */
function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

/** Format runner-minutes for the metric tile ("1287.5m" / "—" when unavailable). */
function formatRunnerMinutes(metrics: MetricsResponse | undefined): string {
  if (!metrics) return "—";
  const { available, minutes } = metrics.runnerMinutes;
  if (!available || minutes == null) return "—";
  // Drop a trailing ".0" but keep a real fractional minute (1287.5m).
  const rounded = Math.round(minutes * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}m`;
}

function DashboardPage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());
  const { data: metrics } = useQuery(metricsQuery());

  const [range, setRange] = React.useState<TimeRange>("24h");
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const repoList = repos ?? [];
  const taskList = tasks ?? [];

  // repoId → `owner/name` lookup for the queue rows + search.
  const repoLookup = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repoList) map.set(repo.id, repoFullName(repo));
    return map;
  }, [repoList]);

  const capacity = metrics?.capacity;

  return (
    <>
      {/* Workbench header */}
      <section aria-label="任务工作台摘要" className="mb-3 grid items-start gap-4 min-[1101px]:grid-cols-[minmax(0,1fr)_auto] min-[1101px]:items-end">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            任务
          </div>
          <h1 className="mt-1 mb-2 text-[32px] leading-[1.15] font-semibold tracking-tight text-foreground">
            运行工作台
          </h1>
          <p className="max-w-[680px] text-[13px] leading-[1.55] text-muted-foreground">
            把远端 Agent 当成一组可排队、可接管、可审计的运行资源；这里优先处理等待输入和正在执行的任务。
          </p>
        </div>
        <div className="flex items-center justify-start gap-2.5 min-[1101px]:justify-end">
          <div className="grid justify-items-end gap-[7px] self-end text-xs text-muted-foreground">
            <span className="sr-only">观察窗口</span>
            <SegmentedControl
              ariaLabel="时间范围"
              options={RANGE_OPTIONS}
              value={range}
              onValueChange={setRange}
            />
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            新建任务
          </button>
        </div>
      </section>

      {/* Ops status bar */}
      <MetricStrip>
        <MetricTile
          label="活跃任务"
          value={capacity ? capacity.active : "—"}
          caption="正在占用运行槽位"
        />
        <MetricTile
          label="待处理命令"
          value={capacity ? capacity.queueDepth : "—"}
          caption="任务内 CLI"
        />
        <MetricTile
          label="Runner 分钟"
          value={formatRunnerMinutes(metrics)}
          caption="iad-02 当前窗口"
        />
        <MetricTile
          label="空闲槽位"
          value={capacity ? capacity.free : "—"}
          caption={capacity ? `${capacity.ceiling} 个总槽位` : "—"}
        />
      </MetricStrip>

      {/* Workspace */}
      <section className="grid items-start gap-3 min-[1181px]:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <QueuePanel tasks={taskList} repoLookup={repoLookup} />
        <CapacityAside />
      </section>

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} repos={repoList} />
    </>
  );
}
