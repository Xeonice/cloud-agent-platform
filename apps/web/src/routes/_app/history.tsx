/**
 * `/history` — 历史与日志 · 审计时间线 (app-shell, SSR; Track 15
 * fe-page-history, tasks 15.1–15.4).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (sidebar / topbar /
 * mobile-nav already exist — this route does NOT rebuild the shell). Composes,
 * faithfully to the `history.html` prototype:
 *   - the screen-header (eyebrow 历史 / h1 审计时间线 / lead);
 *   - `HistorySummary` — the 3-up ACTIVE WINDOW / ATTENTION / RETENTION strip,
 *     bound honestly (ATTENTION = live `awaiting_input` count; RETENTION =
 *     `settingsQuery().retention`);
 *   - the audit-toolbar — a search input + a level `SegmentedControl`
 *     (全部/信息/警告/错误) + a live `CountChip` event count;
 *   - the `grid-2`: LEFT `RecentTasksTable` (from `tasksQuery`) · RIGHT
 *     `AuditTimeline` (from `historyEventsQuery`).
 *
 * THE ONE FILTER DRIVES BOTH COLUMNS (task 15.3): a SINGLE `useClientFilter`
 * instance (instantiated over the EVENTS) owns the shared search + level state.
 *   - Its `visible` is the search- AND level-filtered event list → feeds the
 *     timeline, and `visibleCount` is the number shown in the toolbar CountChip.
 *   - The SAME `state` is fed into a SECOND pure `filterItems` call over the
 *     TASKS, using TEXT-ONLY accessors (no `level` accessor) so the search
 *     narrows the table too while the level segment leaves the table intact
 *     (tasks carry no audit level, so a level filter must not empty the table).
 * The filter is a pure `useMemo` view derivation — it never mutates the Query
 * cache and never triggers a refetch.
 *
 * Data wiring: the loader ensures `tasksQuery` + `reposQuery` +
 * `historyEventsQuery` in PARALLEL (no waterfall). History is MOCK today but is
 * read through `historyEventsQuery` so flipping `capabilities.history` repoints
 * it at the real audit endpoint with no page change (task 15.4). The page is
 * READ-ONLY (no WS / terminal).
 *
 * SSR-safe: the timeline clock + the table 耗时 are formatted deterministically
 * from stored timestamps. The 耗时 elapsed span depends on the current time, so
 * `now` is sampled in a `useEffect`-set state (never during render / at module
 * top level) — SSR and the first client render both show "—" until mount, then
 * the client fills in the elapsed value, so there is no hydration mismatch.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { AuditEvent, Repo, Task } from "@cap/contracts";
import {
  historyEventsQuery,
  reposQuery,
  settingsQuery,
  tasksQuery,
} from "@/lib/api/queries";
import {
  ALL,
  filterItems,
  useClientFilter,
  type FilterAccessors,
  type LevelFilter,
} from "@/hooks/use-client-filter";
import { SegmentedControl } from "@/components/segmented-control";
import { CountChip } from "@/components/count-chip";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { HistorySummary } from "@/components/history/history-summary";
import { RecentTasksTable } from "@/components/history/recent-tasks-table";
import { AuditTimeline } from "@/components/history/audit-timeline";

export const Route = createFileRoute("/_app/history")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between tasks / repos / audit events.
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
      context.queryClient.ensureQueryData(historyEventsQuery()),
    ]);
  },
  component: HistoryPage,
});

/** The level segment values: 全部 / 信息 / 警告 / 错误 (maps to the contract levels). */
const LEVEL_OPTIONS: readonly { value: LevelFilter; label: string }[] = [
  { value: ALL, label: "全部" },
  { value: "info", label: "信息" },
  { value: "warning", label: "警告" },
  { value: "error", label: "错误" },
];

/** Resolve a repo's display name (`name` is the stable, prototype-shown label). */
function repoName(repo: Repo): string {
  return repo.name;
}

/**
 * Timeline accessors: search matches title/description/type/short-task-id, and
 * the `level` accessor lets the level segment narrow the timeline.
 */
const EVENT_ACCESSORS: FilterAccessors<AuditEvent> = {
  text: (event) => [
    event.title,
    event.description,
    event.type,
    shortTaskId(event.taskId),
  ],
  level: (event) => event.level,
};

