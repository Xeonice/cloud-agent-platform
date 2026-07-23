import { repoResponseSchema, type RepoResponse } from '@cap/contracts';

/**
 * The Prisma `Repo` columns every read path projects. Declared structurally (not
 * as the generated Prisma type) so callers can pass a narrowed `select` result.
 */
export interface RepoRowProjection {
  id: string;
  name: string;
  gitSource: string;
  createdAt: Date;
  description: string | null;
  defaultBranch: string | null;
  branchCount: number | null;
  updatedAt: Date | null;
  githubId: string | null;
  isDefault: boolean;
  forge?: string | null;
  /** add-repo-content-store: repo-store copy state (`missing` for legacy rows). */
  copyStatus?: string | null;
  copyUpdatedAt?: Date | null;
}

/**
 * Single shaping seam from a Prisma `Repo` row to the contracts response shape,
 * shared by the console repos service, the GitHub import service, and the
 * content-copy service so every repo read exposes the SAME fields.
 *
 * `createdAt`/`updatedAt`/`copyUpdatedAt` stay native `Date`s (the contracts
 * schema coerces dates); the HTTP boundary serializes them.
 *
 * add-repo-content-store: `copyStatus`/`copyUpdatedAt` are additive. A row read
 * through a narrowed `select` that omits them projects them as absent rather
 * than fabricating `ready`, and a row that predates the migration reads as
 * `missing` (the column default) — never as a copy that exists.
 */
export function repoRowToResponse(repo: RepoRowProjection): RepoResponse {
  return repoResponseSchema.parse({
    id: repo.id,
    name: repo.name,
    gitSource: repo.gitSource,
    createdAt: repo.createdAt,
    description: repo.description,
    defaultBranch: repo.defaultBranch,
    branchCount: repo.branchCount,
    updatedAt: repo.updatedAt,
    githubId: repo.githubId,
    // The single-default flag (be-github-import 4.5), surfaced on every read
    // path so the console can render which imported Repo is the default.
    isDefault: repo.isDefault,
    // add-multi-forge-task-delivery: the source forge (null for repos predating
    // multi-forge / unknown host), echoed so the console renders the source.
    forge: repo.forge ?? null,
    // add-repo-content-store: readiness of the repo-store bare mirror plus when
    // it was last materialized, so the console can render readiness + refresh
    // and task creation can gate on `ready`. A row without the column (a legacy
    // payload replayed in a test, never a live read after the migration) projects
    // as `missing`/null — the conservative truth "no copy is known to exist",
    // never a fabricated `ready`.
    copyStatus: repo.copyStatus ?? 'missing',
    copyUpdatedAt: repo.copyUpdatedAt ?? null,
  });
}
