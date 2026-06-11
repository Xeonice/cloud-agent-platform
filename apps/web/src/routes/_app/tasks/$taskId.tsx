/**
 * `/tasks/$taskId` — 实时 xterm 会话 (app-shell, CLIENT-ONLY; Track 18
 * fe-page-session, tasks 18.1–18.4).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (the sidebar +
 * topbar + mobile-nav already exist — this route does NOT rebuild the shell). It
 * supplies session-specific topbar ACTIONS via a page-level {@link SessionHeader}
 * band, following how the other pages supplied page identity via a screen-header.
 *
 * This is the ONLY `ssr: false` route (rebuild-console-tanstack-start D3.3):
 * xterm.js touches `window` and the terminal WebSocket cannot run on the server,
 * so the live terminal + socket are constructed CLIENT-ONLY inside effects
 * (`SessionTerminal`).
 *
 * `ssr: false` STILL server-renders the `pendingComponent`, so {@link
 * TerminalSkeleton} is a pure, window-free fallback (no window/xterm/WebSocket).
 *
 * Data wiring (D5): `taskQuery` is the REAL task read; `taskContextQuery` is the
 * MOCK context view (repo/branch refined from the real task when the `branches`
 * capability is on). Both are read EXCLUSIVELY via `useQuery` — no bespoke fetch.
 * Terminal bytes never enter Query (D5.4); they go straight to `term.write`.
 *
 * HONESTY: real end-to-end streaming pends the aio-execution-hardening merge.
 * The WS wiring is correct-by-construction; with no reachable socket the page
 * stays in the connecting/closed state and shows honest fallback notices.
 *
 * SSR-safe: the live terminal/socket/clipboard/client-id all live in effects or
 * handlers; the page render is deterministic off query data + plain `useState`.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { TERMINAL_TASK_STATUSES } from "@cap/contracts";
import {
  taskQuery,
  taskContextQuery,
  taskResourceQuery,
  queryKeys,
} from "@/lib/api/queries";
import { stopTaskMutation } from "@/lib/api/mutations";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { SessionHeader } from "@/components/session/session-header";
import { SessionContextStrip } from "@/components/session/session-context-strip";
import {
  SessionTerminal,
  type SessionTerminalHandle,
  type ConnectionState,
} from "@/components/session/session-terminal";
import { TerminalSkeleton } from "@/components/session/terminal-skeleton";
import { formatTaskResource } from "@/components/session/format-resource";

export const Route = createFileRoute("/_app/tasks/$taskId")({
  ssr: false,
  pendingComponent: TerminalSkeleton,
  component: SessionPage,
});

/** Pre-running statuses where no sandbox/terminal exists yet (friendly wait). */
const PRE_RUNNING_STATUSES = new Set(["pending", "queued"]);

