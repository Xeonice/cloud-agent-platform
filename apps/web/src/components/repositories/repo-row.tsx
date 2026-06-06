/**
 * `RepoRow` — one `.repo-card` row of the `/repositories` resource list (Track
 * 14; task 14.1). Shared by the imported-repos panel AND the import dialog's
 * candidate list so the four-column row layout (仓库 / 权限与状态 / 同步 / 操作)
 * lives in exactly one place.
 *
 * A row is a 4-cell grid: a name cell (title line + `owner/name` mono slug, with
 * an optional 默认 badge), a policy/status cell (visibility/permission copy +
 * status pills), a sync cell (last-sync / branch line), and a right-aligned
 * action cell (the page supplies the action node — 设为默认 / 导入 / 已导入).
 *
 * SSR-safe: pure render off props. No window/clock/random.
 *
 * Fidelity (`.repo-import-workspace .repo-card` FINAL audit-refinement values):
 * grid `minmax(220,1fr) minmax(270,1.25fr) minmax(150,0.62fr) 104px`, gap 16,
 * min-h 88, padding 14/16, white, bottom hairline (last none), radius 0. Name
 * strong 14px ink; mono 12px; title-line status-pill 22px min-h. Policy cell
 * gap 6, p 13px muted. Sync cell gap 4 muted, small 12px. Action right-aligned.
 */
import * as React from "react";

import type { Repo } from "@cap/contracts";
import { cn } from "@/utils";

/**
 * Resolve a repo's `owner/name` display slug from its `gitSource` remote spec,
 * falling back to the plain name when no slug can be parsed. PURE — exported so
 * the page and dialog resolve the slug identically.
 */
export function repoFullName(repo: Pick<Repo, "gitSource" | "name">): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

export interface RepoRowProps {
  /** Primary display name (the short repo name). */
  name: React.ReactNode;
  /** The `owner/name` mono slug shown beneath the name. */
  fullName: React.ReactNode;
  /** Optional badge node rendered inline with the title (e.g. the 默认 pill). */
  titleBadge?: React.ReactNode;
  /** Policy / status cell content (visibility + permission copy / pills). */
  policy: React.ReactNode;
  /** Sync cell content (default branch / last-sync line). */
  sync: React.ReactNode;
  /** Right-aligned action cell content (a button or a disabled label). */
  action: React.ReactNode;
}

/** A single four-column repo row (`.repo-card`). */
export function RepoRow({
  name,
  fullName,
  titleBadge,
  policy,
  sync,
  action,
}: RepoRowProps) {
  return (
    <article
      data-slot="repo-row"
      className={cn(
        "grid min-h-[88px] items-center gap-4 border-b border-border bg-card px-4 py-3.5 last:border-b-0",
        "grid-cols-[minmax(0,1fr)] gap-y-3",
        "min-[821px]:grid-cols-[minmax(220px,1fr)_minmax(270px,1.25fr)_minmax(150px,0.62fr)_104px]",
      )}
    >
      {/* Name */}
      <div className="grid min-w-0 gap-[5px]">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="min-w-0 truncate text-sm text-foreground">{name}</strong>
          {titleBadge}
        </div>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {fullName}
        </span>
      </div>

      {/* Permission / status */}
      <div className="grid min-w-0 gap-1.5 text-[13px] text-muted-foreground">
        {policy}
      </div>

      {/* Sync */}
      <div className="grid min-w-0 gap-1 text-muted-foreground">{sync}</div>

      {/* Action */}
      <div className="flex min-w-0 justify-start min-[821px]:justify-end">
        {action}
      </div>
    </article>
  );
}

/** The shared four-column list-head (仓库 / 权限与状态 / 同步 / 操作). */
export function RepoListHead() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid gap-4 border-b border-border px-4 pt-2 pb-[9px]",
        "font-mono text-[11px] font-medium text-muted-foreground",
        "grid-cols-[minmax(220px,1fr)_minmax(270px,1.25fr)_minmax(150px,0.62fr)_104px]",
        "max-[820px]:hidden",
      )}
    >
      <span>仓库</span>
      <span>权限与状态</span>
      <span>同步</span>
      <span>操作</span>
    </div>
  );
}
