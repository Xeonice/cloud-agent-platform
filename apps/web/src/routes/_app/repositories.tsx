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
import {
  deleteRepoMutation,
  refreshRepoCopyMutation,
  refreshRepoDefaultBranchMutation,
  setDefaultRepoMutation,
} from "@/lib/api/mutations";
import { repoCopyUpdatedCaption } from "@/lib/repo-copy-status";
import {
  claimRepoRefreshSubmission,
  releaseRepoRefreshSubmission,
} from "@/lib/repo-refresh-flow";
import { RepoStatStrip, RepoStatTile } from "@/components/repositories/repo-stat-strip";
import { ImportedReposPanel } from "@/components/repositories/imported-repos-panel";
import {
  ImportDialog,
  repoImportFailurePresentation,
} from "@/components/repositories/import-dialog";

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
  // Poll ONLY while a copy acquisition is actually in flight (possibly started
  // by another session/tab, whose completion this tab would otherwise never
  // see). Idle lists keep the default no-polling behavior.
  const { data: repos } = useQuery({
    ...reposQuery(),
    refetchInterval: (query) =>
      query.state.data?.some((repo) => repo.copyStatus === "refreshing")
        ? 5_000
        : false,
  });
  const setDefault = useMutation(setDefaultRepoMutation(queryClient));
  const refreshDefaultBranch = useMutation(
    refreshRepoDefaultBranchMutation(queryClient),
  );
  const refreshCopy = useMutation(refreshRepoCopyMutation(queryClient));
  const deleteRepo = useMutation(deleteRepoMutation(queryClient));
  const refreshFence = React.useRef<string | null>(null);
  const copyRefreshFence = React.useRef<string | null>(null);
  const deleteFence = React.useRef<string | null>(null);
  const [deletingRepoId, setDeletingRepoId] = React.useState<string | null>(
    null,
  );
  const [refreshingRepoId, setRefreshingRepoId] = React.useState<string | null>(
    null,
  );
  const [refreshingCopyRepoId, setRefreshingCopyRepoId] = React.useState<
    string | null
  >(null);

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

  function handleRefreshDefaultBranch(repoId: string) {
    if (!claimRepoRefreshSubmission(refreshFence, repoId)) return;
    setRefreshingRepoId(repoId);
    refreshDefaultBranch.mutate(repoId, {
      onSuccess: (repo) => {
        toast.success(
          `已刷新 ${repo.name} 的默认分支：${repo.defaultBranch ?? "待解析"}`,
        );
      },
      onError: (error) => {
        const failure = repoImportFailurePresentation(error);
        toast.error(`${failure.pill}：${failure.message}`);
      },
      onSettled: () => {
        releaseRepoRefreshSubmission(refreshFence, repoId);
        setRefreshingRepoId(null);
      },
    });
  }

  /**
   * Acquire (when `missing`) or refresh the repo's repo-store content copy. The
   * request blocks on a real mirror clone/fetch — possibly minutes — so the row
   * shows an explicit in-flight state and every other copy action is fenced.
   * Failures are classified from their stable code, never from raw git output.
   */
  function handleRefreshCopy(repoId: string) {
    if (!claimRepoRefreshSubmission(copyRefreshFence, repoId)) return;
    setRefreshingCopyRepoId(repoId);
    toast.message("正在刷新仓库副本", {
      description: "大仓库可能需要数分钟，完成后状态会自动更新。",
    });
    refreshCopy.mutate(repoId, {
      onSuccess: (repo) => {
        toast.success(`${repo.name} 的副本已就绪（${repoCopyUpdatedCaption(repo)}）`);
      },
      onError: (error) => {
        const failure = repoImportFailurePresentation(error);
        toast.error(`${failure.pill}：${failure.message}`);
      },
      onSettled: () => {
        releaseRepoRefreshSubmission(copyRefreshFence, repoId);
        setRefreshingCopyRepoId(null);
      },
    });
  }

  /**
   * Delete a repository AND its repo-store content copy (add-repo-content-store,
   * "copy lifecycle follows the Repo"). Destructive and irreversible from the
   * console, so it is confirmed first — `window.confirm` is the established
   * console convention for a destructive action (see the sandbox-image retire
   * action) rather than a bespoke dialog.
   *
   * The server REFUSES (409 `repo_has_tasks`) while tasks or schedules still
   * reference the repo; that is surfaced from the stable code, never from raw
   * error prose.
   */
  function handleDelete(repoId: string) {
    const repo = repoList.find((r) => r.id === repoId);
    const name = repo?.name ?? "该仓库";
    const ok = window.confirm(
      `删除仓库「${name}」？这会同时删除服务端为它保存的仓库内容副本；如果之后还要用，需要重新导入。`,
    );
    if (!ok) return;
    if (!claimRepoRefreshSubmission(deleteFence, repoId)) return;
    setDeletingRepoId(repoId);
    deleteRepo.mutate(repoId, {
      onSuccess: () => {
        toast.success(`已删除仓库 ${name} 及其内容副本`);
      },
      onError: (error) => {
        const failure = repoImportFailurePresentation(error);
        toast.error(`${failure.pill}：${failure.message}`);
      },
      onSettled: () => {
        releaseRepoRefreshSubmission(deleteFence, repoId);
        setDeletingRepoId(null);
      },
    });
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
          onRefreshDefaultBranch={handleRefreshDefaultBranch}
          refreshingRepoId={refreshingRepoId}
          onRefreshCopy={handleRefreshCopy}
          refreshingCopyRepoId={refreshingCopyRepoId}
          onDelete={handleDelete}
          deletingRepoId={deletingRepoId}
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
