/**
 * `ImportDialog` — the `/repositories` 仓库导入 dialog (Track 14; tasks 14.1 + 14.2).
 *
 * A shadcn `Dialog` (Radix supplies Esc / backdrop close, focus trap,
 * `aria-modal`, `aria-labelledby`, focus-return — no manual a11y wiring) that
 * pulls the operator's importable GitHub repositories and lets them select which
 * to add to the platform's scheduling pool. It owns THREE states:
 *
 *   1. 待拉取 (empty)   — `.import-empty-layout`: a 待拉取 pill, the sync heading +
 *                         copy, and a 同步仓库列表 button that triggers the fetch.
 *   2. 正在拉取 (loading) — a 正在拉取 pill + the mono `GET /user/repos?…` line,
 *                         shown while `githubReposQuery` is fetching.
 *   3. available list  — a search row (筛选仓库 input + a「N 个可导入」count chip),
 *                         the list head, and one candidate row per GitHub repo.
 *
 * Candidate reconciliation (task 14.2): each GitHub candidate is checked against
 * the already-imported platform repos (by GitHub numeric id AND `owner/name`
 * slug). An already-imported candidate is disabled and labelled 已导入 instead of
 * offering an 导入 button — and an import that races a concurrent import (the
 * real endpoint answers 409 already-imported) is reconciled the same way rather
 * than surfaced as an error. The data is read EXCLUSIVELY through
 * `githubReposQuery` (never a bespoke fetch), so flipping the `githubImport`
 * capability repoints it at the real `GET /user/repos` with no change here; the
 * distinct empty-vs-error-vs-reauth states are kept as honest seams.
 *
 * SSR-safe: the dialog content mounts only when open (Radix portals on the
 * client); the fetch is deferred until the operator clicks 同步仓库列表 (the query
 * is `enabled` only once armed). Search state is plain `useState`; no
 * window/clock/random at module scope or during render.
 *
 * Fidelity (`.repo-import-modal` FINAL cascade): dialog 760px, white; modal-head
 * 18/20 padding + bottom hairline (eyebrow / h2 20px / muted p); the drawer body
 * padding `0 20px 22px`; empty layout max-w 560 with a fit-content ≥180px button;
 * search row two-column `minmax(0,1fr) auto`; candidate rows = the shared
 * `RepoRow`; a disabled action uses the muted `#fafafa` pill.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { AvailableGithubRepo, Repo } from "@cap/contracts";
import { githubReposQuery } from "@/lib/api/queries";
import { importRepoMutation } from "@/lib/api/mutations";
import { ApiError } from "@/lib/api/real";
import { StatusPill } from "@/components/status-pill";
import { CountChip } from "@/components/count-chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepoRow, RepoListHead } from "./repo-row";

export interface ImportDialogProps {
  /** Whether the dialog is open (controlled by the page's 添加仓库 button). */
  open: boolean;
  /** Open/close callback (wired to Esc / backdrop / the close button). */
  onOpenChange: (open: boolean) => void;
  /** The already-imported platform repos, for candidate reconciliation. */
  importedRepos: readonly Repo[];
}

/**
 * Reconcile an already-imported set into the lookup keys a GitHub candidate is
 * matched against: the originating GitHub numeric id (as a string) AND the
 * `owner/name` slug. PURE — exported for unit-testing the dedup reconciliation.
 */
export function buildImportedIndex(repos: readonly Repo[]): {
  githubIds: ReadonlySet<string>;
  fullNames: ReadonlySet<string>;
} {
  const githubIds = new Set<string>();
  const fullNames = new Set<string>();
  for (const repo of repos) {
    if (repo.githubId) githubIds.add(repo.githubId);
    const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    const slug = match?.[1] ?? repo.name;
    fullNames.add(slug.toLowerCase());
  }
  return { githubIds, fullNames };
}

