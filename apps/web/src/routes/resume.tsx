/**
 * `/resume` — Agent 控制台 · 继续处理 (Handoff launcher; standalone, SSR).
 *
 * Track 13 (fe-page-workspace-resume) tasks 13.2 + 13.3 + 13.4. Faithful to the
 * prototype `agent-control-launcher.html`: a deliberately minimal "next step"
 * entry that keeps ONLY the single most important action (continue the remote
 * task that is waiting on operator input) and defers the full workspace to the
 * landing page and the live run-state to the task console.
 *
 * It is a TOP-LEVEL route (NOT under `_app`), so — like `/` and `/workspace` —
 * it ships its OWN chrome via the configurable `LandingNav` instead of the app
 * shell. The resume nav DIFFERS from the LandingNav defaults, so it passes
 * EXPLICIT links (工作区 / 任务 / 仓库) + cta (进入控制台). The brand still → `/`.
 *
 * Data wiring (13.2 / 13.4):
 *   - The route loader ensures `tasksQuery()` + `reposQuery()` in PARALLEL (no
 *     waterfall) so both the NEXT ACTION and DEFAULT SCOPE tiles hydrate before
 *     first paint. The task list keeps its 5s poll (the factory's
 *     `refetchInterval`); this route adds no manual interval.
 *   - NEXT ACTION binds to the highest-priority `awaiting_input` task (the
 *     earliest-created one — the same "等待输入置顶" precedence the queue uses).
 *     The tile shows「{shortTaskId} 等待输入」with the task's REAL prompt as the
 *     caption, and the second handoff CTA「进入等待输入任务」deep-links to
 *     `/tasks/$taskId` with THAT task's real id. When NO task is awaiting input
 *     we fall back HONESTLY (no fabricated `task_24ab`): the tile shows a
 *     no-pending state and the CTA points at the task console instead.
 *   - DEFAULT SCOPE binds to the operator's default repo — the `isDefault` repo
 *     from `reposQuery`, else the store's `selectedRepo`, else the first repo —
 *     showing that repo's display name.
 *   - SAFETY is static (the write-confirm boundary copy).
 *
 * SSR-safe: a pure derivation off query + store data; the only client state is
 * the store selector (which returns the deterministic server snapshot during
 * SSR). No window/clock/random access in render.
 *
 * Fidelity (NON-console-body cascade — base `styles.css` + non-.console-body
 * `audit-refinement.css` overrides win; the `handoff-*` class names carry no CSS
 * of their own and fall back to the base `.launcher` frame):
 *   .launcher  → max-w 1120, centered, padding 58px clamp(16,4vw,40) 80px.
 *   .eyebrow   → mono 12px / 600 / muted.
 *   .page-title (`.launcher .page-title`, audit override) → max-w 820, 46px,
 *     line-height 1.08, letter-spacing 0 (36px ≤ the mobile breakpoint).
 *   .lead      → ink-soft, clamp(18px,2.1vw,22px) / 1.68, max-w 680.
 *   .button    → ink primary; `.button.secondary` → surface + ink + ring.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import type { Repo, Task } from "@cap/contracts";
import { reposQuery, tasksQuery } from "@/lib/api/queries";
import { useStoreSelector } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  LandingNav,
  type LandingNavLink,
  type LandingNavCta,
} from "@/components/shell/landing-nav";
import { shortTaskId } from "@/components/dashboard/queue-panel";
import { StatTile } from "@/components/resume/stat-tile";

export const Route = createFileRoute("/resume")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between the pending task + the repo scope.
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
    ]);
  },
  component: ResumePage,
});

/**
 * The resume-specific nav links — DIFFERENT from the LandingNav defaults
 * (工作区 / 任务 / 仓库, verbatim prototype copy). The brand keeps its → `/`.
 */
const RESUME_NAV_LINKS: readonly LandingNavLink[] = [
  { label: "工作区", to: "/workspace" },
  { label: "任务", to: "/dashboard" },
  { label: "仓库", to: "/repositories" },
];

/** The resume CTA →「进入控制台」. */
const RESUME_NAV_CTA: LandingNavCta = { label: "进入控制台", to: "/dashboard" };

/**
 * Pick the highest-priority `awaiting_input` task (earliest-created wins, the
 * same precedence the queue's "等待输入置顶" uses), or `null` when none is
 * waiting. Pure — never mutates the list.
 */
function findPendingTask(tasks: readonly Task[]): Task | null {
  const waiting = tasks.filter((t) => t.status === "awaiting_input");
  if (waiting.length === 0) return null;
  return waiting.reduce((earliest, t) =>
    t.createdAt.getTime() < earliest.createdAt.getTime() ? t : earliest,
  );
}

/**
 * Resolve the operator's default repo: the `isDefault` repo, else the
 * store-selected repo, else the first imported repo, else `null`.
 */
function findDefaultRepo(
  repos: readonly Repo[],
  selectedRepoId: string | null,
): Repo | null {
  return (
    repos.find((r) => r.isDefault) ??
    (selectedRepoId
      ? (repos.find((r) => r.id === selectedRepoId) ?? null)
      : null) ??
    repos[0] ??
    null
  );
}

function ResumePage() {
  const { data: tasks } = useQuery(tasksQuery());
  const { data: repos } = useQuery(reposQuery());
  const selectedRepoId = useStoreSelector((s) => s.selectedRepo);

  const pendingTask = findPendingTask(tasks ?? []);
  const defaultRepo = findDefaultRepo(repos ?? [], selectedRepoId);

  return (
    <>
      <LandingNav links={RESUME_NAV_LINKS} cta={RESUME_NAV_CTA} />

      <main className="mx-auto grid max-w-[1120px] gap-6 px-[clamp(16px,4vw,40px)] pt-12 pb-20">
        <section className="grid gap-6">
          <div>
            <div className="font-mono text-xs font-semibold text-muted-foreground">
              Resume
            </div>
            <h1 className="mt-3.5 mb-[18px] max-w-[820px] text-[clamp(36px,5vw,46px)] leading-[1.08] font-semibold tracking-normal text-balance text-ink">
              继续处理等待输入的远端任务。
            </h1>
            <p className="max-w-[680px] text-[clamp(18px,2.1vw,22px)] leading-[1.68] text-pretty text-ink-soft">
              这个入口只保留当前最重要的下一步；完整工作区从首页进入，具体运行状态在任务控制台处理。
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
              {pendingTask ? (
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: pendingTask.id }}
                >
                  进入等待输入任务
                </Link>
              ) : (
                <Link to="/dashboard">进入等待输入任务</Link>
              )}
            </Button>
          </div>
        </section>

        <section
          aria-label="当前操作"
          className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-3"
        >
          {pendingTask ? (
            <StatTile
              label="NEXT ACTION"
              value={`${shortTaskId(pendingTask.id)} 等待输入`}
            >
              {pendingTask.prompt}
            </StatTile>
          ) : (
            <StatTile label="NEXT ACTION" value="暂无等待输入任务">
              当前没有需要操作者确认的远端任务。
            </StatTile>
          )}

          <StatTile
            label="DEFAULT SCOPE"
            value={defaultRepo ? defaultRepo.name : "尚未导入仓库"}
          >
            新任务默认从已导入仓库创建。
          </StatTile>

          <StatTile label="SAFETY" value="沙箱即信任边界">
            Agent 在隔离容器内自主执行，凭据用后即焚。
          </StatTile>
        </section>
      </main>
    </>
  );
}
