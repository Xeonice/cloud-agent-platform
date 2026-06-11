/**
 * `SessionHeader` — the design revision's `.session-toolbar` band + the
 * `.screen-header.with-action` command header.
 *
 * The shell already supplies the global topbar (Track 11), but this page needs
 * session-specific ACTIONS, so — following how the other pages supplied page
 * identity via a screen-header — this renders the design's session-toolbar
 * (breadcrumb + connection pill + 返回任务/复制会话记录/暂停输出/停止任务)
 * directly below the shell topbar, then the screen-header.
 *
 * The live-connection pill is DRIVEN BY THE REAL socket state (never hardcoded
 * 实时连接): green「实时连接」when open, warn「连接中…」while connecting, danger
 *「连接失败」on error, neutral「未连接」when closed.
 *
 * SSR-safe: pure render off props; all interactivity is delegated up via
 * callbacks. No window/clock/random.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import { StatusPill, type StatusPillVariant } from "@/components/status-pill";
import type { ConnectionState } from "./session-terminal";

/** Map the real socket state to a pill variant + label (no hardcoded 实时连接). */
export function connectionPill(state: ConnectionState): {
  variant: StatusPillVariant;
  label: string;
} {
  switch (state) {
    case "open":
      return { variant: "green", label: "实时连接" };
    case "connecting":
      return { variant: "warn", label: "连接中…" };
    case "error":
      return { variant: "danger", label: "连接失败" };
    case "closed":
    default:
      return { variant: "neutral", label: "未连接" };
  }
}

export interface SessionHeaderProps {
  /** Breadcrumb tail + h1 (the short task id, e.g. `task_27c9`). */
  shortId: string;
  /** Lead line: `{repo}#{branch} · {agent}`. */
  lead: string;
  /** The REAL socket state driving both pills. */
  connection: ConnectionState;
  /** Whether output is paused (flips the 暂停输出 button copy). */
  paused: boolean;
  onCopySession: () => void;
  onTogglePause: () => void;
  /**
   * Whether the manual "停止任务" control is offered — true only for an ACTIVE
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
  lead,
  connection,
  paused,
  onCopySession,
  onTogglePause,
  canStop = false,
  stopPending = false,
  onStop,
}: SessionHeaderProps): React.ReactElement {
  const pill = connectionPill(connection);
  // Two-step confirm (no blocking window.confirm): first click arms, second
  // confirms. Reset whenever the control stops being offered (task settled).
  const [confirmingStop, setConfirmingStop] = React.useState(false);
  React.useEffect(() => {
    if (!canStop) setConfirmingStop(false);
  }, [canStop]);
  return (
    <>
      {/* session-toolbar (design `.session-toolbar`): breadcrumb left, session
          actions right; stacks to a column on ≤820px with actions left-aligned. */}
      <header className="mb-[18px] flex items-center justify-between gap-4 max-[821px]:flex-col max-[821px]:items-start">
        <div className="font-mono text-[13px] font-semibold text-muted-foreground">
          tanghehui / agent-control / tasks / {shortId}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 max-[821px]:justify-start">
          <StatusPill variant={pill.variant} data-connection={connection}>
            {pill.label}
          </StatusPill>
          <Link
            to="/dashboard"
            className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            返回任务
          </Link>
          <button
            type="button"
            data-copy-session
            onClick={onCopySession}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            复制会话记录
          </button>
          <button
            type="button"
            data-terminal-pause
            onClick={onTogglePause}
            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {paused ? "恢复输出" : "暂停输出"}
          </button>
          {canStop && onStop ? (
            confirmingStop ? (
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  data-confirm-stop
                  disabled={stopPending}
                  onClick={() => {
                    setConfirmingStop(false);
                    onStop();
                  }}
                  className="inline-flex h-8 items-center justify-center rounded-md bg-danger px-3 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
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
                className="inline-flex h-8 items-center justify-center rounded-md border border-danger/40 bg-card px-3 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
              >
                停止任务
              </button>
            )
          ) : null}
        </div>
      </header>

      {/* screen-header (design `.screen-header.with-action`) */}
      <section
        aria-label="会话头部"
        className="mb-[18px] grid items-end gap-4 grid-cols-[minmax(0,1fr)] min-[821px]:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            实时 CLI
          </div>
          <h1 className="mb-1.5 mt-1 text-[30px] font-semibold leading-[1.15] tracking-normal text-foreground">
            {shortId}
          </h1>
          <p className="m-0 truncate text-sm leading-[1.5] text-muted-foreground">
            {lead}
          </p>
        </div>
        <div className="flex items-center justify-start gap-2.5 min-[821px]:justify-end">
          <StatusPill variant={pill.variant}>{pill.label}</StatusPill>
          <span className="font-mono text-xs text-muted-foreground">
            stdout / stderr
          </span>
        </div>
      </section>
    </>
  );
}
