/**
 * Task-status presentation map (rebuild-console-tanstack-start Track 16;
 * evolved by console-design-pixel-merge D3).
 *
 * The SINGLE place that maps a contract {@link TaskStatus} to its design-revision
 * presentation: the inbox rail/tint `state`, the localized pill label (verbatim
 * design copy), the {@link StatusPillVariant}, the 阶段 (phase) caption, and the
 * row's ACTION DESCRIPTOR ({@link TaskStatusAction}) — label + emphasis for the
 * status-differentiated inbox action. Keeping this exhaustive over the
 * `TaskStatus` union means a future status added to the contract fails the build
 * here rather than rendering an unlabeled row or an action-less row.
 *
 * D3 (overturns the prior `connectable: false`): EVERY action — including the
 * queued/pending 等待 runner affordance — is a REAL link into `/tasks/$taskId`.
 * No status maps to a `disabled`/`aria-disabled` placeholder; queued/pending
 * land on the task's pre-running placeholder.
 *
 * Pure + deterministic: no `window`, no clock, no random — SSR-safe.
 */
import type { TaskStatus } from "@cap/contracts";

import type { StatusPillVariant } from "@/components/status-pill";

/**
 * The design `data-state` rail/tint key. `active` = green running rail;
 * `needs-input` = warn rail + the alert-gradient row treatment (sorted to the
 * top); `queued` = blue/accent rail; `done` = a settled terminal row.
 */
export type QueueRowState = "active" | "needs-input" | "queued" | "done";

/**
 * Visual emphasis of a row action. All four kinds are rendered as REAL links —
 * `waiting` is the queued/pending 等待 runner affordance: non-primary STYLING
 * only, never `disabled`/`aria-disabled` (console-design-pixel-merge D3).
 */
export type TaskActionEmphasis = "primary" | "neutral" | "ghost" | "waiting";

/** The status-differentiated row action (one navigable link per status). */
export interface TaskStatusAction {
  /**
   * Verbatim design-revision action copy
   * (处理输入 / 接管会话 / 查看记录 / 查看错误 / 等待 runner).
   */
  label: string;
  /** Visual emphasis only — never a disabled affordance. */
  emphasis: TaskActionEmphasis;
}

/** The resolved presentation for one task status. */
export interface TaskStatusPresentation {
  /** The rail/tint state driving the row's `data-task-state`. */
  state: QueueRowState;
  /** The localized pill text (verbatim design copy). */
  label: string;
  /** The shared StatusPill tone. */
  variant: StatusPillVariant;
  /** The 阶段 (phase) caption shown in the row context column. */
  phase: string;
  /**
   * The row's action descriptor. Always a REAL `/tasks/$taskId` link — the
   * queued/pending `waiting` emphasis is non-primary styling, not a disabled
   * state (a queued task's link lands on the pre-running placeholder).
   */
  action: TaskStatusAction;
}

/**
 * Exhaustive status → presentation map. The contract `TaskStatus` enum has eight
 * members (including `cancelled`, the operator-initiated stop terminal); each is
 * handled here — `Record<TaskStatus, …>` makes a missing member a compile error.
 * `awaiting_input` is the only `needs-input` state and is sorted to the top of
 * the inbox by the panel.
 */
export const TASK_STATUS_PRESENTATION: Record<TaskStatus, TaskStatusPresentation> = {
  running: {
    state: "active",
    label: "运行中",
    variant: "green",
    phase: "编码中",
    action: { label: "接管会话", emphasis: "neutral" },
  },
  awaiting_input: {
    state: "needs-input",
    label: "等待输入",
    variant: "warn",
    phase: "等待输入",
    action: { label: "处理输入", emphasis: "primary" },
  },
  queued: {
    state: "queued",
    label: "等待接入",
    variant: "blue",
    phase: "排队",
    action: { label: "等待 runner", emphasis: "waiting" },
  },
  pending: {
    state: "queued",
    label: "待处理",
    variant: "neutral",
    phase: "待处理",
    action: { label: "等待 runner", emphasis: "waiting" },
  },
  completed: {
    state: "done",
    label: "已完成",
    variant: "neutral",
    phase: "完成",
    action: { label: "查看记录", emphasis: "ghost" },
  },
  failed: {
    state: "done",
    label: "失败",
    variant: "danger",
    phase: "失败",
    action: { label: "查看错误", emphasis: "ghost" },
  },
  cancelled: {
    state: "done",
    label: "已取消",
    variant: "neutral",
    phase: "已取消",
    action: { label: "查看记录", emphasis: "ghost" },
  },
  agent_failed_to_start: {
    state: "done",
    label: "启动失败",
    variant: "danger",
    phase: "启动失败",
    action: { label: "查看错误", emphasis: "ghost" },
  },
};

/** Resolve a status to its presentation (total over the contract union). */
export function presentTaskStatus(status: TaskStatus): TaskStatusPresentation {
  return TASK_STATUS_PRESENTATION[status];
}

/** The non-terminal statuses, used for the panel's "N open" tally. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "queued",
  "running",
  "awaiting_input",
];

/** Whether a task is still open (non-terminal). */
export function isOpenTask(status: TaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}
