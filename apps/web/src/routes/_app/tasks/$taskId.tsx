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

import {
  TERMINAL_TASK_STATUSES,
  isReplayableStatus,
  replayPresentationState,
  type SandboxMetadata,
} from "@cap/contracts";
import {
  taskQuery,
  taskContextQuery,
  taskResourceQuery,
  queryKeys,
} from "@/lib/api/queries";
import { stopTaskMutation } from "@/lib/api/mutations";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { SessionHeader } from "@/components/session/session-header";
import type { SessionTaskState } from "@/components/status-pill";
import {
  SessionTerminal,
  type SessionTerminalHandle,
  type ConnectionState,
} from "@/components/session/session-terminal";
import { TerminalSkeleton } from "@/components/session/terminal-skeleton";
import { SessionReplay } from "@/components/session/session-replay";
import { sessionViewMode } from "@/components/session/session-view-mode";
import { formatTaskResource } from "@/components/session/format-resource";
import { SANDBOX_PROVIDER_PENDING_LABEL } from "@/lib/sandbox-provider-label";

/** Statusline / H1 phase label per cockpit state vocabulary (never fabricated). */
const STATE_LABELS: Record<SessionTaskState, string> = {
  running: "运行中",
  gate: "等待审批",
  stopped: "已停止",
  failed: "失败",
};

export const Route = createFileRoute("/_app/tasks/$taskId")({
  ssr: false,
  pendingComponent: TerminalSkeleton,
  component: SessionPage,
});

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
  // headless-task-conversation-view: a headless task opens NO socket (its view is
  // the polled conversation), so there is no socket-reconcile to flip it to its
  // terminal state. Poll the task while it is non-terminal so the view switches
  // from the live conversation to the finished replay once it settles; stop polling
  // at a terminal status. (Interactive tasks are also reconciled via their socket.)
  const { data: task } = useQuery({
    ...taskQuery(taskId),
    refetchInterval: (query) =>
      query.state.data && isReplayableStatus(query.state.data.status)
        ? false
        : 4000,
  });
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
  const [livePane, setLivePane] = React.useState<"terminal" | "conversation">(
    "terminal",
  );

  React.useEffect(() => {
    setLivePane("terminal");
  }, [taskId]);

  const shortId = shortTaskId(taskId);

  // Identity copy — bound to query data where available; the branch is refined by
  // the REAL task.branch only when present (the `branches` capability already
  // wires this into `taskContextQuery`; we never fabricate an unsent field, D5.5).
  const repo = context?.repo ?? "—";
  const branch = task?.branch ?? context?.branch ?? "main";
  const agent = context?.agent ?? "—";
  const sandboxProviderLabel =
    context?.sandboxProviderLabel ?? SANDBOX_PROVIDER_PENDING_LABEL;
  const sandboxEnvironmentName = task?.sandboxEnvironment?.name ?? null;
  const headLabel = `${agent} · ${repo}#${branch}`;

  // Cockpit task-lifecycle state: failed → failed; other terminal → stopped;
  // else running. Drives the H1 Badge and the statusline phase (mirrored, never
  // a fabricated phase). The `gate`/等待审批 state lands with the follow-up
  // approval change that lifts the pending request to the page.
  const taskState: SessionTaskState =
    task?.status === "failed"
      ? "failed"
      : task != null &&
          (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status)
        ? "stopped"
        : "running";

  // Per-task live resource line: codex's OWN process CPU/memory as the PRIMARY
  // figure, labeled by the reading's `scope`, degrading honestly to "未运行/未采样"
  // (never fabricated zeros). Presented in the terminal statusline footer (D3).
  const resourceBody = formatTaskResource(taskResource);

  // The task's CONFIGURED guardrails read back from the task (never fabricated):
  // idle reclaim + wall-clock deadline. Folded into one neutral chip — "默认守护栏"
  // when both are default-off, else the honest configured values (关闭/无 absent).
  const guardrail =
    task?.idleTimeoutMs == null && task?.deadlineMs == null
      ? "默认守护栏"
      : `空闲${
          task?.idleTimeoutMs != null ? formatDuration(task.idleTimeoutMs) : "关闭"
        } · 时限${
          task?.deadlineMs != null ? formatDuration(task.deadlineMs) : "无"
        }`;

  // When the socket opens, reconcile the task read so other views reflect the
  // live session — an honest, real signal (no fabricated status).
  const handleConnectionChange = React.useCallback(
    (state: ConnectionState) => {
      if (state === "open") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.task(taskId),
        });
      }
    },
    [queryClient, taskId],
  );

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
        taskState={taskState}
        prompt={task?.prompt ?? "正在加载任务目标…"}
        branch={branch}
        agent={agent}
        sandboxProviderLabel={sandboxProviderLabel}
        sandboxEnvironmentName={sandboxEnvironmentName}
        guardrail={guardrail}
        canStop={canStop}
        stopPending={stopMutation.isPending}
        onStop={handleStop}
      />

      <SandboxVersionRegion metadata={task?.sandboxMetadata} />

      {/* The terminal slot FILLS the space below the SessionHeader: `flex-1
          min-h-0` absorbs the inset's remaining height (the inset is pinned to
          the viewport on the session route, see `_app.tsx`), and the single
          `minmax(0,1fr)` row+col lets the child stretch to fill while still
          clamping width so long output can't blow out the column. */}
      <section className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(0,1fr)]">
        {(() => {
          // headless-task-conversation-view: branch the session view by
          // status + executionMode (pure `sessionViewMode`, unit-tested):
          //   finished-replay → read-only transcript (NO WS); executionMode flows
          //     through so a finished HEADLESS task also hides its 终端记录 tab.
          //   pre-running     → friendly wait (no sandbox/terminal yet).
          //   headless-live   → a RUNNING headless task: LIVE polled conversation
          //     (NO WebSocket, NO xterm — its output is structured events).
          //   live-terminal   → a RUNNING interactive task: the live xterm,
          //     UNCHANGED (also the loading fallback before `task` resolves).
          const mode = task
            ? sessionViewMode(task.status, task.executionMode)
            : null;
          if (task && mode === "finished-replay") {
            return (
              <SessionReplay
                taskId={taskId}
                presentationState={replayPresentationState(task.status)}
                executionMode={task.executionMode ?? undefined}
              />
            );
          }
          if (task && mode === "pre-running") {
            return <PreRunningPlaceholder status={task.status} />;
          }
          if (task && mode === "headless-live") {
            return (
              <SessionReplay taskId={taskId} live executionMode="headless-exec" />
            );
          }
          return (
            <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
              <div className="inline-flex w-fit rounded-lg bg-secondary p-[3px]">
                <LivePaneButton
                  active={livePane === "terminal"}
                  onClick={() => setLivePane("terminal")}
                >
                  实时终端
                </LivePaneButton>
                <LivePaneButton
                  active={livePane === "conversation"}
                  onClick={() => setLivePane("conversation")}
                >
                  对话记录
                </LivePaneButton>
              </div>
              <div className="min-h-0">
                {livePane === "terminal" ? (
                  <SessionTerminal
                    ref={terminalRef}
                    taskId={taskId}
                    headLabel={headLabel}
                    phaseLabel={STATE_LABELS[taskState]}
                    phasePending={false}
                    resourceLabel={resourceBody}
                    onConnectionChange={handleConnectionChange}
                  />
                ) : (
                  <SessionReplay
                    taskId={taskId}
                    live
                    executionMode={task?.executionMode ?? undefined}
                  />
                )}
              </div>
            </div>
          );
        })()}
      </section>
    </>
  );
}

