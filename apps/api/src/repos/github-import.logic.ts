/**
 * Pure decision logic for the GitHub-import track (be-github-import, 4.2 / 4.4 / 4.5).
 *
 * Everything in this module is a PURE function of its inputs — no NestJS, no
 * Prisma, no `fetch`, no `process.env`. The network call and persistence live in
 * the service/client; the security- and correctness-critical decisions live here
 * so the verify phase can unit-test them in isolation under plain `node`:
 *
 *   - {@link classifyGithubListError} — maps a `GET /user/repos` outcome to a
 *     DISTINCT failure mode (auth-required vs retry-able) without ever treating
 *     an empty-but-successful listing as a failure (4.2).
 *   - {@link githubDedupKey} / {@link findExistingImport} — de-duplicate imports
 *     on the immutable GitHub numeric id (full_name fallback), never the mutable
 *     display name (4.4).
 *   - {@link reconcileAvailableRepos} — marks available entries already imported
 *     so the console can reconcile the live list against platform Repos (4.4).
 *   - {@link validateSetDefaultTarget} — rejects defaulting to an un-imported /
 *     available-only repo and identifies the prior default to clear (4.5).
 */

import type { GithubListErrorCode } from '@cap/contracts';

// ---------------------------------------------------------------------------
// 4.2 — GitHub listing error classification
// ---------------------------------------------------------------------------

/**
 * The minimal view of a `GET /user/repos` outcome the classifier needs. The
 * caller fills this from the real `fetch` result (or a thrown transport error);
 * keeping it a plain record lets the verify phase drive every branch directly.
 */
export interface GithubListOutcome {
  /**
   * `true` when the operator has NO stored GitHub OAuth token at all. A missing
   * credential is the same operator-facing signal as an expired/revoked one:
   * GitHub authorization is required.
   */
  readonly tokenMissing?: boolean;
  /**
   * The HTTP status GitHub returned, when the request reached GitHub and got a
   * response. `undefined` for a network/transport failure (no response).
   */
  readonly status?: number;
  /**
   * `true` when the request never produced an HTTP response (DNS/connect/socket
   * error). Always classified retry-able.
   */
  readonly networkError?: boolean;
}

/**
 * A classified GitHub-listing failure. `null` is NOT returned here — the caller
 * only invokes this once it already knows the listing did not succeed; a
 * successful listing (even an empty one) never reaches the classifier.
 *
 * `retryable` is `true` only for {@link GithubListErrorCode} `github_unavailable`
 * so the API layer can map it to a 429/5xx; `github_auth_required` is a terminal
 * "(re)authorize GitHub" signal, never retried as-is.
 */
export interface ClassifiedGithubListError {
  readonly code: GithubListErrorCode;
  readonly retryable: boolean;
}

/**
 * Classifies a failed `GET /user/repos` outcome into the auth-required vs
 * retry-able buckets (4.2), keeping the two modes distinct:
 *
 *  - no stored token OR a 401 (token expired/revoked) OR a 403 that is NOT a
 *    rate-limit  →  `github_auth_required` (non-retryable; prompt re-authorize);
 *  - 429, any 5xx, a 403 rate-limit, or a network error  →  `github_unavailable`
 *    (retryable; surface as 429/5xx);
 *  - any other unexpected status defaults to retry-able `github_unavailable`
 *    rather than masquerading as an auth problem.
 *
 * An empty-but-successful listing must NOT be passed here; that is a normal `[]`.
 */