/** Whether a GitHub candidate is already imported (by id or `owner/name`). */
export function isAlreadyImported(
  candidate: AvailableGithubRepo,
  index: { githubIds: ReadonlySet<string>; fullNames: ReadonlySet<string> },
): boolean {
  return (
    index.githubIds.has(String(candidate.id)) ||
    index.fullNames.has(candidate.full_name.toLowerCase())
  );
}

/** The 仓库导入 dialog. */
export function ImportDialog({
  open,
  onOpenChange,
  importedRepos,
}: ImportDialogProps) {
  const queryClient = useQueryClient();

  // The GitHub list is fetched lazily: armed only after the operator clicks
  // 同步仓库列表 (and re-armed whenever the dialog reopens). Reading through
  // `githubReposQuery` keeps the real/mock switch + cache key intact.
  const [armed, setArmed] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [importingId, setImportingId] = React.useState<number | null>(null);

  const githubRepos = useQuery({ ...githubReposQuery(), enabled: armed });
  const importMutation = useMutation(importRepoMutation(queryClient));

  // Reset the dialog's fetch + search state whenever it (re)opens so a reopened
  // dialog always starts from the 待拉取 state rather than a stale list.
  React.useEffect(() => {
    if (open) return;
    setArmed(false);
    setSearch("");
    setImportingId(null);
  }, [open]);

  const candidates = githubRepos.data ?? [];

  const importedIndex = React.useMemo(
    () => buildImportedIndex(importedRepos),
    [importedRepos],
  );

  // Client-only filter over the candidate list (never touches the cache).
  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((c) =>
      `${c.full_name} ${c.name}`.toLowerCase().includes(needle),
    );
  }, [candidates, search]);

  function handleImport(candidate: AvailableGithubRepo) {
    setImportingId(candidate.id);
    importMutation.mutate(candidate, {
      onSuccess: () => {
        toast.success(`已导入 ${candidate.full_name}`);
        setImportingId(null);
      },
      onError: (error) => {
        setImportingId(null);
        // A 409 means the repo was already imported (e.g. a concurrent import):
        // reconcile it as imported, not as a hard failure. The repo list is
        // invalidated so the candidate flips to 已导入 on the next read.
        if (error instanceof ApiError && error.status === 409) {
          void queryClient.invalidateQueries();
          toast.message(`${candidate.full_name} 已在调度池中`);
          return;
        }
        toast.error(`导入失败：${error.message}`);
      },
    });
  }

  // Distinguish the failure modes honestly (task 14.2). A re-auth signal
  // (401/403) prompts re-authorization; everything else is a transient/unknown
  // listing error. An empty-but-successful list is NOT an error.
  const fetchError = githubRepos.error;
  const needsReauth =
    fetchError instanceof ApiError &&
    (fetchError.status === 401 || fetchError.status === 403);

  const showEmptyState = !armed;
  const showLoadingState = armed && githubRepos.isLoading;
  const showError = armed && !githubRepos.isLoading && fetchError != null;
  const showList =
    armed && !githubRepos.isLoading && fetchError == null && candidates.length > 0;
  const showNoRepos =
    armed && !githubRepos.isLoading && fetchError == null && candidates.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="repo-import-title"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_28px_90px_rgba(0,0,0,0.22)] sm:max-w-[820px]"
      >
        {/* Head */}
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-card px-5 py-[18px]">
          <div>
            <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              仓库导入
            </span>
            <DialogTitle
              id="repo-import-title"
              className="mt-1 mb-[5px] text-[22px] font-semibold tracking-[-0.8px] text-ink"
            >
              添加仓库
            </DialogTitle>
            <DialogDescription className="max-w-[620px] text-[13px] leading-[1.55] text-muted-foreground">
              拉取当前 GitHub 授权账号下的仓库，只把明确选择的项目加入远端调度池。
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="关闭添加导入"
            onClick={() => onOpenChange(false)}
            className="grid size-8 place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </button>
        </header>

        <DialogBody>
        <div className="grid gap-3.5 px-5 pt-0.5 pb-[22px]">
          {/* State 1: 待拉取 (empty) */}
          {showEmptyState ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                待拉取
              </StatusPill>
              <h3 className="m-0 text-xl font-semibold leading-[1.25] tracking-[-0.5px] text-foreground">
                先同步仓库列表，再选择调度范围。
              </h3>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                同步只读取仓库名称、默认分支和更新时间；写入 token 会在任务创建时按仓库短期签发。
              </p>
              <button
                type="button"
                onClick={() => setArmed(true)}
                className="inline-flex h-9 w-fit min-w-[180px] items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                同步仓库列表
              </button>
            </div>
          ) : null}

          {/* State 2: 正在拉取 (loading) */}
          {showLoadingState ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                正在拉取
              </StatusPill>
              <p className="m-0 font-mono text-xs leading-[1.55] text-muted-foreground">
                GET /user/repos?affiliation=owner
              </p>
            </div>
          ) : null}

          {/* Error states (task 14.2: re-auth vs transient, distinct from empty) */}
          {showError ? (
            <div
              role="alert"
              className="grid gap-3 rounded-lg bg-[#fff1f0] p-[18px] shadow-ring"
            >
              <StatusPill variant="danger" className="justify-self-start">
                {needsReauth ? "需要重新授权" : "拉取失败"}
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-foreground">
                {needsReauth
                  ? "GitHub 授权已失效，请重新授权后再同步仓库列表。"
                  : "暂时无法读取 GitHub 仓库列表，请稍后重试。"}
              </p>
              <button
                type="button"
                onClick={() => void githubRepos.refetch()}
                className="inline-flex h-9 w-fit min-w-[180px] items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
              >
                {needsReauth ? "重新授权 GitHub" : "重试同步"}
              </button>
            </div>
          ) : null}

          {/* Empty-but-successful list (NOT an error) */}
          {showNoRepos ? (
            <div className="grid gap-3 rounded-lg bg-[#fafafa] p-[18px] shadow-ring">
              <StatusPill variant="neutral" className="justify-self-start">
                没有可导入仓库
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                当前 GitHub 账号下没有可导入的仓库；新建仓库后可再次同步。
              </p>
            </div>
          ) : null}

          {/* State 3: available list */}
          {showList ? (
            <div className="grid gap-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <label className="m-0 grid gap-2">
                  <span className="text-[13px] font-semibold text-ink">筛选仓库</span>
                  <input
                    type="search"
                    data-repo-search
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="输入仓库名"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <CountChip data-available-count className="self-end">
                  {visible.length} 个可导入
                </CountChip>
              </div>

              <RepoListHead />

              {visible.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  没有匹配的仓库。
                </p>
              ) : (
                <div data-available-repo-list>
                  {visible.map((candidate) => {
                    const imported = isAlreadyImported(candidate, importedIndex);
                    const importing = importingId === candidate.id;
                    return (
                      <RepoRow
                        key={candidate.id}
                        name={candidate.name}
                        fullName={candidate.full_name}
                        policy={
                          <>
                            <p className="m-0 truncate">
                              {candidate.visibility === "private"
                                ? "私有仓库"
                                : "公开仓库"}
                            </p>
                            {candidate.description ? (
                              <p className="m-0 truncate text-xs">
                                {candidate.description}
                              </p>
                            ) : null}
                          </>
                        }
                        sync={
                          <>
                            <span className="font-mono text-xs text-foreground">
                              {candidate.defaultBranch}
                            </span>
                            <small className="text-xs">默认分支</small>
                          </>
                        }
                        action={
                          imported ? (
                            <span
                              aria-disabled="true"
                              className="inline-flex h-[30px] cursor-default items-center justify-center rounded-md bg-[#fafafa] px-[7px] text-[13px] font-medium text-muted-foreground"
                            >
                              已导入
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={importMutation.isPending}
                              onClick={() => handleImport(candidate)}
                              className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-primary px-[7px] text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                            >
                              {importing ? "导入中…" : "导入"}
                            </button>
                          )
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
