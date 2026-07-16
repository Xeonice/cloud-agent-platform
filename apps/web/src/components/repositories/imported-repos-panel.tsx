/**
 * `ImportedReposPanel` — the `/repositories` 已导入仓库 panel (Track 14; task 14.1).
 *
 * The list of repos the operator has imported into the platform (from
 * `reposQuery`, passed in by the page). The panel renders the prototype's
 * gradient/hairline `.panel-head` (title + sub + a green imported-count pill),
 * the shared four-column list head, one `RepoRow` per imported repo, and the
 * `.repo-empty` "还没有导入仓库" state when the list is empty.
 *
 * Every row can re-verify its persisted default branch. Non-default rows also
 * retain the 设为默认 action. Both mutations are page-owned so their pending
 * state and safe operator feedback remain outside this pure rendering panel.
 *
 * SSR-safe: pure render off props. No window/clock/random.
 *
 * Fidelity: panel = white, radius 6, ring-shadow, padding 18; panel-head =
 * subtle bg + bottom hairline, negative-margin full-bleed (`-18px -18px 14px`);
 * list rows = the shared `RepoRow`. Empty state = `#fafafa` ring-shadow block.
 */
import * as React from "react";

import type { Repo } from "@cap/contracts";
import { StatusPill } from "@/components/status-pill";
import { RepoRow, RepoListHead, repoFullName } from "./repo-row";

/**
 * The permission label shown for every scoped imported repo. GitHub-imported
 * repos use the operator's connected GitHub PAT server-side.
 */
function permissionLabel(repo: Repo): string {
  switch (repo.forge) {
    case "gitlab":
      return "GitLab 凭据";
    case "gitee":
      return "Gitee 凭据";
    case "github":
    case null:
    case undefined:
      return "GitHub PAT";
  }
}

export interface ImportedReposPanelProps {
  /** The imported platform repos (from `reposQuery`). */
  repos: readonly Repo[];
  /** Designate a repo as the default (page-owned `setDefaultRepoMutation`). */
  onSetDefault: (repoId: string) => void;
  /** Whether a set-default request is in flight (disables the buttons). */
  settingDefault?: boolean;
  /** The repo id currently being set as default (for the pending label). */
  pendingDefaultId?: string | null;
  /** Re-verify one existing repository's persisted default branch. */
  onRefreshDefaultBranch: (repoId: string) => void;
  /** The Repo id whose server-side symbolic-HEAD probe is in flight. */
  refreshingRepoId?: string | null;
}

/** The 已导入仓库 panel. */
export function ImportedReposPanel({
  repos,
  onSetDefault,
  settingDefault = false,
  pendingDefaultId = null,
  onRefreshDefaultBranch,
  refreshingRepoId = null,
}: ImportedReposPanelProps) {
  return (
    <article
      data-slot="imported-repos-panel"
      className="min-h-[420px] rounded-md bg-card p-[18px] shadow-ring"
    >
      {/* Panel head */}
      <div className="-mx-[18px] -mt-[18px] mb-3.5 flex min-h-10 items-center justify-between gap-3 rounded-t-md border-b border-border bg-[#f6f8fa] px-[18px] py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">已导入仓库</h3>
          <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">
            这些仓库会出现在任务创建、默认仓库和会话上下文里。
          </p>
        </div>
        <StatusPill variant="green" data-imported-count className="shrink-0">
          {repos.length} 个
        </StatusPill>
      </div>

      <RepoListHead />

      {repos.length === 0 ? (
        <div
          data-imported-empty
          className="grid gap-3 rounded-lg bg-[#fafafa] p-[18px] shadow-ring"
        >
          <strong className="text-sm text-foreground">还没有导入仓库</strong>
          <p className="text-[13px] leading-[1.55] text-muted-foreground">
            点击“添加导入”，从当前 GitHub 账号拉取仓库后选择要加入调度台的项目。
          </p>
        </div>
      ) : (
        <div data-imported-repo-list aria-live="polite">
          {repos.map((repo) => {
            const isDefault = repo.isDefault === true;
            const pending = settingDefault && pendingDefaultId === repo.id;
            const refreshing = refreshingRepoId === repo.id;
            return (
              <RepoRow
                key={repo.id}
                name={repo.name}
                fullName={repoFullName(repo)}
                titleBadge={
                  isDefault ? (
                    <StatusPill
                      variant="green"
                      className="h-[22px] shrink-0 px-[7px] text-[11px] leading-[22px]"
                    >
                      默认
                    </StatusPill>
                  ) : null
                }
                policy={
                  <>
                    <p className="m-0 truncate">{permissionLabel(repo)}</p>
                    <p className="m-0 truncate text-xs">使用已连接 PAT 授权 clone/push。</p>
                  </>
                }
                sync={
                  <>
                    <span className="font-mono text-xs text-foreground">
                      {repo.defaultBranch ?? "待解析"}
                    </span>
                    <small className="text-xs">默认分支</small>
                  </>
                }
                action={
                  <div className="flex flex-col items-stretch gap-1.5">
                    <button
                      type="button"
                      data-refresh-repo-id={repo.id}
                      disabled={refreshingRepoId !== null || settingDefault}
                      onClick={() => onRefreshDefaultBranch(repo.id)}
                      className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-[#f6f8fa] px-[7px] text-[13px] font-medium text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
                    >
                      {refreshing ? "刷新中…" : "刷新分支"}
                    </button>
                    {isDefault ? null : (
                      <button
                        type="button"
                        disabled={settingDefault || refreshingRepoId !== null}
                        onClick={() => onSetDefault(repo.id)}
                        className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-[#f6f8fa] px-[7px] text-[13px] font-medium text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
                      >
                        {pending ? "设置中…" : "设为默认"}
                      </button>
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </article>
  );
}
