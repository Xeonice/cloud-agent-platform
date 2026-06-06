/**
 * Task-status presentation map (rebuild-console-tanstack-start; Track 16).
 *
 * The SINGLE place that maps a contract {@link TaskStatus} to its prototype
 * presentation: the queue rail/tint `state`, the localized pill label (verbatim
 * full-width copy), the {@link StatusPillVariant}, the 阶段 (phase) caption, and
 * whether the row is connectable (can navigate into a session) vs. still waiting
 * to be admitted. Keeping this exhaustive over the `TaskStatus` union means a
 * future status added to the contract fails the build here rather than rendering
 * an unlabeled row.
 *
 * Pure + deterministic: no `window`, no clock, no random — SSR-safe.
 */
import type { TaskStatus } from "@cap/contracts";

import type { StatusPillVariant } from "@/components/status-pill";

/**
 * The prototype `data-task-state` rail/tint key. `active` = green running rail;
 * `needs-input` = warn rail (sorted to the top); `queued` = blue/accent rail;
 * `done` = a settled terminal row.
 */
export type QueueRowState = "active" | "needs-input" | "queued" | "done";

/** The resolved presentation for one task status. */
export interface TaskStatusPresentation {
  /** The rail/tint state driving the row's `data-task-state`. */
  state: QueueRowState;
  /** The localized pill text (verbatim prototype copy). */
  label: string;
  /** The shared StatusPill tone. */
  variant: StatusPillVariant;
  /** The 阶段 (phase) caption shown in the row meta. */
  phase: string;
  /**
   * Whether the operator can enter the live session from this row. `false` for
   * `pending`/`queued` (not yet admitted to a runner — the prototype renders the
   * action `aria-disabled` "等待接入").
   */
  connectable: boolean;
}

/**
 * Exhaustive status → presentation map. Note the contract `TaskStatus` enum has
 * seven members (no `cancelled`); each is handled here. `awaiting_input` is the
 * only `needs-input` state and is sorted to the top of the queue by the panel.
 */
export const TASK_STATUS_PRESENTATION: Record<TaskStatus, TaskStatusPresentation> = {
  running: {
    state: "active",
    label: "执行中",
    variant: "green",
    phase: "编码中",
    connectable: true,
  },
  awaiting_input: {
    state: "needs-input",
    label: "等待输入",
    variant: "warn",
    phase: "等待确认",
    connectable: true,
  },
  queued: {
    state: "queued",
    label: "排队中",
    variant: "neutral",
    phase: "排队",
    connectable: false,
  },
  pending: {
    state: "queued",
    label: "待处理",
    variant: "neutral",
    phase: "待处理",
    connectable: false,
  },
  completed: {
    state: "done",
    label: "已完成",
    variant: "green",
    phase: "已完成",
    connectable: true,
  },
  failed: {
    state: "done",
    label: "失败",
    variant: "danger",
    phase: "已失败",
    connectable: true,
  },
  agent_failed_to_start: {
    state: "done",
    label: "启动失败",
    variant: "danger",
    phase: "启动失败",
    connectable: true,
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
