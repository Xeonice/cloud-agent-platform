/**
 * `RecentTasksTable` — the history page LEFT panel "最近任务" (Track 15, task 15.2).
 *
 * A read-only table of the live task list (`tasksQuery`), most-recent-first:
 * columns 任务 / 仓库 / 结果 / 耗时 / 会话记录. Each row shows the short task id
 * (mono), the resolved repo name (from the page's `repoLookup` off `reposQuery`),
 * the 结果 `StatusPill` (via `presentHistoryResult`), the 耗时 elapsed span (via
 * `formatElapsed` against the page-owned `now`), and a 会话记录 deep-link into
 * `/tasks/$taskId` ("打开" for the still-running head row, "查看" otherwise).
 *
 * The rows handed in are ALREADY filtered by the page's single `useClientFilter`
 * instance (text accessors only — the level segment does not constrain the
 * table), so this component is a pure presenter and owns no filter state.
 *
 * SSR-safe: pure render off props. `now` is `undefined` on the server / before
 * mount (so 耗时 shows "—"); the page fills it in via a `useEffect`-set state,
 * keeping the server render and first client render identical.
 *
 * Fidelity (FINAL `.console-body` cascade): `.panel` white card + `.panel-head`
 * `#f6f8fa` hairline strip; `.table-wrap table` full-width, th = left-aligned
 * mono-ish muted header on a hairline, td = 12/14 cells with bottom hairlines;
 * the id + 耗时 + link cells are mono.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import type { Task } from "@cap/contracts";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { presentHistoryResult } from "./history-result";
import { formatElapsed } from "./format";

export interface RecentTasksTableProps {
  /** The (already text-filtered) task rows, most-recent-first. */
  tasks: readonly Task[];
  /** repoId → repo display name, built by the page from `reposQuery`. */
  repoLookup: ReadonlyMap<string, string>;
  /** Current wall-clock ms for 耗时; `undefined` pre-mount → "—" (SSR-safe). */
  now: number | undefined;
}

/** A single task row in the 最近任务 table. */
function TaskRow({
  task,
  repoName,
  now,
  isHead,
}: {
  task: Task;
  repoName: string;
  now: number | undefined;
  isHead: boolean;
}) {
  const result = presentHistoryResult(task.status);
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-2.5 pr-3 align-top font-mono text-[13px] text-ink">
        {shortTaskId(task.id)}
      </td>
      <td className="py-2.5 pr-3 align-top text-[13px] text-foreground">{repoName}</td>
      <td className="py-2.5 pr-3 align-top">
        <StatusPill variant={result.variant}>{result.label}</StatusPill>
      </td>
      <td className="py-2.5 pr-3 align-top font-mono text-[13px] text-ink tabular-nums">
        {formatElapsed(task.createdAt, now)}
      </td>
      <td className="py-2.5 align-top">
        <Link
          to="/tasks/$taskId"
          params={{ taskId: task.id }}
          className="font-mono text-[13px] text-info hover:underline"
        >
          {isHead ? "打开" : "查看"}
        </Link>
      </td>
    </tr>
  );
}

/** The LEFT panel: head + the scrollable 最近任务 table. */
export function RecentTasksTable({
  tasks,
  repoLookup,
  now,
}: RecentTasksTableProps) {
  return (
    <Panel>
      <PanelHead right={<span className="font-mono text-xs text-muted-foreground">最新在前</span>}>
        <h3 className="text-[15px] font-semibold text-foreground">最近任务</h3>
      </PanelHead>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-3 font-mono text-[11px] font-medium text-muted-foreground">
                任务
              </th>
              <th className="py-2 pr-3 font-mono text-[11px] font-medium text-muted-foreground">
                仓库
              </th>
              <th className="py-2 pr-3 font-mono text-[11px] font-medium text-muted-foreground">
                结果
              </th>
              <th className="py-2 pr-3 font-mono text-[11px] font-medium text-muted-foreground">
                耗时
              </th>
              <th className="py-2 font-mono text-[11px] font-medium text-muted-foreground">
                会话记录
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="py-8 text-center text-[13px] text-muted-foreground"
                >
                  没有匹配的任务。
                </td>
              </tr>
            ) : (
              tasks.map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  repoName={repoLookup.get(task.repoId) ?? task.repoId}
                  now={now}
                  isHead={index === 0}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
