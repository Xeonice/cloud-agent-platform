/**
 * `/repositories` — 仓库导入 / 仓库范围 (app-shell, SSR; Track 14
 * fe-page-repositories-settings, tasks 14.1 + 14.2).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (the sidebar +
 * topbar + mobile-nav already exist in Track 11 — this route does NOT rebuild the
 * shell). Composes, mirroring the dashboard (Track 16) header convention of a
 * page-body `screen-header`:
 *   - the screen-header (eyebrow 仓库 / h1 仓库范围 / lead + a 添加仓库 button that
 *     opens the import dialog),
 *   - the 4-up `RepoStatStrip` (DEFAULT bound to the default repo from
 *     `reposQuery` — NEVER hardcoded / PERMISSION / SYNC / POLICY),
 *   - the `ImportedReposPanel` (the imported repos from `reposQuery`, with a
 *     per-row 设为默认 action),
 *   - the `ImportDialog` (the GitHub import flow).
 *
 * Data wiring:
 *   - The route loader ensures `reposQuery()` so the imported list + the DEFAULT
 *     tile are hydrated before render. `githubReposQuery` is read lazily inside
 *     the dialog (armed on 同步仓库列表) so it never blocks the route.
 *   - Import runs the SHARED `importRepoMutation` (inside the dialog); set-default
 *     runs the SHARED `setDefaultRepoMutation` here. Both invalidate the repo list
 *     so every default-aware view re-derives; toasts fire via sonner.
 *
 * SSR-safe: deterministic render off query data; the dialog-open flag is plain
 * `useState`. No window/clock/random during render or at module scope.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { reposQuery } from "@/lib/api/queries";
import { setDefaultRepoMutation } from "@/lib/api/mutations";
import { RepoStatStrip, RepoStatTile } from "@/components/repositories/repo-stat-strip";
import { ImportedReposPanel } from "@/components/repositories/imported-repos-panel";
import { ImportDialog } from "@/components/repositories/import-dialog";

export const Route = createFileRoute("/_app/repositories")({
  loader: async ({ context }) => {
    // Ensure the imported repo list is hydrated before render (the DEFAULT tile
    // + the panel both read it). The GitHub candidate list is fetched lazily in
    // the dialog and must not block the route.
    await context.queryClient.ensureQueryData(reposQuery());
  },
  component: RepositoriesPage,
});

function RepositoriesPage() {
  const queryClient = useQueryClient();
  const { data: repos } = useQuery(reposQuery());
  const setDefault = useMutation(setDefaultRepoMutation(queryClient));

  const [dialogOpen, setDialogOpen] = React.useState(false);

  const repoList = repos ?? [];
  const defaultRepo = repoList.find((r) => r.isDefault) ?? null;

  function handleSetDefault(repoId: string) {
    const repo = repoList.find((r) => r.id === repoId);
    setDefault.mutate(
      { repoId },
      {
        onSuccess: () => {
          toast.success(`已将 ${repo?.name ?? "仓库"} 设为默认`);
        },
        onError: (error) => {
          toast.error(`设为默认失败：${error.message}`);
        },
      },
    );
  }

  return (
    <>
      {/* Screen header */}
      <section className="mb-[18px] grid items-end gap-4 min-[821px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">仓库</div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            仓库范围
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            只让明确导入的仓库进入调度池；默认仓库决定新建任务的初始上下文。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex min-h-[34px] items-center justify-center justify-self-start whitespace-nowrap rounded-md bg-primary px-[13px] text-[13px] font-medium text-primary-foreground hover:bg-[#2a2a2a] min-[821px]:justify-self-end"
        >
          添加仓库
        </button>
      </section>

      {/* Control summary strip */}
      <RepoStatStrip>
        <RepoStatTile
          label="DEFAULT"
          value={defaultRepo ? defaultRepo.name : "未设置"}
          caption={
            defaultRepo
              ? defaultRepo.defaultBranch
                ? `新建任务默认使用 ${defaultRepo.defaultBranch} 分支。`
                : "默认分支尚未解析；新建任务将由后端安全解析。"
              : "导入仓库后可指定默认仓库。"
          }
        />
        <RepoStatTile
          label="PERMISSION"
          value="GitHub PAT"
          caption="使用已连接 PAT 授权 clone/push。"
        />
        <RepoStatTile
          label="SYNC"
          value="3 小时前"
          caption="上次读取当前账号仓库列表。"
        />
        <RepoStatTile
          label="POLICY"
          value="沙箱内自治"
          caption="危险动作在会话内暂停。"
        />
      </RepoStatStrip>

      {/* Imported repos */}
      <section className="grid items-start gap-3">
        <ImportedReposPanel
          repos={repoList}
          onSetDefault={handleSetDefault}
          settingDefault={setDefault.isPending}
          pendingDefaultId={setDefault.variables?.repoId ?? null}
        />
      </section>

      <ImportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        importedRepos={repoList}
      />
    </>
  );
}