function HistoryPage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());
  const { data: events } = useQuery(historyEventsQuery());

  const taskList = tasks ?? [];
  const repoList = repos ?? [];
  const eventList = events ?? [];

  // repoId → repo display name (for the table rows + the shared text search).
  const repoLookup = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repoList) map.set(repo.id, repoName(repo));
    return map;
  }, [repoList]);

  // Tasks most-recent-first (the prototype's "最新在前").
  const sortedTasks = React.useMemo(
    () =>
      [...taskList].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
    [taskList],
  );

  // Events most-recent-first (the query already orders this; re-sort defensively
  // so the timeline is independent of the source's ordering guarantees).
  const sortedEvents = React.useMemo(
    () =>
      [...eventList].sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
      ),
    [eventList],
  );

  // THE ONE FILTER. Instantiated over the EVENTS so `visible` is the search- AND
  // level-filtered timeline and `visibleCount` is the toolbar's event count.
  const filter = useClientFilter(sortedEvents, EVENT_ACCESSORS);

  // The SAME state drives a SECOND pure filter over the TASKS — TEXT-ONLY
  // accessors (no `level`) so the search narrows the table while the level
  // segment leaves it intact (tasks carry no audit level).
  const taskAccessors = React.useMemo<FilterAccessors<Task>>(
    () => ({
      text: (task) => [
        shortTaskId(task.id),
        repoLookup.get(task.repoId),
        task.prompt,
        task.branch,
      ],
    }),
    [repoLookup],
  );
  const visibleTasks = React.useMemo(
    () => filterItems(sortedTasks, filter.state, taskAccessors),
    [sortedTasks, filter.state, taskAccessors],
  );

  // ATTENTION tile: live count of tasks awaiting operator confirmation.
  const attentionCount = React.useMemo(
    () => taskList.filter((t) => t.status === "awaiting_input").length,
    [taskList],
  );

  // 耗时 depends on the current wall clock — sample it AFTER mount (never during
  // render) so SSR + first client render match, then tick it forward gently.
  const [now, setNow] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // RETENTION tile binds to the real settings window. Read via `useQuery` (not
  // loader-blocking) — MOCK today; may be absent during the hydration window, in
  // which case the tile shows "—" rather than a fabricated number.
  const { data: settings } = useQuery(settingsQuery());

  return (
    <>
      {/* screen-header */}
      <section className="mb-[18px]">
        <div className="font-mono text-xs font-semibold text-muted-foreground">
          历史
        </div>
        <h1 className="mt-2 max-w-[760px] text-[clamp(24px,3vw,32px)] font-semibold leading-[1.18] tracking-[-0.8px] text-ink">
          审计时间线
        </h1>
        <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
          按任务查看结果、耗时和会话记录；事件流用于快速定位 runner、GitHub token、测试和 PR 事件。
        </p>
      </section>

      {/* history-summary */}
      <HistorySummary
        attentionCount={attentionCount}
        retentionDays={settings?.retention}
      />

      {/* audit-toolbar */}
      <section
        className="mb-3 grid items-center gap-2.5 rounded-lg bg-card p-3 shadow-card min-[821px]:grid-cols-[minmax(280px,380px)_auto_auto]"
        aria-label="审计筛选"
      >
        <label className="grid min-h-9 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]">
          <span
            aria-hidden="true"
            className="grid place-items-center font-mono text-[15px] leading-none text-muted-foreground"
          >
            ⌕
          </span>
          <input
            type="search"
            data-history-search
            aria-label="搜索历史日志"
            placeholder="搜索任务、仓库、事件类型"
            value={filter.state.search}
            onChange={(e) => filter.setSearch(e.target.value)}
            className="min-h-9 w-full border-0 bg-transparent pr-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <SegmentedControl
          compact
          ariaLabel="事件级别"
          options={LEVEL_OPTIONS}
          value={filter.state.level}
          onValueChange={filter.setLevel}
        />
        <CountChip className="justify-self-end" data-history-visible-count>
          {filter.visibleCount} 条事件
        </CountChip>
      </section>

      {/* grid-2: 最近任务 · 事件流 — prototype `.grid-2` is an ASYMMETRIC split
          (table 1.05fr wider · timeline 0.95fr with a 320px floor) that only
          engages at >=1181px and collapses to a single stacked column below
          (styles.css:820 + the @media max-width:1180px override at :2551). */}
      <section className="grid items-start gap-3 min-[1181px]:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <RecentTasksTable
          tasks={visibleTasks}
          repoLookup={repoLookup}
          now={now}
        />
        <AuditTimeline events={filter.visible} />
      </section>
    </>
  );
}
