/**
 * `/history` — 任务历史 (app-shell, SSR; pixel-restore-console-to-od Track 9).
 *
 * The page BODY inside the `_app` shell `<Outlet/>`. Rewritten from the former
 * summary-tiles + recent-tasks-table + audit event-stream into a single
 * Vercel-style TASK-ROW LIST faithful to `design-baseline/screens/history.html`:
 *   - the screen-header (eyebrow 历史 / h1 任务历史 / lead);
 *   - a 运行记录 panel with a head (subtitle + a live "N 条记录" count pill);
 *   - an audit-toolbar — search + a status SegmentedControl
 *     (全部/运行中/等待输入/排队/已完成/失败);
 *   - the task-row list (status pill + id + title + repo·branch + Agent + 耗时 +
 *     a dark 「查看会话」 linking to the task's 会话记录; queued/pending show a
 *     disabled 等待接入) + an empty state.
 *
 * The single client filter (search + status bucket via `presentHistoryResult`)
 * drives the list and the count, as a pure `useMemo` view derivation — it never
 * mutates the query cache. The page is READ-ONLY (no WS / terminal). The former
 * ACTIVE WINDOW/ATTENTION/RETENTION tiles and the right-hand audit timeline are
 * removed.
 *
 * SSR-safe: deterministic render off query data; 耗时 depends on the wall clock,
 * so `now` is sampled in a `useEffect` (never during render) — SSR + first client
 * paint show "—" until mount, then the client fills it in (no hydration mismatch).
 */
import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { Repo, Task } from "@cap/contracts";
import { reposQuery, tasksQuery } from "@/lib/api/queries";
import { agentLabel } from "@/lib/runtime-label";
import { StatusPill } from "@/components/status-pill";
import { RuntimeAuthFailureBadge } from "@/components/runtime-credential-alert";
import { SegmentedControl } from "@/components/segmented-control";
import { EmptyState } from "@/components/empty-state";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import {
  presentHistoryResult,
  type HistoryFilter,
} from "@/components/history/history-result";
import { formatClock, formatElapsed } from "@/components/history/format";

export const Route = createFileRoute("/_app/history")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
    ]);
  },
  component: HistoryPage,
});

/** The status segment: 全部 + the five baseline buckets. */
type StatusSegment = "all" | HistoryFilter;

const STATUS_OPTIONS: readonly { value: StatusSegment; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "awaiting", label: "等待输入" },
  { value: "queued", label: "排队" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
];

function repoName(repo: Repo): string {
  return repo.name;
}