export function classifyGithubListError(
  outcome: GithubListOutcome,
): ClassifiedGithubListError {
  // No credential stored at all: identical operator signal to expired/revoked.
  if (outcome.tokenMissing) {
    return { code: 'github_auth_required', retryable: false };
  }

  // No HTTP response: transport/network problem is always retry-able.
  if (outcome.networkError || outcome.status === undefined) {
    return { code: 'github_unavailable', retryable: true };
  }

  const status = outcome.status;

  // 401: the token is present but rejected (expired/revoked) -> re-authorize.
  if (status === 401) {
    return { code: 'github_auth_required', retryable: false };
  }

  // 403: ambiguous. GitHub uses 403 for BOTH a rate-limit (retry-able) and an
  // insufficient/revoked-scope authorization (re-authorize). A rate-limit 403 is
  // distinguished by exhaustion headers, surfaced via `isRateLimited`.
  if (status === 403) {
    return isRateLimited(outcome)
      ? { code: 'github_unavailable', retryable: true }
      : { code: 'github_auth_required', retryable: false };
  }

  // 429 (explicit rate limit) and any 5xx outage are retry-able.
  if (status === 429 || status >= 500) {
    return { code: 'github_unavailable', retryable: true };
  }

  // Any other unexpected status: fail safe to retry-able rather than claiming a
  // (possibly wrong) auth problem that would force a needless re-authorize.
  return { code: 'github_unavailable', retryable: true };
}

/**
 * Whether a 403 outcome is a rate-limit (vs an authorization failure). GitHub
 * signals primary rate-limit exhaustion with `x-ratelimit-remaining: 0` and/or a
 * `retry-after` header; either marks the 403 retry-able. Header lookups are
 * case-insensitive. Optional `rateLimited` short-circuits for callers that have
 * already decided.
 */
function isRateLimited(
  outcome: GithubListOutcome & {
    readonly rateLimited?: boolean;
    readonly headers?: Record<string, string | undefined>;
  },
): boolean {
  if (typeof outcome.rateLimited === 'boolean') {
    return outcome.rateLimited;
  }
  const headers = outcome.headers;
  if (!headers) {
    return false;
  }
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  if (typeof lower['retry-after'] === 'string' && lower['retry-after'].length > 0) {
    return true;
  }
  return lower['x-ratelimit-remaining'] === '0';
}

// ---------------------------------------------------------------------------
// 4.4 — De-duplication keyed on the originating GitHub identity
// ---------------------------------------------------------------------------

/**
 * The de-dup identity of a GitHub repo, as persisted on a platform `Repo`'s
 * `githubId` column. The PRIMARY key is the immutable numeric id, namespaced
 * (`gh:<id>`) so it can never collide with a free-text `full_name`. The
 * `full_name` is kept only as a FALLBACK match for legacy rows that recorded the
 * slug instead of the numeric id. The mutable display `name` is NEVER a key.
 */
export interface GithubRepoIdentity {
  readonly id: number;
  readonly full_name: string;
}

/** The `gh:` prefix namespacing a numeric de-dup key so it can't collide with a slug. */
const DEDUP_KEY_PREFIX = 'gh:';

/** The canonical, namespaced de-dup key for a GitHub repo's numeric id. */
export function githubDedupKey(id: number): string {
  return `${DEDUP_KEY_PREFIX}${id}`;
}

/** Whether a stored `githubId` is a namespaced numeric key (vs a legacy slug). */
function isNamespacedKey(githubId: string): boolean {
  return githubId.startsWith(DEDUP_KEY_PREFIX);
}

/** A platform `Repo` row, reduced to the fields de-dup needs to compare. */
export interface ImportedRepoRef {
  readonly id: string;
  /** The persisted `githubId` value (namespaced numeric key, or a legacy slug). */
  readonly githubId: string | null;
}

/**
 * Finds the existing platform Repo that already represents `identity`, or `null`
 * when none does. Matches the namespaced numeric key FIRST (the canonical key),
 * then falls back to a raw `full_name` slug match for legacy rows. Crucially this
 * NEVER matches on display name, so renaming a repo on GitHub (or on the
 * platform) cannot defeat de-duplication.
 */
export function findExistingImport(
  identity: GithubRepoIdentity,
  imported: readonly ImportedRepoRef[],
): ImportedRepoRef | null {
  const key = githubDedupKey(identity.id);
  for (const repo of imported) {
    if (repo.githubId === key) {
      return repo;
    }
  }
  // Fallback: a LEGACY row that stored the raw slug rather than the namespaced
  // numeric key. Namespaced rows are excluded so a new repo whose full_name is
  // coincidentally shaped like `gh:<n>` can never false-positive against a
  // numeric key (the numeric-id match above is the only path for those).
  for (const repo of imported) {
    if (
      repo.githubId !== null &&
      !isNamespacedKey(repo.githubId) &&
      repo.githubId === identity.full_name
    ) {
      return repo;
    }
  }
  return null;
}

