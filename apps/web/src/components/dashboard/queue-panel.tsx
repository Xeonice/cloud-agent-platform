/**
 * `QueuePanel` — the dashboard task queue + takeover panel (Track 16, task 16.3).
 *
 * The left column of the workspace. Renders the live task list from
 * `tasksQuery()` (passed in by the page, which owns the query so the 5s poll +
 * SSR hydration stay in one place) and layers two CLIENT-ONLY view filters over
 * it: a free-text search (`data-task-search`) and a status `SegmentedControl`
 * (全部 / 等待输入 / 排队中). Both are pure derivations via `useMemo` — they NEVER
 * mutate the query cache, and the visible-count `CountChip` updates live as they
 * narrow the list. `awaiting_input` rows are sorted to the top (the prototype's
 * "等待输入会置顶").
 *
 * Each row's rail dot / row tint / status pill all derive from the single
 * `presentTaskStatus` map; the repo full-name is resolved from the `repoLookup`
 * the page builds off `reposQuery`. The action is a `/tasks/$taskId` Link when the
 * task is connectable, else an `aria-disabled` "等待接入" placeholder (queued /
 * pending are not yet admitted to a runner).
 *
 * SSR-safe: pure render off props + local controlled view state; search/filter
 * state lives in `useState` and is only read in render (no window/clock access).
 *
 * Fidelity (FINAL `.console-body` + audit-refinement cascade): panel padding 0 +
 * overflow hidden; head 16/18/12 + bottom hairline; filterbar two-column
 * (search | actions) 12/18 + bottom hairline; the rail is hidden and the row
 * gets a `::before`-style colored dot on the title row (green/amber/accent by
 * state); rows are single-column, 15/18/16 padding, bottom hairlines.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import type { Task } from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { SegmentedControl } from "@/components/segmented-control";
import { CountChip } from "@/components/count-chip";
import {
  isOpenTask,
  presentTaskStatus,
  type QueueRowState,
} from "./task-status";

/** The client-only status filter values (the prototype `data-task-filter` set). */
type QueueFilter = "all" | "needs-input" | "queued";

const FILTER_OPTIONS: readonly { value: QueueFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "needs-input", label: "等待输入" },
  { value: "queued", label: "排队中" },
];

/** Per-state dot color for the title-row marker (the audit-refinement `::before`). */
const RAIL_DOT_CLASS: Record<QueueRowState, string> = {
  active:
    "bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_14%,white)]",
  "needs-input":
    "bg-warning shadow-[0_0_0_3px_color-mix(in_oklch,var(--warning)_18%,white)]",
  queued:
    "bg-accent-foreground shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent-foreground)_14%,white)]",
  done: "bg-muted-foreground shadow-[0_0_0_3px_rgba(0,0,0,0.06)]",
};

/**
 * Per-state row tint. In the FINAL cascade every `.console-body .queue-item`
 * (incl. .active/.needs-input/.queued) is white at rest (audit-refinement.css)
 * with only a `#fbfbfb` hover — the per-state colored cue comes solely from the
 * title-row dot (RAIL_DOT_CLASS), so all four states share the same resting bg.
 */
const ROW_TINT_CLASS: Record<QueueRowState, string> = {
  active: "hover:bg-[#fbfbfb]",
  "needs-input": "hover:bg-[#fbfbfb]",
  queued: "hover:bg-[#fbfbfb]",
  done: "hover:bg-[#fbfbfb]",
};