function HistoryPage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());
  const taskList = tasks ?? [];
  const repoList = repos ?? [];

  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusSegment>("all");

  const repoLookup = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repoList) map.set(repo.id, repoName(repo));
    return map;
  }, [repoList]);

  // 耗时 needs the wall clock — sampled after mount (SSR-safe).
  const [now, setNow] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Most-recent-first (the baseline's "最新在前").
  const sortedTasks = React.useMemo(
    () =>
      [...taskList].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [taskList],
  );

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sortedTasks.filter((task) => {
      const result = presentHistoryResult(task.status);
      if (status !== "all" && result.filter !== status) return false;
      if (!needle) return true;
      const haystack = [
        shortTaskId(task.id),
        repoLookup.get(task.repoId) ?? "",
        task.branch ?? "",
        task.prompt,
        agentLabel(task.runtime),
        result.label,
        task.failure?.message ?? "",
        task.failure?.code ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [sortedTasks, repoLookup, search, status]);

  return (
    <>
      {/* screen-header */}
      <section className="mb-[18px]">
        <div className="font-mono text-xs font-semibold text-muted-foreground">
          历史
        </div>
        <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] font-semibold leading-[1.18] tracking-[-0.8px] text-foreground">
          任务历史
        </h1>
        <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
          按任务回看运行结果、耗时与运行 Agent；每条记录都保留可回放的会话记录与终端记录，保留周期可在设置中调整。
        </p>
      </section>

      {/* 运行记录 panel */}
      <section className="mt-3 rounded-[8px] bg-card p-[18px] shadow-card">
        {/* Panel head */}
        <div className="-mx-[18px] -mt-[18px] mb-3.5 flex items-center justify-between gap-3 border-b border-border px-[18px] pb-3.5 pt-[18px]">
          <div>
            <h2 className="text-sm font-semibold text-foreground">运行记录</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              最新在前 · 超过保留周期的记录会自动清除。
            </p>
          </div>
          <StatusPill variant="green" className="whitespace-nowrap">
            {visible.length} 条记录
          </StatusPill>
        </div>

        {/* Toolbar */}
        <div className="mb-3.5 grid items-center gap-3 min-[821px]:grid-cols-[minmax(280px,1fr)_auto]">
          <label className="grid min-h-9 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]">
            <span aria-hidden="true" className="grid place-items-center font-mono text-[15px] leading-none text-muted-foreground">
              ⌕
            </span>
            <input
              type="search"
              aria-label="搜索任务历史"
              placeholder="搜索任务、仓库、分支或 Agent"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-h-9 w-full border-0 bg-transparent pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <SegmentedControl
            compact
            ariaLabel="按状态筛选"
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={setStatus}
            className="max-[821px]:w-full"
          />
        </div>

        {/* Task-row list */}
        {visible.length > 0 ? (
          <div>
            {visible.map((task) => (
              <HistoryRow
                key={task.id}
                task={task}
                repoName={repoLookup.get(task.repoId) ?? task.repoId}
                now={now}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<SearchIcon />}
            title="没有匹配的任务记录"
            description="换个关键词，或切换到其它状态筛选。"
          />
        )}
      </section>
    </>
  );
}

/** One history row (one task). Action is 查看会话 → transcript, queued → disabled. */
function HistoryRow({
  task,
  repoName: repo,
  now,
}: {
  task: Task;
  repoName: string;
  now: number | undefined;
}) {
  const result = presentHistoryResult(task.status);
  const id = shortTaskId(task.id);
  const queued = result.filter === "queued";
  const elapsed = formatElapsed(task.createdAt, now);
  const clock = formatClock(task.createdAt);
  const timeText = queued ? clock : `${elapsed} · ${clock}`;

  return (
    <article className="border-b border-border last:border-b-0 min-[821px]:hover:bg-[#fbfbfb]">
      <div className="grid items-start gap-x-3 gap-y-2 px-2 py-3 [grid-template-areas:'main_action''context_action'] grid-cols-[minmax(0,1fr)_auto] min-[821px]:grid-cols-[minmax(300px,1fr)_minmax(150px,200px)_108px] min-[821px]:items-center min-[821px]:gap-3 min-[821px]:px-2 min-[821px]:py-[11px] min-[821px]:[grid-template-areas:'main_context_action']">
        {/* Task / repo */}
        <div className="min-w-0 [grid-area:main]">
          <div className="mb-[3px] flex flex-wrap items-center gap-[7px]">
            <span className="font-mono text-[13px] font-semibold text-foreground">{id}</span>
            <StatusPill variant={result.variant}>{result.label}</StatusPill>
            {task.failure ? (
              <RuntimeAuthFailureBadge failure={task.failure} />
            ) : null}
          </div>
          <h3 className="text-[13px] font-semibold leading-[1.3] text-foreground [text-wrap:pretty]">
            {task.prompt}
          </h3>
          <p className="mt-1 min-w-0 text-[11px] leading-[1.25] text-muted-foreground">
            <strong className="block truncate font-mono font-medium">
              {repo} · {task.branch ?? "—"}
            </strong>
          </p>
        </div>

        {/* Agent / 耗时 */}
        <div className="[grid-area:context] grid min-w-0 gap-1 text-muted-foreground">
          <strong className="truncate text-xs leading-[1.22] font-semibold text-foreground">
            {agentLabel(task.runtime)}
          </strong>
          <span className="truncate font-mono text-[11px] leading-[1.22]">{timeText}</span>
        </div>

        {/* Action */}
        <div className="[grid-area:action] grid justify-items-end self-start min-[821px]:self-center">
          {queued ? (
            <span
              aria-disabled="true"
              className="inline-flex min-h-7 cursor-default items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-muted-2 shadow-ring min-[821px]:w-full"
            >
              等待接入
            </span>
          ) : (
            <Link
              to="/tasks/$taskId/transcript"
              params={{ taskId: task.id }}
              className="inline-flex min-h-7 items-center justify-center whitespace-nowrap rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-[#2a2a2a] min-[821px]:w-full"
            >
              查看会话
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
