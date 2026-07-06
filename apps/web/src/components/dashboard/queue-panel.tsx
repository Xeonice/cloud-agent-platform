/**
 * `QueuePanel` — the dashboard attention-first inbox (Track 16 origin; evolved
 * in place by console-design-pixel-merge 4.2/4.3).
 *
 * The left column of the workspace. Renders the live task list from
 * `tasksQuery()` (passed in by the page, which owns the query so the 5s poll +
 * SSR hydration stay in one place) and layers two CLIENT-ONLY view filters over
 * it: a free-text search (`data-task-search`) and the status tab group
 * 全部 / 待处理 / 运行 / 排队 — each tab carrying a LIVE `CountChip` count
 * embedded through the existing SegmentedControl ReactNode label (no
 * SegmentedControl API change). Both filters are pure derivations via
 * `useMemo` — they NEVER mutate the query cache. `awaiting_input` rows are
 * sorted to the top (the design's "等待输入会置顶") and carry the
 * alert-gradient needs-input row treatment.
 *
 * Each row's dot / row tint / status pill / ACTION all derive from the single
 * `presentTaskStatus` map (console-design-pixel-merge D3): awaiting input →
 * primary 处理输入, running → 接管会话, done → ghost 查看记录, failed → ghost
 * 查看错误, queued/pending → non-primary 等待 runner. EVERY action — the
 * queued/pending affordance included — is a REAL `/tasks/$taskId` link, never
 * `disabled`/`aria-disabled` (queued rows land on the pre-running placeholder).
 *
 * SSR-safe: pure render off props + local controlled view state; search/filter
 * state lives in `useState` and is only read in render (no window/clock access).
 *
 * Fidelity (design-revision dashboard.html): rows are the 3-column
 * `minmax(300px,1fr) minmax(150px,180px) 108px` grid at ≥821px; the
 * `mobile-inbox` rules apply via the established ≤820px convention
 * (`max-[821px]` / `min-[821px]` utilities only — Tailwind v4 max-* is the
 * STRICT `width < N`, so `max-[821px]` IS the inclusive ≤820px the design's
 * `max-width: 820px` means; no JS breakpoint): rows
 * regroup to the `main/action + context/action` area grid, the table head
 * hides, the filterbar stacks, and the tab group stretches full-width.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import type { TaskResponse as Task } from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill, type StatusPillVariant } from "@/components/status-pill";
import { SegmentedControl } from "@/components/segmented-control";
import { CountChip } from "@/components/count-chip";
import {
  isOpenTask,
  presentTaskStatus,
  type TaskActionEmphasis,
} from "./task-status";

/** The client-only status tab values (the design `data-task-filter` set). */
type QueueFilter = "all" | "needs-input" | "active" | "queued";

/** The inbox tabs (verbatim design copy); counts are attached at render. */
const INBOX_TABS: readonly { value: QueueFilter; name: string }[] = [
  { value: "all", name: "全部" },
  { value: "needs-input", name: "待处理" },
  { value: "active", name: "运行" },
  { value: "queued", name: "排队" },
];

/**
 * Per-variant dot color for the task-kicker marker (the design `.dot` family —
 * the dot tone tracks the pill variant so both derive from the one mapping).
 */
const DOT_CLASS: Record<StatusPillVariant, string> = {
  neutral: "bg-muted-foreground",
  green: "bg-success shadow-[0_0_0_3px_rgba(26,127,55,0.12)]",
  warn: "bg-warning shadow-[0_0_0_3px_rgba(154,103,0,0.14)]",
  blue: "bg-info shadow-[0_0_0_3px_rgba(10,114,239,0.12)]",
  danger: "bg-danger shadow-[0_0_0_3px_rgba(217,45,32,0.12)]",
  dark: "bg-foreground",
};

/**
 * Per-emphasis action classes (design `.btn` family). ALL of these style a
 * real Link — `waiting` is the design's non-primary queued affordance with the
 * disabled styling overturned (D3): muted ink, full ring, fully clickable.
 */
const ACTION_CLASS: Record<TaskActionEmphasis, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-[#2a2a2a]",
  neutral: "bg-card text-foreground shadow-ring hover:bg-secondary",
  ghost: "bg-transparent text-foreground hover:bg-secondary",
  waiting: "bg-card text-muted-foreground shadow-ring hover:bg-secondary",
};

/** A short, human-friendly id form (`task_<first-4-of-uuid>`), design-style. */
export function shortTaskId(id: string): string {
  const head = id.replace(/-/g, "").slice(0, 4);
  return `task_${head}`;
}

export interface QueuePanelProps {
  /** The live task list (from `tasksQuery`; the page owns the 5s poll). */
  tasks: readonly Task[];
  /** repoId → repo full display name (`owner/name`), built from `reposQuery`. */
  repoLookup: ReadonlyMap<string, string>;
}

/**
 * Sort tasks for the inbox: `awaiting_input` (needs-input) first, then the rest
 * in their incoming order. Stable — preserves the source order within each band.
 * PURE.
 */