/** A short, human-friendly id form (`task_<first-4-of-uuid>`), prototype-style. */
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
 * Sort tasks for the queue: `awaiting_input` (needs-input) first, then the rest
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
 * Apply the client-only search + status filter. Search matches the prompt, the
 * resolved repo full-name, the branch, and the short id (case-insensitive). PURE
 * over its inputs — it never touches the query cache.
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
    if (filter === "needs-input" && present.state !== "needs-input") return false;
    if (filter === "queued" && present.state !== "queued") return false;
    if (!needle) return true;
    const repoName = repoLookup.get(task.repoId) ?? "";
    const haystack = [
      task.prompt,
      repoName,
      task.branch ?? "",
      shortTaskId(task.id),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** A single queue row (one task). */
function QueueRow({
  task,
  repoName,
}: {
  task: Task;
  repoName: string;
}) {
  const present = presentTaskStatus(task.status);
  const id = shortTaskId(task.id);

  return (
    <article
      data-task-row
      data-task-state={present.state}
      className={cn(
        "border-b border-border last:border-b-0",
        "transition-colors",
        ROW_TINT_CLASS[present.state],
      )}
    >
      <div className="grid items-center gap-x-[18px] px-[18px] pt-[15px] pb-4 min-[821px]:grid-cols-[minmax(320px,1.7fr)_minmax(190px,0.82fr)_116px]">
        {/* Task / repo */}
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-[7px]">
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", RAIL_DOT_CLASS[present.state])}
            />
            <span className="font-mono text-xs text-ink">{id}</span>
            <StatusPill variant={present.variant}>{present.label}</StatusPill>
          </div>
          <h4 className="text-[15px] leading-[1.3] font-semibold text-foreground">
            {task.prompt}
          </h4>
          <div
            className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
            aria-label={`GitHub 仓库 ${repoName}`}
          >
            <span>仓库</span>
            <strong className="truncate font-mono font-medium text-foreground">
              {repoName}
            </strong>
          </div>
        </div>

        {/* Execution context */}
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span className="truncate">
            <span className="text-muted-foreground">阶段</span>{" "}
            <span className="text-foreground">{present.phase}</span>
          </span>
          <span className="truncate">
            <span className="text-muted-foreground">分支</span>{" "}
            <span className="font-mono text-foreground">{task.branch ?? "—"}</span>
          </span>
        </div>

        {/* Action */}
        <div className="min-[821px]:justify-self-end">
          {present.connectable ? (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: task.id }}
              className={cn(
                "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md px-3 text-[13px] font-medium",
                present.state === "needs-input"
                  ? "bg-card text-foreground shadow-ring hover:bg-secondary"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              进入会话
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex h-8 cursor-not-allowed items-center justify-center whitespace-nowrap rounded-md bg-card px-3 text-[13px] font-medium text-foreground opacity-[0.58] shadow-ring"
            >
              等待接入
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/** The full queue panel: head + filterbar + table head + the live row list. */
export function QueuePanel({ tasks, repoLookup }: QueuePanelProps) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<QueueFilter>("all");

  const openCount = React.useMemo(
    () => tasks.filter((t) => isOpenTask(t.status)).length,
    [tasks],
  );

  const visible = React.useMemo(() => {
    const sorted = sortQueue(tasks);
    return filterQueue(sorted, repoLookup, search, filter);
  }, [tasks, repoLookup, search, filter]);

  return (
    <article className="min-w-0 overflow-hidden rounded-lg bg-card shadow-card">
      {/* Head */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-[18px] pt-4 pb-3">
        <div>
          <h3 className="text-[15px] font-semibold text-foreground">任务队列与接管</h3>
          <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">
            等待输入会置顶；排队任务只有接入 runner 后才能进入会话。
          </p>
        </div>
        <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
          {openCount} open
        </span>
      </div>

      {/* Filterbar */}
      <div className="grid items-center gap-3 border-b border-border bg-card px-[18px] py-3 min-[821px]:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <label className="grid min-h-9 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]">
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
            className="min-h-9 w-full border-0 bg-transparent pr-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="flex min-w-0 items-center justify-end gap-2.5">
          <SegmentedControl
            compact
            ariaLabel="任务状态"
            options={FILTER_OPTIONS}
            value={filter}
            onValueChange={setFilter}
          />
          <CountChip bare data-task-visible-count>
            {visible.length} 个任务
          </CountChip>
        </div>
      </div>

      {/* Table head */}
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(320px,1.7fr)_minmax(190px,0.82fr)_116px] gap-x-[18px] border-b border-border bg-[#fafafa] px-[18px] py-2 font-mono text-[11px] font-medium text-muted-foreground max-[820px]:hidden"
      >
        <span>任务 / GitHub 仓库</span>
        <span>执行上下文</span>
        <span>操作</span>
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
