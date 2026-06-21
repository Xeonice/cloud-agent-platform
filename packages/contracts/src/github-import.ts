import { z } from 'zod';
import { RepoSchema } from './task.js';

/**
 * GitHub repository import contract (github-repository-import spec).
 *
 * Two distinct concepts live here, kept separate by design:
 *
 *  1. {@link AvailableGithubRepoSchema} — a live entry sourced from GitHub
 *     `GET /user/repos`, scoped to the requesting operator's GitHub account.
 *     This is NOT the platform's repository inventory; it is what the "仓库导入"
 *     import dialog lists. It carries the GitHub repo's stable identity so the
 *     console can reconcile it against already-imported platform `Repo` records.
 *
 *  2. {@link ImportRepoRequestSchema} — the selected GitHub repo identity the
 *     console sends to import that repo into the platform as a `Repo` record.
 *
 * The operator's GitHub OAuth access token is NEVER part of these shapes: the
 * `GET /user/repos` call happens server-side and the token never reaches the
 * browser.
 */

// ---------------------------------------------------------------------------
// GitHub repo visibility
// ---------------------------------------------------------------------------

/** A GitHub repository's visibility, as reported by the GitHub REST API. */
export const GithubRepoVisibilitySchema = z.enum(['public', 'private']);
export type GithubRepoVisibility = z.infer<typeof GithubRepoVisibilitySchema>;

// ---------------------------------------------------------------------------
// Available GitHub repository (live from GitHub GET /user/repos)
// ---------------------------------------------------------------------------

/**
 * A GitHub repository the authenticated operator can access, sourced live from
 * GitHub `GET /user/repos`. Carries the GitHub repo's stable identity (numeric
 * `id` and `full_name`) so imports can be de-duplicated and the console can mark
 * which entries are already imported. This is distinct from the platform's
 * imported `Repo` records and is never treated as the platform repo inventory.
 */
export const AvailableGithubRepoSchema = z.object({
  /** Stable GitHub numeric repository id. */
  id: z.number().int().positive(),
  /** Canonical `owner/name` slug from GitHub. */
  full_name: z.string().min(1),
  /** Short repository name (the `name` segment of `full_name`). */
  name: z.string().min(1),
  /** GitHub default branch name. */
  defaultBranch: z.string().min(1),
  /** Repository visibility (public/private). */
  visibility: GithubRepoVisibilitySchema,
  /** GitHub repo description, present only when GitHub reports one. */
  description: z.string().nullable().optional(),
});
export type AvailableGithubRepo = z.infer<typeof AvailableGithubRepoSchema>;

/** Response body for the list-available-GitHub-repositories endpoint. */
export const ListAvailableGithubReposResponseSchema = z.array(AvailableGithubRepoSchema);
export type ListAvailableGithubReposResponse = z.infer<
  typeof ListAvailableGithubReposResponseSchema
>;

// ---------------------------------------------------------------------------
// Import request (selected GitHub repo identity)
// ---------------------------------------------------------------------------

/**
 * Body accepted by the import endpoint: the selected GitHub repo's identity the
 * platform needs to create a `Repo` with GitHub-import provenance. The
 * orchestrator derives the platform `Repo`'s `name` and git source from these
 * fields and records the originating GitHub identity (`id` / `full_name`) so the
 * import can be de-duplicated and distinguished from a manually created repo.
 */
export const ImportRepoRequestSchema = z.object({
  /** Stable GitHub numeric repository id (primary de-duplication key). */
  id: z.number().int().positive(),
  /** Canonical `owner/name` slug; fallback de-duplication key and name source. */
  full_name: z.string().min(1),
  /** GitHub default branch, captured as import metadata on the created `Repo`. */
  defaultBranch: z.string().min(1),
  /** GitHub repo description, captured as import metadata when present. */
  description: z.string().nullable().optional(),
  /**
   * Source forge (add-multi-forge-task-delivery). Forge-neutral: the GitHub
   * import write records `github`; a GitLab/Gitee picker or by-URL import records
   * its own forge via `POST /repos` (`CreateRepoRequest.forge`). Optional here for
   * backward compatibility with the existing GitHub import body.
   */
  forge: z.enum(['github', 'gitlab', 'gitee']).optional(),
});
export type ImportRepoRequest = z.infer<typeof ImportRepoRequestSchema>;

// ---------------------------------------------------------------------------
// GitHub listing error signal (distinct failure modes for GET /user/repos)
// ---------------------------------------------------------------------------

/**
 * Why a server-side GitHub listing failed, kept DISTINCT from one another and
 * from an empty-but-successful result so the console never conflates them:
 *
 *  - `github_auth_required` — the operator's stored OAuth token is missing,
 *    expired, or revoked (GitHub answered 401/403 in a way that indicates the
 *    credential itself is bad). This is NOT a platform-session 401 and NOT an
 *    empty list: the console must prompt the operator to (re)authorize GitHub.
 *  - `github_unavailable` — a transient/retry-able condition: GitHub rate-limit
 *    (429), a 5xx outage, or a network/transport error. The originating cause is
 *    preserved so the API can surface a retry-able 429/5xx.
 *
 * A successful listing that simply returns zero repos is NOT an error and never
 * carries one of these codes.
 */
export const GithubListErrorCodeSchema = z.enum([
  'github_auth_required',
  'github_unavailable',
]);
export type GithubListErrorCode = z.infer<typeof GithubListErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Set-default-repo request (designate exactly one imported Repo as default)
// ---------------------------------------------------------------------------

/**
 * Body accepted by the set-default-repo endpoint: the platform `Repo` id to
 * designate as the single default for task-creation selection. The target MUST
 * be an already-imported `Repo` (an available-only GitHub repo is rejected);
 * designating a new default atomically clears any prior default so at most one
 * Repo is ever the default.
 */
export const SetDefaultRepoRequestSchema = z.object({
  /** Platform `Repo` id (uuid) to make the default. */
  repoId: z.string().uuid(),
});
export type SetDefaultRepoRequest = z.infer<typeof SetDefaultRepoRequestSchema>;

/**
 * Response body for reading the current default repo: the default {@link Repo}
 * under `repo`, or `null` when no imported Repo has been designated default yet.
 */
export const DefaultRepoResponseSchema = z.object({
  repo: RepoSchema.nullable(),
});
export type DefaultRepoResponse = z.infer<typeof DefaultRepoResponseSchema>;