const OFFICIAL_DEPENDENCY_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  openspec: "OpenSpec",
};

/** Effective immutable image snapshot; absent while sandbox preflight is pending. */
export function SandboxVersionRegion({
  metadata,
}: {
  metadata?: SandboxMetadata | null;
}): React.ReactElement | null {
  if (!metadata) return null;
  const dependencies = Object.entries(metadata.dependencies).sort(([left], [right]) => {
    const order = ["codex", "claude-code", "openspec"];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? order.length : leftIndex) -
        (rightIndex < 0 ? order.length : rightIndex);
    }
    return left.localeCompare(right);
  });

  return (
    <section
      aria-label="沙箱版本"
      className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/35 px-3 py-2 text-xs"
    >
      <VersionItem label="Sandbox" version={metadata.sandboxVersion} />
      {dependencies.map(([id, version]) => (
        <VersionItem
          key={id}
          label={OFFICIAL_DEPENDENCY_LABELS[id] ?? id}
          version={version}
        />
      ))}
    </section>
  );
}

function VersionItem({ label, version }: { label: string; version: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-mono text-foreground">{version}</span>
    </span>
  );
}

function LivePaneButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[30px] rounded-md px-3 text-sm transition-colors ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
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
    <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-terminal-bg text-terminal-fg shadow-terminal">
      <div className="flex min-h-[40px] flex-none items-center justify-between border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
        <span>{label}</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[#050505] px-4 py-3.5 font-mono text-sm text-terminal-muted">
        <span className="animate-pulse">○ {label}</span>
      </div>
    </article>
  );
}
