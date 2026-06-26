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
 * distinct empty-vs-error-vs-PAT-required states are kept as honest seams.
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

import type {
  AvailableGithubRepo,
  AvailableForgeRepo,
  ForgeKind,
  Repo,
} from "@cap/contracts";
import { availableForgeReposQuery, githubReposQuery } from "@/lib/api/queries";
import { createRepoMutation, importRepoMutation } from "@/lib/api/mutations";
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

  // The GitHub list is fetched lazily through the connected GitHub PAT: armed
  // only after the operator clicks 同步仓库列表 (and re-armed whenever the dialog
  // reopens). Reading through `githubReposQuery` keeps the real/mock switch +
  // cache key intact.
  const [armed, setArmed] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [importingId, setImportingId] = React.useState<number | null>(null);
  // add-multi-forge-task-delivery: the selected import source (the picker switch).
  const [source, setSource] = React.useState<ForgeKind>("github");
  const [importingPath, setImportingPath] = React.useState<string | null>(null);

  const githubRepos = useQuery({ ...githubReposQuery(), enabled: armed });
  const importMutation = useMutation(importRepoMutation(queryClient));
  // The connected non-github forge's repos (lists via GET /settings/forges/repos).
  const forgeRepos = useQuery({
    ...availableForgeReposQuery(source),
    enabled: armed && source !== "github",
  });
  const createMutation = useMutation(createRepoMutation(queryClient));

  // Reset the dialog's fetch + search state whenever it (re)opens so a reopened
  // dialog always starts from the 待拉取 state rather than a stale list.
  React.useEffect(() => {
    if (open) return;
    setArmed(false);
    setSearch("");
    setImportingId(null);
    setSource("github");
    setImportingPath(null);
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

  // --- forge (gitlab/gitee) picker source ---------------------------------
  const forgeCandidates = forgeRepos.data ?? [];
  const importedGitSources = React.useMemo(
    () => new Set(importedRepos.map((r) => r.gitSource)),
    [importedRepos],
  );
  const visibleForge = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return forgeCandidates;
    return forgeCandidates.filter((c) =>
      c.fullPath.toLowerCase().includes(needle),
    );
  }, [forgeCandidates, search]);

  function handleImportForge(candidate: AvailableForgeRepo) {
    setImportingPath(candidate.gitSource);
    createMutation.mutate(
      {
        name: candidate.fullPath,
        gitSource: candidate.gitSource,
        forge: candidate.forge,
      },
      {
        onSuccess: () => {
          toast.success(`已导入 ${candidate.fullPath}`);
          setImportingPath(null);
        },
        onError: (error) => {
          setImportingPath(null);
          toast.error(`导入失败：${error.message}`);
        },
      },
    );
  }

  // Distinguish the failure modes honestly (task 14.2). A PAT signal (401/403)
  // prompts a settings-side token refresh; everything else is a transient/unknown
  // listing error. An empty-but-successful list is NOT an error.
  const fetchError = githubRepos.error;
  const needsPat =
    fetchError instanceof ApiError &&
    (fetchError.status === 401 || fetchError.status === 403);

  const isGithub = source === "github";
  const showEmptyState = !armed;
  const showLoadingState = armed && isGithub && githubRepos.isLoading;
  const showError = armed && isGithub && !githubRepos.isLoading && fetchError != null;
  const showList =
    armed && isGithub && !githubRepos.isLoading && fetchError == null && candidates.length > 0;
  const showNoRepos =
    armed && isGithub && !githubRepos.isLoading && fetchError == null && candidates.length === 0;

  // forge (gitlab/gitee) source states.
  const forgeError = forgeRepos.error;
  const showForgeLoading = armed && !isGithub && forgeRepos.isLoading;
  const showForgeError = armed && !isGithub && !forgeRepos.isLoading && forgeError != null;
  const showForgeList =
    armed && !isGithub && !forgeRepos.isLoading && forgeError == null && forgeCandidates.length > 0;
  const showForgeNone =
    armed && !isGithub && !forgeRepos.isLoading && forgeError == null && forgeCandidates.length === 0;

  const SOURCES: ReadonlyArray<{ kind: ForgeKind; label: string }> = [
    { kind: "github", label: "GitHub" },
    { kind: "gitlab", label: "GitLab" },
    { kind: "gitee", label: "Gitee" },
  ];

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
              使用设置中的 GitHub PAT 拉取可访问仓库，只把明确选择的项目加入远端调度池。
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
          {/* Source switcher (add-multi-forge-task-delivery) */}
          <div
            className="flex gap-1.5 pt-1"
            role="tablist"
            aria-label="选择导入来源"
          >
            {SOURCES.map((s) => (
              <button
                key={s.kind}
                type="button"
                role="tab"
                aria-selected={source === s.kind}
                onClick={() => {
                  setSource(s.kind);
                  setSearch("");
                }}
                className={`inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium ${
                  source === s.kind
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

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
                同步只读取仓库名称、默认分支和更新时间；PAT 只在服务端使用，不会返回浏览器。
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
                {needsPat ? "需要 GitHub PAT" : "拉取失败"}
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-foreground">
                {needsPat
                  ? "GitHub PAT 未连接、已失效或权限不足，请在设置「代码托管连接」中连接后再同步仓库列表。"
                  : "暂时无法读取 GitHub 仓库列表，请稍后重试。"}
              </p>
              <button
                type="button"
                onClick={() => void githubRepos.refetch()}
                className="inline-flex h-9 w-fit min-w-[180px] items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
              >
                重试同步
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
          {/* Forge (gitlab/gitee) source: loading / not-connected / none / list */}
          {showForgeLoading ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                正在拉取
              </StatusPill>
              <p className="m-0 font-mono text-xs leading-[1.55] text-muted-foreground">
                GET /settings/forges/repos?kind={source}
              </p>
            </div>
          ) : null}

          {showForgeError ? (
            <div
              role="alert"
              className="grid gap-3 rounded-lg bg-[#fff1f0] p-[18px] shadow-ring"
            >
              <StatusPill variant="danger" className="justify-self-start">
                未连接
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-foreground">
                请先在「设置 · 代码托管连接」中连接{" "}
                {source === "gitlab" ? "GitLab" : "Gitee"}，再拉取仓库列表。
              </p>
            </div>
          ) : null}

          {showForgeNone ? (
            <div className="grid gap-3 rounded-lg bg-[#fafafa] p-[18px] shadow-ring">
              <StatusPill variant="neutral" className="justify-self-start">
                没有可导入仓库
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                当前账号下没有可导入的仓库。
              </p>
            </div>
          ) : null}

          {showForgeList ? (
            <div className="grid gap-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <label className="m-0 grid gap-2">
                  <span className="text-[13px] font-semibold text-ink">
                    筛选仓库
                  </span>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="输入仓库名"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <CountChip className="self-end">
                  {visibleForge.length} 个可导入
                </CountChip>
              </div>

              <RepoListHead />

              {visibleForge.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  没有匹配的仓库。
                </p>
              ) : (
                <div data-available-repo-list>
                  {visibleForge.map((candidate) => {
                    const imported = importedGitSources.has(candidate.gitSource);
                    const importing = importingPath === candidate.gitSource;
                    return (
                      <RepoRow
                        key={candidate.gitSource}
                        name={
                          candidate.fullPath.split("/").pop() ?? candidate.fullPath
                        }
                        fullName={candidate.fullPath}
                        policy={
                          <p className="m-0 truncate">{candidate.visibility}</p>
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
                              disabled={createMutation.isPending}
                              onClick={() => handleImportForge(candidate)}
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
