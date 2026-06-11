/**
 * `/dashboard` — 运行工作台 / 任务控制台 (app-shell, SSR; Track 16
 * fe-page-dashboard, merged to the design revision by console-design-pixel-merge).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (the sidebar +
 * topbar + mobile-nav already exist in Track 11 — this route does NOT rebuild the
 * shell). Composes:
 *   - the workbench header (eyebrow / title / lead + the 观察窗口 time-range
 *     `SegmentedControl` + the 新建任务 button that opens the dialog, plus the
 *     ≤820px `mobile-workbench-meta` strip),
 *   - the 2-column workspace: the attention-first inbox (`QueuePanel`) and the
 *     `capacity-modern` pool panel (`CapacityAside`),
 *   - the `NewTaskDialog`.
 *
 * The former 4-tile `MetricStrip` is intentionally REMOVED (an accepted
 * proposal decision, not an omission): the inbox tab counts and the pool panel
 * carry its information.
 *
 * Data wiring:
 *   - The route loader ensures `tasksQuery()` + `reposQuery()` in PARALLEL (no
 *     waterfall) so the inbox + the create form's repo list are hydrated before
 *     render. The pool panel reads the one `metricsQuery` poll via `useQuery`
 *     internally (non-blocking — it must not block the route).
 *   - The task list polls every 5s (the factory's `refetchInterval`); this route
 *     adds NO manual interval.
 *   - The search + status tabs are CLIENT-ONLY view state inside `QueuePanel`
 *     (they never mutate the cache); the repoId→name lookup is built off
 *     `reposQuery` here and passed down to BOTH columns (the pool panel's
 *     per-runner join reuses it).
 *
 * Mobile: the `mobile-inbox` rules apply on the established ≤820px convention
 * (`max-[821px]` / `min-[821px]` utilities only — Tailwind v4 max-* is the
 * STRICT `width < N`, so `max-[821px]` IS the inclusive ≤820px the design's
 * `max-width: 820px` means; no new JS breakpoint).
 *
 * SSR-safe: deterministic render off query data; the time-range + dialog-open
 * flags are plain `useState`. No window/clock/random during render.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { Repo } from "@cap/contracts";
import { reposQuery, tasksQuery } from "@/lib/api/queries";
import { SegmentedControl } from "@/components/segmented-control";
import { QueuePanel } from "@/components/dashboard/queue-panel";
import { CapacityAside } from "@/components/dashboard/capacity-aside";
import { NewTaskDialog } from "@/components/dashboard/new-task-dialog";
import { isOpenTask } from "@/components/dashboard/task-status";

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

function DashboardPage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());

  const [range, setRange] = React.useState<TimeRange>("24h");
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const repoList = repos ?? [];
  const taskList = tasks ?? [];

  // repoId → `owner/name` lookup for the inbox rows + the pool panel join.
  const repoLookup = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repoList) map.set(repo.id, repoFullName(repo));
    return map;
  }, [repoList]);

  // The ≤820px workbench-meta tally (open = non-terminal tasks, live).
  const openCount = React.useMemo(
    () => taskList.filter((t) => isOpenTask(t.status)).length,
    [taskList],
  );

  return (
    <>
      {/* Workbench header */}
      <section
        aria-label="任务工作台摘要"
        className="mb-3 grid items-start gap-4 max-[821px]:grid-cols-[minmax(0,1fr)_auto] max-[821px]:gap-x-3 max-[821px]:gap-y-2.5 min-[1101px]:grid-cols-[minmax(0,1fr)_auto] min-[1101px]:items-end"
      >
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground max-[821px]:hidden">
            任务
          </div>
          <h1 className="mt-1 mb-2 text-[32px] leading-[1.15] font-semibold tracking-tight text-foreground max-[821px]:m-0 max-[821px]:text-2xl max-[821px]:leading-[1.12] max-[821px]:tracking-[-0.62px]">
            运行工作台
          </h1>
          <p className="max-w-[680px] text-[13px] leading-[1.55] text-muted-foreground max-[821px]:hidden">
            把远端 Agent 当成一组可排队、可接管、可审计的运行资源；这里优先处理等待输入和正在执行的任务。
          </p>
          {/* mobile-workbench-meta (≤820px only) */}
          <div
            aria-label="移动端工作台状态"
            className="mt-[7px] hidden min-w-0 flex-wrap items-center gap-x-2.5 gap-y-[7px] text-xs leading-[1.25] text-muted-foreground max-[821px]:flex"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-success shadow-[0_0_0_3px_rgba(26,127,55,0.12)]"
              />
              Runner 池正常
            </span>
            <strong className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
              {openCount} 个待关注任务
            </strong>
          </div>
        </div>
        {/* ≤820px the actions wrapper dissolves (`contents`): the 新建任务
            button docks beside the title, the segmented spans the next row. */}
        <div className="flex items-center justify-start gap-2.5 max-[821px]:contents min-[1101px]:justify-end">
          <div className="grid justify-items-end gap-[7px] self-end text-xs text-muted-foreground max-[821px]:col-span-2 max-[821px]:row-start-2 max-[821px]:w-full max-[821px]:justify-items-stretch">
            <span className="sr-only">观察窗口</span>
            <SegmentedControl
              ariaLabel="时间范围"
              options={RANGE_OPTIONS}
              value={range}
              onValueChange={setRange}
              className="max-[821px]:w-full max-[821px]:[&>button]:min-w-0 max-[821px]:[&>button]:flex-1"
            />
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-[#2a2a2a] max-[821px]:col-start-2 max-[821px]:row-start-1 max-[821px]:h-[34px] max-[821px]:self-start max-[821px]:px-[11px] max-[821px]:text-xs"
          >
            新建任务
          </button>
        </div>
      </section>

      {/* Workspace — the former 4-tile MetricStrip is intentionally REMOVED
          (console-design-pixel-merge proposal decision): its information is
          carried by the inbox tab counts and the capacity-modern pool panel. */}
      <section className="grid items-start gap-3 max-[821px]:gap-2.5 min-[1181px]:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <QueuePanel tasks={taskList} repoLookup={repoLookup} />
        <CapacityAside tasks={taskList} repoLookup={repoLookup} />
      </section>

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} repos={repoList} />
    </>
  );
}