/** Compact human duration for the configured-guardrail readout (whole-unit ms). */
function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms} 毫秒`;
}

function SessionPage(): React.ReactElement {
  const { taskId } = Route.useParams();
  const queryClient = useQueryClient();

  // REAL task read + MOCK context view (both via useQuery; ssr:false ⇒ no loader).
  const { data: task } = useQuery(taskQuery(taskId));
  const { data: context } = useQuery(taskContextQuery(taskId));
  // This task's own live CPU/memory (real-time per-task sampler read). Polls
  // only while this page is mounted; `not-running` → honest "未运行/未采样".
  const { data: taskResource } = useQuery(taskResourceQuery(taskId));

  // Operator-initiated stop (task-guardrail-controls): only offered for an ACTIVE
  // (non-terminal) task. On success the mutation reconciles the task cache so the
  // header re-renders without the stop control.
  const stopMutation = useMutation(stopTaskMutation(queryClient));
  const canStop =
    task != null &&
    !(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status);

  const terminalRef = React.useRef<SessionTerminalHandle | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>(
    "connecting",
  );
  const [paused, setPaused] = React.useState(false);

  const shortId = shortTaskId(taskId);

  // Identity copy — bound to query data where available; the branch is refined by
  // the REAL task.branch only when present (the `branches` capability already
  // wires this into `taskContextQuery`; we never fabricate an unsent field, D5.5).
  const repo = context?.repo ?? "—";
  const branch = task?.branch ?? context?.branch ?? "main";
  const agent = context?.agent ?? "—";
  const lead = `${repo}#${branch} · ${agent}`;
  const headLabel = `${agent} · ${repo}#${branch}`;

  // Per-task live resource line: codex's OWN process CPU/memory as the PRIMARY
  // figure with the container total as background, labeled by the reading's
  // `scope` (process vs the container fallback), or an honest "未运行/未采样" when
  // there is no live reading. A transient sampling miss keeps the carried-forward
  // numbers (never flips to not-running). See `formatTaskResource`.
  const resourceBody = formatTaskResource(taskResource);

  // Context strip (design 3+1 grouping): the three task-context cells grouped
  // in the top row; the guardrail readout is the SEPARATED fourth cell. Bind to
  // query data where derivable; keep descriptive copy where not derivable.
  const contextItems = [
    {
      label: "任务目标",
      title: "会话目标",
      body: task?.prompt ?? "正在加载任务目标…",
      primary: true,
    },
    {
      label: "运行环境",
      // runtime is a TRUTHFUL label (AIO Sandbox = the provider); the resource
      // line is now the task's OWN live CPU/memory from the per-task sampler
      // read (resourceBody), degrading honestly to "未运行/未采样" (D5.5).
      title: context?.runtime ?? "—",
      body: resourceBody,
    },
    {
      label: "安全边界",
      title: "写入前确认",
      body: context?.safetyBoundary ?? "commit / push / secret / PR 创建会暂停。",
    },
  ] as const;

  // The task's CONFIGURED guardrails, read back from the task (never
  // fabricated): idle reclaim + wall-clock deadline, both OFF/none by default
  // (task-guardrail-controls). Idle-reclaim off means the task is not killed
  // for being quiet; the operator stops it manually from the header instead.
  const guardrailItem = {
    label: "守护栏",
    title: "空闲 / 时限",
    body: `空闲回收 ${
      task?.idleTimeoutMs != null ? formatDuration(task.idleTimeoutMs) : "关闭"
    } · 运行时限 ${
      task?.deadlineMs != null ? formatDuration(task.deadlineMs) : "无"
    }`,
  } as const;

  // When the socket opens, reconcile the task read so the (shell) topbar status
  // reflects the live session — an honest, real signal (no fabricated status).
  const handleConnectionChange = React.useCallback(
    (state: ConnectionState) => {
      setConnection(state);
      if (state === "open") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.task(taskId),
        });
      }
    },
    [queryClient, taskId],
  );

  async function handleCopySession() {
    const ok = (await terminalRef.current?.copySession()) ?? false;
    if (ok) toast.success("已复制会话记录到剪贴板");
    else toast.error("复制失败：终端内容暂不可用");
  }

  function handleTogglePause() {
    const next = terminalRef.current?.togglePause() ?? false;
    toast.message(next ? "已暂停输出" : "已恢复输出");
  }

  function handleStop() {
    stopMutation.mutate(taskId, {
      onSuccess: (stopped) =>
        toast.message(
          stopped.status === "cancelled" ? "已停止任务" : "任务已结束",
        ),
      onError: (err) => toast.error(`停止失败：${err.message}`),
    });
  }

  return (
    <>
      <SessionHeader
        shortId={shortId}
        lead={lead}
        connection={connection}
        paused={paused}
        onCopySession={handleCopySession}
        onTogglePause={handleTogglePause}
        canStop={canStop}
        stopPending={stopMutation.isPending}
        onStop={handleStop}
      />

      <SessionContextStrip items={contextItems} guardrail={guardrailItem} />

      <section className="grid grid-cols-[minmax(0,1fr)]">
        {task && PRE_RUNNING_STATUSES.has(task.status) ? (
          // A freshly-created task has no provisioned sandbox/terminal yet
          // (pending/queued). Show a friendly wait instead of mounting the
          // terminal into a "connecting" void; once the task reaches `running`
          // (the tasksQuery polls every 5s) this swaps to the live terminal.
          <PreRunningPlaceholder status={task.status} />
        ) : (
          <SessionTerminal
            ref={terminalRef}
            taskId={taskId}
            headLabel={headLabel}
            onConnectionChange={handleConnectionChange}
            onPausedChange={setPaused}
          />
        )}
      </section>
    </>
  );
}

/** Friendly pre-running state shown before the sandbox/terminal exists. */
function PreRunningPlaceholder({
  status,
}: {
  status: string;
}): React.ReactElement {
  const label =
    status === "queued"
      ? "排队中 · 等待并发槽位释放…"
      : "正在启动沙箱 · 准备会话环境…";
  return (
    <article className="overflow-hidden rounded-md bg-terminal-bg text-terminal-fg shadow-terminal min-h-[min(820px,calc(100vh-210px))]">
      <div className="flex min-h-[40px] items-center justify-between border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
        <span>{label}</span>
      </div>
      <div className="flex min-h-[min(680px,calc(100vh-348px))] items-center justify-center bg-[#050505] px-4 py-3.5 font-mono text-sm text-terminal-muted">
        <span className="animate-pulse">○ {label}</span>
      </div>
    </article>
  );
}
