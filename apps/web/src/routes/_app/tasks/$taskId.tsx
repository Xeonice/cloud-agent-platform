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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { taskQuery, taskContextQuery, queryKeys } from "@/lib/api/queries";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { SessionHeader } from "@/components/session/session-header";
import { SessionContextStrip } from "@/components/session/session-context-strip";
import {
  SessionTerminal,
  type SessionTerminalHandle,
  type ConnectionState,
} from "@/components/session/session-terminal";
import { TerminalSkeleton } from "@/components/session/terminal-skeleton";

export const Route = createFileRoute("/_app/tasks/$taskId")({
  ssr: false,
  pendingComponent: TerminalSkeleton,
  component: SessionPage,
});

function SessionPage(): React.ReactElement {
  const { taskId } = Route.useParams();
  const queryClient = useQueryClient();

  // REAL task read + MOCK context view (both via useQuery; ssr:false ⇒ no loader).
  const { data: task } = useQuery(taskQuery(taskId));
  const { data: context } = useQuery(taskContextQuery(taskId));

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

  // Context strip: bind to query data where derivable; keep the prototype's
  // descriptive copy VERBATIM where the field is not derivable (worktree/pty).
  const contextItems = [
    {
      label: "任务目标",
      title: "会话目标",
      body: task?.prompt ?? "正在加载任务目标…",
      primary: true,
    },
    {
      label: "运行环境",
      // runtime is a TRUTHFUL label (AIO Sandbox = the provider); resources +
      // worktree-diff have no backend field today, so show runtime alone + an
      // honest "未上报" rather than the prototype's fabricated "2 vCPU·4 GiB /
      // worktree 2 个文件改动" (D5.5 — never render an unsent value).
      title: context?.runtime ?? "—",
      body:
        context?.resources && context.resources !== "—"
          ? context.resources
          : "运行规格未上报",
    },
    {
      label: "安全边界",
      title: "写入前确认",
      body: context?.safetyBoundary ?? "commit / push / secret / PR 创建会暂停。",
    },
  ] as const;

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

  return (
    <>
      <SessionHeader
        shortId={shortId}
        lead={lead}
        connection={connection}
        paused={paused}
        onCopySession={handleCopySession}
        onTogglePause={handleTogglePause}
      />

      <SessionContextStrip items={contextItems} />

      <section className="grid grid-cols-[minmax(0,1fr)]">
        <SessionTerminal
          ref={terminalRef}
          taskId={taskId}
          headLabel={headLabel}
          onConnectionChange={handleConnectionChange}
          onPausedChange={setPaused}
        />
      </section>
    </>
  );
}
