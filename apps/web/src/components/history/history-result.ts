/**
 * History result-pill presentation (rebuild-console-tanstack-start; Track 15).
 *
 * The SINGLE place mapping a contract {@link TaskStatus} to its 结果 column
 * presentation on the `/history` page. This is deliberately DISTINCT from the
 * dashboard's `presentTaskStatus` (which labels the live queue 执行中/已完成/失败):
 * the history "最近任务" table uses the prototype `history.html` result labels —
 * 运行中 / 已合并 / 等待输入 / 已停止 / 排队中 / 已归档 — so the audit view reads
 * as a settled record of outcomes rather than a live work queue.
 *
 * Exhaustive over the contract `TaskStatus` union so a future status added to
 * the contract fails the build here rather than rendering an unlabeled pill.
 *
 * Pure + deterministic: no window/clock/random — SSR-safe.
 */
import type { TaskStatus } from "@cap/contracts";

import type { StatusPillVariant } from "@/components/status-pill";

/** The resolved 结果 presentation for one task status on the history table. */
export interface HistoryResultPresentation {
  /** The localized result label (verbatim prototype copy). */
  label: string;
  /** The shared StatusPill tone. */
  variant: StatusPillVariant;
}

/**
 * Exhaustive status → 结果 presentation map (history-table labels).
 *
 * Prototype rows: running→运行中 (green), completed→已合并 (green),
 * awaiting_input→等待输入 (warn), failed→已停止 (warn — the prototype renders the
 * stopped row with the `warn` pill), queued/pending→排队中/已归档 (neutral).
 * `agent_failed_to_start` is a terminal failure → 已停止 (danger). `cancelled` is
 * the operator-initiated stop → 已取消 (neutral — a deliberate stop, not a
 * failure).
 */
export const HISTORY_RESULT_PRESENTATION: Record<
  TaskStatus,
  HistoryResultPresentation
> = {
  running: { label: "运行中", variant: "green" },
  completed: { label: "已合并", variant: "green" },
  awaiting_input: { label: "等待输入", variant: "warn" },
  failed: { label: "已停止", variant: "warn" },
  cancelled: { label: "已取消", variant: "neutral" },
  agent_failed_to_start: { label: "已停止", variant: "danger" },
  queued: { label: "排队中", variant: "neutral" },
  pending: { label: "已归档", variant: "neutral" },
};

/** Resolve a status to its history-table 结果 presentation (total over the union). */
export function presentHistoryResult(
  status: TaskStatus,
): HistoryResultPresentation {
  return HISTORY_RESULT_PRESENTATION[status];
}
