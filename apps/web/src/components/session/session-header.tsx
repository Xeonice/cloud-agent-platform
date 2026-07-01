/**
 * `SessionHeader` — the cockpit three-segment session header
 * (session-cockpit-redesign).
 *
 * Replaces the pixel-merge toolbar + screen-header band with, in order:
 *   1. a `← 任务控制台` back-link crumb (Vercel-faithful; the sidebar gives
 *      desktop nav, this is the explicit back affordance + mobile-essential);
 *   2. a TASK-STATUS H1 — the short task id + a {@link SessionStatusBadge}
 *      (dot+text, never color-alone);
 *   3. the task PROMPT as a single-line truncated, click-to-expand line
 *      (its "commit-message" slot);
 *   4. a non-interactive TAG RAIL (分支 / agent runtime / sandbox provider / 守护栏)
 *      of white-bg ring chips. The agent chip reflects the task's persisted
 *      runtime (Codex / Claude Code); there is no platform-arch chip.
 *
 * The SINGLE header action is 停止 (two-step confirm). The old 返回任务 /
 * 复制会话记录 / 暂停输出 buttons are gone — copy/pause fold into the terminal ⋯
 * menu; connection status moved to the terminal-head readout.
 *
 * SSR-safe: pure render off props; the prompt-expand toggle is local UI state.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import { SessionStatusBadge, SessionTag } from "@/components/status-pill";
import type { SessionTaskState } from "@/components/status-pill";

export interface SessionHeaderProps {
  /** The short task id rendered as the H1 (e.g. `task_27c9`). */
  shortId: string;
  /** Task lifecycle state for the H1 status badge (gate = write-gate pending). */
  taskState: SessionTaskState;
  /** The task prompt (single-line truncated, click to expand). */
  prompt: string;
  /** Branch tag (mono). */
  branch: string;
  /** Agent tag (e.g. `Codex`). */
  agent: string;
  /** Sandbox provider tag (e.g. `AIO Sandbox` or `BoxLite Sandbox`). */
  sandboxProviderLabel: string;
  /** Guardrail readout, computed honestly from the task (e.g. `默认守护栏`). */
  guardrail: string;
  /**
   * Whether the manual 停止 control is offered — true only for an ACTIVE
   * (non-terminal) task. Hidden/inert for a completed/failed/cancelled task.
   */
  canStop?: boolean;
  /** Whether the stop request is in flight (disables the confirm button). */
  stopPending?: boolean;
  /** Confirmed-stop handler (POSTs `/tasks/:taskId/stop`). */
  onStop?: () => void;
}

export function SessionHeader({
  shortId,
  taskState,
  prompt,
  branch,
  agent,
  sandboxProviderLabel,
  guardrail,
  canStop = false,
  stopPending = false,
  onStop,
}: SessionHeaderProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  // Two-step confirm (no blocking window.confirm): first click arms, second
  // confirms. Reset whenever the control stops being offered (task settled).
  const [confirmingStop, setConfirmingStop] = React.useState(false);
  React.useEffect(() => {
    if (!canStop) setConfirmingStop(false);
  }, [canStop]);

  return (
    <section
      aria-label="会话头部"
      className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 border-b border-border pb-3.5"
    >
      <div className="grid min-w-0 gap-2">
        <Link
          to="/dashboard"
          aria-label="返回任务控制台"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-[13px] flex-none"
          >
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
          任务控制台
        </Link>

        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="min-w-0 text-2xl font-semibold leading-tight tracking-[-0.9px] text-foreground">
            {shortId}
          </h1>
          <SessionStatusBadge state={taskState} />
        </div>

        <button
          type="button"
          data-prompt-toggle
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收起任务目标" : "展开任务目标"}
          className="block w-full max-w-[680px] text-left text-[13px] leading-[1.6] text-[color-mix(in_oklch,var(--muted)_52%,var(--foreground))]"
        >
          <span
            className={
              expanded
                ? "block whitespace-pre-wrap"
                : "line-clamp-2 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
            }
          >
            {prompt}
          </span>
          <span className="mt-[5px] inline-block text-xs font-medium text-info">
            {expanded ? "收起" : "展开"}
          </span>
        </button>

        <div aria-label="会话元数据" className="flex flex-wrap gap-1.5">
          <SessionTag mono>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-3 flex-none text-muted-foreground"
            >
              <line x1="6" x2="6" y1="3" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {branch}
          </SessionTag>
          <SessionTag>{agent}</SessionTag>
          <SessionTag>{sandboxProviderLabel}</SessionTag>
          <SessionTag>{guardrail}</SessionTag>
        </div>
      </div>

      {canStop && onStop ? (
        <div className="flex flex-none items-center gap-2 pt-0.5">
          {confirmingStop ? (
            <span className="inline-flex items-center gap-1.5">
              <button
                type="button"
                data-confirm-stop
                disabled={stopPending}
                onClick={() => {
                  setConfirmingStop(false);
                  onStop();
                }}
                className="inline-flex h-8 items-center justify-center rounded-md bg-danger px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {stopPending ? "停止中…" : "确认停止"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingStop(false)}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-stop-task
              onClick={() => setConfirmingStop(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-card px-3 text-xs font-medium text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--danger)_22%,transparent)] transition-colors hover:bg-danger-soft"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                className="size-2.5"
              >
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
              停止
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
