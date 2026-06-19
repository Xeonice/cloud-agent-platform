/**
 * `/workspace` — Agent 控制台 · 工作区总览 Launcher (standalone, SSR; Track 13
 * fe-page-workspace-resume, tasks 13.1 / 13.3 / 13.4).
 *
 * The scheduling entry hub, faithful to the prototype `index.html`. It is a
 * TOP-LEVEL route (NOT under `_app`), so it ships its OWN chrome via the
 * standalone `LandingNav` — the prototype `index.html` nav is exactly the
 * `LandingNav` DEFAULT link-set (产品介绍 / 仓库 / 历史 + 进入工作台 → /dashboard),
 * so this page renders a bare `<LandingNav />`.
 *
 * Composition:
 *   - `LandingNav` (defaults).
 *   - `main.launcher`: a `.launcher-head` (eyebrow / h1 / lead on the left, two
 *     hero actions on the right), the `OpsStrip` of 3 `StatTile`s, and the
 *     `LauncherGrid` of 6 full-card `ScreenCard` links.
 *
 * Data wiring (13.1 / 13.4 — every number is LIVE, never hardcoded):
 *   - The route loader ensures `tasksQuery()` + `reposQuery()` in PARALLEL (no
 *     waterfall) so the queue tally + repo count are hydrated before render.
 *   - `metricsQuery()` is read via `useQuery` (MOCK today; non-blocking — it must
 *     NOT block the route, so it is not in the loader).
 *   - RUNNERS / QUEUE bind to `metricsQuery().capacity` (active / ceiling /
 *     queueDepth); REPOSITORIES binds to the `reposQuery` length + the `isDefault`
 *     repo name; the 任务控制台 footer binds to the count of OPEN tasks
 *     (`isOpenTask`); the 实时会话 footer + deep link bind to the most-relevant
 *     task (the running one, else the first open task, else the first task) via
 *     `shortTaskId`. When a query is still loading every binding falls back to an
 *     em-dash placeholder rather than fabricating a value.
 *   - The 实时会话 card deep-links `/tasks/$taskId` with a REAL task id ONLY when
 *     such a task exists; with no tasks it honestly falls back to `/dashboard`.
 *
 * SSR-safe: deterministic render off query data; `createdAt` ordering uses the
 * task's own timestamp (no `Date.now()` / `Math.random` / `window` in render).
 *
 * Fidelity (NON-console-body cascade — base styles.css + the non-`.console-body`
 * audit-refinement overrides win, mirroring how the `/` landing resolved):
 *   .launcher = max-w 1120 centered, padding 48/clamp/80 — the audit `.launcher`
 *     override only resets max-width, so the base 48px TOP padding survives and
 *     STACKS with the `.launcher-head` pt 58 below (106px above the eyebrow);
 *     .launcher-head = grid `minmax(0,1fr) auto`, gap 22, items-end, pt 58, mb 24
 *     (1-col ≤820). The launcher `.page-title` = display 46px / 600 / tracking 0 /
 *     line-height 1.08, max-w 820, balanced — hard-switching to 36px at the
 *     ≤820px breakpoint; .lead = ink-soft 18→22 clamp / 1.68. .ops-strip = 3-up
 *     grid gap 10, my 14 (2-up ≤1180, 1-up ≤820). .launcher-grid = 3-up gap 10
 *     (1-up ≤820).
 */
import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { Repo, Task } from "@cap/contracts";
import { metricsQuery, reposQuery, tasksQuery } from "@/lib/api/queries";
import { Button } from "@/components/ui/button";
import { LandingNav } from "@/components/shell/landing-nav";
import { OpsStrip, StatTile } from "@/components/workspace/stat-tile";
import { LauncherGrid, ScreenCard } from "@/components/workspace/screen-card";
import { isOpenTask } from "@/components/dashboard/task-status";
import { shortTaskId } from "@/components/dashboard/queue-panel";

export const Route = createFileRoute("/workspace")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between the task tally + the repo count.
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
    ]);
  },
  component: WorkspacePage,
});

/** The em-dash placeholder shown while a query has no data yet. */
const PLACEHOLDER = "—";

/**
 * The most-relevant task for the 实时会话 deep link / footer: the running task
 * first, else the first still-open task, else the most-recent task overall.
 * Returns `undefined` only when there are no tasks at all (then the card honestly
 * falls back to `/dashboard`). Pure — ordering is off each task's own
 * `createdAt`, so the result is deterministic for SSR.
 */
function pickLiveSessionTask(tasks: readonly Task[]): Task | undefined {
  if (tasks.length === 0) return undefined;
  const running = tasks.find((t) => t.status === "running");
  if (running) return running;
  const open = tasks.find((t) => isOpenTask(t.status));
  if (open) return open;
  // Newest by the task's own timestamp (no wall-clock read).
  return [...tasks].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}

/** Resolve a repo's `owner/name` display from its gitSource (or fall back to name). */
function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

