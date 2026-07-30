/**
 * History result-pill presentation (rebuild-console-tanstack-start; relabeled to
 * the finalized baseline by pixel-restore-console-to-od Track 9).
 *
 * The SINGLE place mapping a contract {@link TaskStatus} to its 运行记录 row
 * presentation on the `/history` page. DISTINCT from the dashboard's
 * `presentTaskStatus`: the history list reads as a settled record of outcomes,
 * with the finalized `history.html` labels — 运行中 / 等待输入 / 排队中 / 已完成 /
 * 失败 / 已停止 / 启动失败 — and a `filter` bucket driving the status segment.
 *
 * Exhaustive over the contract `TaskStatus` union so a future status added to the
 * contract fails the build here. Pure + deterministic — SSR-safe.
 */
import type { TaskStatus } from "@cap-console/contracts";

import type { StatusPillVariant } from "@/components/status-pill";

/** The status-segment buckets (the baseline `data-filter-target` set + cancelled). */
export type HistoryFilter =
  | "running"
  | "awaiting"
  | "queued"
  | "completed"
  | "failed"
  | "cancelled";

/** The resolved 结果 presentation for one task status on the history list. */
export interface HistoryResultPresentation {
  /** The localized result label (verbatim baseline copy). */
  label: string;
  /** The shared StatusPill tone. */
  variant: StatusPillVariant;
  /** The status-segment bucket this row belongs to. */
  filter: HistoryFilter;
}

/**
 * Exhaustive status → 运行记录 presentation map (finalized baseline labels):
 * running→运行中 (green), awaiting_input→等待输入 (warn), queued/pending→排队中
 * (blue), completed→已完成 (neutral), failed→失败 (danger), cancelled→已停止
 * (dark — operator stop), agent_failed_to_start→启动失败 (danger).
 */
export const HISTORY_RESULT_PRESENTATION: Record<
  TaskStatus,
  HistoryResultPresentation
> = {
  running: { label: "运行中", variant: "green", filter: "running" },
  awaiting_input: { label: "等待输入", variant: "warn", filter: "awaiting" },
  queued: { label: "排队中", variant: "blue", filter: "queued" },
  pending: { label: "排队中", variant: "blue", filter: "queued" },
  completed: { label: "已完成", variant: "neutral", filter: "completed" },
  failed: { label: "失败", variant: "danger", filter: "failed" },
  cancelled: { label: "已停止", variant: "dark", filter: "cancelled" },
  agent_failed_to_start: {
    label: "启动失败",
    variant: "danger",
    filter: "failed",
  },
};

/** Resolve a status to its history-list 结果 presentation (total over the union). */
export function presentHistoryResult(
  status: TaskStatus,
): HistoryResultPresentation {
  return HISTORY_RESULT_PRESENTATION[status];
}