/** An available GitHub repo annotated with whether it is already imported. */
export interface ReconciledAvailableRepo {
  readonly id: number;
  readonly full_name: string;
  /** `true` when an imported platform Repo already represents this GitHub repo. */
  readonly imported: boolean;
  /** The platform Repo id when imported, else `null`. */
  readonly importedRepoId: string | null;
}

/**
 * Reconciles the live available list against the platform's imported Repos so
 * the console can mark which entries are "already imported" (4.4). Pure: returns
 * a parallel annotation keyed via {@link findExistingImport}, never mutating the
 * inputs.
 */
export function reconcileAvailableRepos(
  available: readonly GithubRepoIdentity[],
  imported: readonly ImportedRepoRef[],
): ReconciledAvailableRepo[] {
  return available.map((repo) => {
    const existing = findExistingImport(repo, imported);
    return {
      id: repo.id,
      full_name: repo.full_name,
      imported: existing !== null,
      importedRepoId: existing?.id ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// 4.5 — Single-default selection validation
// ---------------------------------------------------------------------------

/** A platform Repo reduced to what default-selection validation inspects. */
export interface DefaultCandidateRepo {
  readonly id: string;
  /** Imported-from-GitHub provenance: a non-null `githubId` means imported. */
  readonly githubId: string | null;
  /** Whether this Repo is currently flagged default. */
  readonly isDefault: boolean;
}

/** The outcome of validating a set-default request against the Repo inventory. */
export type SetDefaultDecision =
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'not_imported' }
  | {
      readonly ok: true;
      /** The Repo id to set `isDefault = true`. */
      readonly targetId: string;
      /**
       * Repo ids currently flagged default that must be cleared so AT MOST ONE
       * Repo is the default after the operation. Excludes the target. Usually 0
       * or 1 entries, but tolerates a (defensive) multi-default starting state.
       */
      readonly clearIds: readonly string[];
      /** `true` when the target was already the default (idempotent no-op-ish). */
      readonly alreadyDefault: boolean;
    };

/**
 * Validates a set-default request (4.5):
 *
 *  - the target Repo must EXIST (`not_found` otherwise);
 *  - it must be an IMPORTED Repo — a non-null `githubId`. An available-only repo
 *    that was never imported has no Repo row (caught as `not_found`) or, if a
 *    plain `gitSource` repo is targeted, is rejected `not_imported`. Imported
 *    Repos stay the only source of truth for task-creation selection;
 *  - on success, returns the target plus every OTHER currently-default Repo id to
 *    clear, guaranteeing at most one default after the write (new default clears
 *    prior).
 *
 * Pure: the service performs the actual transactional write from this decision.
 */
export function validateSetDefaultTarget(
  targetRepoId: string,
  repos: readonly DefaultCandidateRepo[],
): SetDefaultDecision {
  const target = repos.find((r) => r.id === targetRepoId);
  if (!target) {
    return { ok: false, reason: 'not_found' };
  }
  // Only an imported Repo (non-null githubId) may be defaulted; reject a plain
  // gitSource repo or an available-only entry.
  if (target.githubId === null) {
    return { ok: false, reason: 'not_imported' };
  }
  const clearIds = repos
    .filter((r) => r.isDefault && r.id !== target.id)
    .map((r) => r.id);
  return {
    ok: true,
    targetId: target.id,
    clearIds,
    alreadyDefault: target.isDefault,
  };
}

/**
 * Picks the single current default from the Repo inventory, or `null` when none
 * is flagged (4.5 read-back). If more than one is (defensively) flagged, the
 * FIRST is returned deterministically; the write path keeps this to at most one.
 */
export function pickDefaultRepo<T extends { readonly isDefault: boolean }>(
  repos: readonly T[],
): T | null {
  return repos.find((r) => r.isDefault) ?? null;
}