function WorkspacePage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());
  const { data: metrics } = useQuery(metricsQuery());

  const taskList = tasks ?? [];
  const repoList = repos ?? [];

  // RUNNERS / QUEUE — derived from the live `/metrics` capacity scalars.
  const capacity = metrics?.capacity;
  const runnersValue = capacity
    ? `${capacity.active} / ${capacity.ceiling} 已占用`
    : PLACEHOLDER;
  const runnersCaption = capacity
    ? `iad-02 正在处理 ${capacity.active} 个活跃任务。`
    : "iad-02 正在处理 — 个活跃任务。";
  const queueValue = capacity
    ? `${capacity.queueDepth} 条命令待派发`
    : PLACEHOLDER;

  // REPOSITORIES — count + default-repo name from the live repo list.
  const repoCount = repos ? repoList.length : undefined;
  const reposValue =
    repoCount !== undefined ? `${repoCount} 个可调度仓库` : PLACEHOLDER;
  const defaultRepo = repoList.find((r) => r.isDefault) ?? repoList[0];
  const reposCaption = defaultRepo
    ? `默认仓库为 ${repoFullName(defaultRepo)}。`
    : "默认仓库为 —。";

  // 任务控制台 footer — count of still-open tasks.
  const openCount = React.useMemo(
    () => taskList.filter((t) => isOpenTask(t.status)).length,
    [taskList],
  );
  const openTasksMeta = tasks ? `${openCount} open tasks` : PLACEHOLDER;

  // 实时会话 footer + deep link — the most-relevant REAL task (or none).
  const liveTask = React.useMemo(() => pickLiveSessionTask(taskList), [taskList]);
  const liveMeta = liveTask
    ? shortTaskId(liveTask.id)
    : tasks
      ? "暂无会话"
      : PLACEHOLDER;

  return (
    <>
      <LandingNav />

      <main className="mx-auto max-w-[1120px] px-[clamp(16px,4vw,40px)] pt-12 pb-20">
        <header className="mb-6 grid grid-cols-1 items-start gap-[22px] pt-[58px] min-[821px]:grid-cols-[minmax(0,1fr)_auto] min-[821px]:items-end">
          <div>
            <div className="font-mono text-xs font-semibold text-muted-foreground">
              Agent Control Plane
            </div>
            <h1 className="mt-3.5 mb-[18px] max-w-[820px] text-[36px] leading-[1.08] font-semibold tracking-normal text-balance text-ink min-[821px]:text-[46px]">
              把远端 Codex Agent 当成可审计的私有运行池。
            </h1>
            <p className="max-w-[680px] text-[clamp(18px,2.1vw,22px)] leading-[1.68] text-pretty text-ink-soft">
              这是你的调度入口：确认 GitHub 身份、管理可派发仓库、查看运行队列，并从具体任务进入实时终端。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/dashboard">打开任务控制台</Link>
            </Button>
            <Button
              asChild
              className="bg-card text-foreground shadow-ring hover:bg-secondary"
            >
              <Link to="/repositories">管理仓库</Link>
            </Button>
          </div>
        </header>

        <OpsStrip>
          <StatTile label="RUNNERS" value={runnersValue}>
            {runnersCaption}
          </StatTile>
          <StatTile label="QUEUE" value={queueValue}>
            等待输入的任务会优先置顶。
          </StatTile>
          <StatTile label="REPOSITORIES" value={reposValue}>
            {reposCaption}
          </StatTile>
        </OpsStrip>

        <LauncherGrid>
          <ScreenCard
            pill="Command center"
            pillTone="blue"
            title="任务控制台"
            footerMeta={openTasksMeta}
            footerAction="进入"
            to="/dashboard"
          >
            运行中、等待输入、排队中三个状态在同一队列里处理，避免把 CLI 控制权藏进自动化黑盒。
          </ScreenCard>

          <ScreenCard
            pill="Repository scope"
            pillTone="default"
            title="仓库导入"
            footerMeta="OAuth scoped"
            footerAction="管理"
            to="/repositories"
          >
            只把当前 GitHub 账号下明确导入的仓库交给远端 Agent，默认仓库可随时切换。
          </ScreenCard>

          {liveTask ? (
            <ScreenCard
              pill="Live terminal"
              pillTone="dark"
              title="实时会话"
              footerMeta={liveMeta}
              footerAction="打开"
              to="/tasks/$taskId"
              params={{ taskId: liveTask.id }}
            >
              从任务进入 xterm 会话，查看 stdout/stderr、输入命令、暂停输出并复制会话记录。
            </ScreenCard>
          ) : (
            <ScreenCard
              pill="Live terminal"
              pillTone="dark"
              title="实时会话"
              footerMeta={liveMeta}
              footerAction="打开"
              to="/dashboard"
            >
              从任务进入 xterm 会话，查看 stdout/stderr、输入命令、暂停输出并复制会话记录。
            </ScreenCard>
          )}

          <ScreenCard
            pill="Audit trail"
            pillTone="default"
            title="历史与日志"
            footerMeta="30 天保留"
            footerAction="查看"
            to="/history"
          >
            按任务、级别和 GitHub 事件回看执行过程，失败原因在事件流里直接定位。
          </ScreenCard>

          <ScreenCard
            pill="Safety policy"
            pillTone="default"
            title="账户与 Codex"
            footerMeta="单用户模式"
            footerAction="配置"
            to="/settings"
          >
            控制白名单账号、默认仓库、会话保留策略，以及 Codex 与 Claude Code 的模型凭据接入。
          </ScreenCard>

          <ScreenCard
            pill="Public context"
            pillTone="default"
            title="产品介绍"
            footerMeta="安全优先"
            footerAction="阅读"
            to="/"
          >
            面向第一次进入的人解释产品结构：OAuth、仓库范围、远端 runner 和实时终端如何协作。
          </ScreenCard>
        </LauncherGrid>
      </main>
    </>
  );
}