export function sortQueue(tasks: readonly Task[]): Task[] {
  const needsInput: Task[] = [];
  const rest: Task[] = [];
  for (const task of tasks) {
    if (task.status === "awaiting_input") needsInput.push(task);
    else rest.push(task);
  }
  return [...needsInput, ...rest];
}

/**
 * Apply the client-only search + status-tab filter. Search matches the prompt,
 * the resolved repo full-name, the branch, the short id, and the status pill
 * label (case-insensitive). PURE over its inputs — it never touches the query
 * cache.
 */
export function filterQueue(
  tasks: readonly Task[],
  repoLookup: ReadonlyMap<string, string>,
  search: string,
  filter: QueueFilter,
): Task[] {
  const needle = search.trim().toLowerCase();
  return tasks.filter((task) => {
    const present = presentTaskStatus(task.status);
    if (filter !== "all" && present.state !== filter) return false;
    if (!needle) return true;
    const repoName = repoLookup.get(task.repoId) ?? "";
    const haystack = [
      task.prompt,
      repoName,
      task.branch ?? "",
      task.sandboxEnvironment?.name ?? "",
      shortTaskId(task.id),
      present.label,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** Live per-tab counts over the (unfiltered) task list. PURE. */
export function countQueueTabs(
  tasks: readonly Task[],
): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = {
    all: tasks.length,
    "needs-input": 0,
    active: 0,
    queued: 0,
  };
  for (const task of tasks) {
    const state = presentTaskStatus(task.status).state;
    if (state === "needs-input" || state === "active" || state === "queued") {
      counts[state] += 1;
    }
  }
  return counts;
}

/** A single inbox row (one task). The action is ALWAYS a real session link. */
function QueueRow({
  task,
  repoName,
}: {
  task: Task;
  repoName: string;
}) {
  const present = presentTaskStatus(task.status);
  const id = shortTaskId(task.id);
  const environmentName = task.sandboxEnvironment?.name ?? null;

  return (
    <article
      data-task-row
      data-task-state={present.state}
      className={cn(
        "border-b border-border last:border-b-0",
        "transition-colors",
        present.state === "needs-input"
          ? // The alert-gradient needs-input treatment (desktop; the mobile
            // inbox flattens it back to the card surface, per the design).
            "min-[821px]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--warning)_5%,white),var(--card)_36%)]"
          : "min-[821px]:hover:bg-[#fbfbfb]",
      )}
    >
      <div
        className={cn(
          // mobile-inbox area grid: main/action on top, context/action below.
          "grid items-start gap-x-2.5 gap-y-[5px] px-3.5 py-3",
          "grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'main_action''context_action']",
          // desktop: the 3-column row grid.
          "min-[821px]:min-h-[60px] min-[821px]:grid-cols-[minmax(300px,1fr)_minmax(150px,180px)_108px]",
          "min-[821px]:[grid-template-areas:'main_context_action']",
          "min-[821px]:items-center min-[821px]:gap-3 min-[821px]:px-4 min-[821px]:py-[7px]",
        )}
      >
        {/* Task / repo */}
        <div className="min-w-0 [grid-area:main]">
          <div className="mb-[5px] flex flex-wrap items-center gap-1.5 min-[821px]:mb-[3px] min-[821px]:gap-[7px]">
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[present.variant])}
            />
            <span className="text-[13px] leading-[1.1] font-semibold text-foreground">
              {id}
            </span>
            <StatusPill
              variant={present.variant}
              className="min-h-[18px] px-1.5 py-0 text-[9px] min-[821px]:min-h-5 min-[821px]:px-[7px] min-[821px]:text-[10px]"
            >
              {present.label}
            </StatusPill>
          </div>
          <h4 className="line-clamp-2 text-[13px] leading-[1.32] font-semibold [text-wrap:pretty] text-foreground min-[821px]:line-clamp-none min-[821px]:leading-[1.25]">
            {task.prompt}
          </h4>
          <p
            className="mt-[5px] min-w-0 text-[11px] leading-[1.25] text-muted-foreground min-[821px]:mt-1"
            aria-label={`GitHub 仓库 ${repoName}`}
          >
            <strong className="block truncate font-mono font-medium">{repoName}</strong>
          </p>
        </div>

        {/* Execution context (阶段 / 分支) */}
        <div
          className={cn(
            "[grid-area:context] min-w-0 text-muted-foreground",
            "flex flex-wrap items-center gap-x-2 gap-y-[5px]",
            "min-[821px]:grid min-[821px]:gap-1",
          )}
        >
          <strong className="text-[11px] leading-[1.25] font-semibold text-muted-foreground after:content-['_·'] after:font-normal after:text-muted-2 min-[821px]:truncate min-[821px]:text-xs min-[821px]:leading-[1.22] min-[821px]:text-foreground min-[821px]:after:content-none">
            {present.phase}
          </strong>
          <span className="font-mono text-[11px] leading-[1.25] min-[821px]:truncate min-[821px]:leading-[1.22]">
            {task.branch ?? "—"}
          </span>
          {environmentName ? (
            <span className="font-mono text-[11px] leading-[1.25] min-[821px]:truncate min-[821px]:leading-[1.22]">
              env:{environmentName}
            </span>
          ) : null}
        </div>

        {/* Action — derived solely from the status mapping; always a real link */}
        <div className="[grid-area:action] grid justify-items-end self-start min-[821px]:self-center">
          <Link
            to="/tasks/$taskId"
            params={{ taskId: task.id }}
            className={cn(
              "inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-md px-[9px] text-[11px] font-medium transition-colors",
              "min-[821px]:w-full min-[821px]:min-h-7 min-[821px]:px-2.5 min-[821px]:text-xs",
              ACTION_CLASS[present.action.emphasis],
            )}
          >
            {present.action.label}
          </Link>
        </div>
      </div>
    </article>
  );
}

/** The full inbox panel: head + toolbar + table head + the live row list. */
export function QueuePanel({ tasks, repoLookup }: QueuePanelProps) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<QueueFilter>("all");

  const openCount = React.useMemo(
    () => tasks.filter((t) => isOpenTask(t.status)).length,
    [tasks],
  );

  // Live per-tab counts (over the full list — the tabs report status groups,
  // not the post-search view). Pure `useMemo` derivation, never cached.
  const counts = React.useMemo(() => countQueueTabs(tasks), [tasks]);

  const visible = React.useMemo(() => {
    const sorted = sortQueue(tasks);
    return filterQueue(sorted, repoLookup, search, filter);
  }, [tasks, repoLookup, search, filter]);

  // Tab options with the live CountChip riding the existing ReactNode label —
  // no SegmentedControl API change (console-design-pixel-merge 4.3).
  const tabOptions = React.useMemo(
    () =>
      INBOX_TABS.map(({ value, name }) => ({
        value,
        label: (
          <>
            <span>{name}</span>
            <CountChip
              bare
              className="ml-1.5 min-h-0 px-0 text-[11px] leading-none font-medium text-[color-mix(in_oklch,currentColor_64%,transparent)]"
            >
              {counts[value]}
            </CountChip>
          </>
        ),
      })),
    [counts],
  );

  return (
    <article className="min-w-0 overflow-hidden rounded-lg bg-card shadow-card">
      {/* Head */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 pt-[13px] pb-[9px] min-[821px]:items-start min-[821px]:px-[18px] min-[821px]:pt-4 min-[821px]:pb-3">
        <div>
          <h3 className="text-base font-semibold tracking-[-0.32px] text-foreground min-[821px]:text-[15px] min-[821px]:tracking-normal">
            任务队列与接管
          </h3>
          <p className="mt-1 hidden text-[13px] leading-[1.45] text-muted-foreground min-[821px]:block">
            等待输入会置顶；排队任务只有接入 runner 后才能进入会话。
          </p>
        </div>
        <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground min-[821px]:text-xs">
          {openCount} open
        </span>
      </div>

      {/* Toolbar: client-side search + status tabs with live counts */}
      <div className="grid items-center gap-2 border-b border-border bg-card px-3.5 pt-2.5 pb-3 min-[821px]:grid-cols-[minmax(260px,1fr)_auto] min-[821px]:gap-3 min-[821px]:px-[18px] min-[821px]:py-3">
        <label className="grid min-h-10 min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)] min-[821px]:min-h-9 min-[821px]:grid-cols-[32px_minmax(0,1fr)]">
          <span aria-hidden="true" className="grid place-items-center font-mono text-[15px] leading-none text-muted-foreground">
            ⌕
          </span>
          <input
            type="search"
            data-task-search
            aria-label="筛选任务"
            placeholder="搜索任务、仓库或分支"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-10 w-full border-0 bg-transparent pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground min-[821px]:min-h-9 min-[821px]:text-sm"
          />
        </label>
        <div className="flex min-w-0 items-center justify-end max-[821px]:w-full">
          <SegmentedControl
            compact
            ariaLabel="任务状态"
            options={tabOptions}
            value={filter}
            onValueChange={setFilter}
            className="max-[821px]:w-full max-[821px]:[&>button]:min-w-0 max-[821px]:[&>button]:flex-1"
          />
        </div>
      </div>

      {/* Table head (desktop only) */}
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(300px,1fr)_minmax(150px,180px)_108px] gap-x-3 border-b border-border bg-[#fafafa] px-4 py-2 font-mono text-[11px] font-medium text-muted-foreground max-[821px]:hidden"
      >
        <span>任务 / GitHub 仓库</span>
        <span>阶段 / 分支</span>
        <span className="justify-self-end text-right">操作</span>
      </div>

      {/* Rows */}
      <div>
        {visible.length === 0 ? (
          <p className="px-[18px] py-8 text-center text-[13px] text-muted-foreground">
            没有匹配的任务。
          </p>
        ) : (
          visible.map((task) => (
            <QueueRow
              key={task.id}
              task={task}
              repoName={repoLookup.get(task.repoId) ?? task.repoId}
            />
          ))
        )}
      </div>
    </article>
  );
}
