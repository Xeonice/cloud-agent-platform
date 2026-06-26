/**
 * `ImportedReposPanel` — the `/repositories` 已导入仓库 panel (Track 14; task 14.1).
 *
 * The list of repos the operator has imported into the platform (from
 * `reposQuery`, passed in by the page). The panel renders the prototype's
 * gradient/hairline `.panel-head` (title + sub + a green imported-count pill),
 * the shared four-column list head, one `RepoRow` per imported repo, and the
 * `.repo-empty` "还没有导入仓库" state when the list is empty.
 *
 * The single mutable affordance is per-row: a 设为默认 button (shown only when the
 * repo is not already the default) that runs `setDefaultRepoMutation` — at most
 * one repo is ever the default. The default repo instead shows an inert 默认 badge
 * in its title line. Set-default is wired by the page (so the toast + pending
 * state live with the page-owned mutation); this panel just renders the action.
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
const PERMISSION_LABEL = "GitHub PAT";

export interface ImportedReposPanelProps {
  /** The imported platform repos (from `reposQuery`). */
  repos: readonly Repo[];
  /** Designate a repo as the default (page-owned `setDefaultRepoMutation`). */
  onSetDefault: (repoId: string) => void;
  /** Whether a set-default request is in flight (disables the buttons). */
  settingDefault?: boolean;
  /** The repo id currently being set as default (for the pending label). */
  pendingDefaultId?: string | null;
}

/** The 已导入仓库 panel. */
export function ImportedReposPanel({
  repos,
  onSetDefault,
  settingDefault = false,
  pendingDefaultId = null,
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
                    <p className="m-0 truncate">{PERMISSION_LABEL}</p>
                    <p className="m-0 truncate text-xs">使用已连接 PAT 授权 clone/push。</p>
                  </>
                }
                sync={
                  <>
                    <span className="font-mono text-xs text-foreground">
                      {repo.defaultBranch ?? "main"}
                    </span>
                    <small className="text-xs">默认分支</small>
                  </>
                }
                action={
                  isDefault ? (
                    <span
                      aria-disabled="true"
                      className="inline-flex h-[30px] cursor-default items-center justify-center rounded-md bg-[#fafafa] px-[7px] text-[13px] font-medium text-muted-foreground"
                    >
                      默认仓库
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={settingDefault}
                      onClick={() => onSetDefault(repo.id)}
                      className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-[#f6f8fa] px-[7px] text-[13px] font-medium text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
                    >
                      {pending ? "设置中…" : "设为默认"}
                    </button>
                  )
                }
              />
            );
          })}
        </div>
      )}
    </article>
  );
}
