import { Injectable, Logger } from '@nestjs/common';
import type { AvailableGithubRepo } from '@cap/contracts';
import {
  classifyGithubListError,
  type ClassifiedGithubListError,
  type GithubListOutcome,
} from './github-import.logic';

/**
 * GitHub `GET /user/repos` HTTP boundary (be-github-import, 4.1 / 4.2).
 *
 * Owns the single network interaction this track makes: listing the repositories
 * the REQUESTING operator can access, using THAT operator's OWN stored OAuth
 * token. The token is passed in by the service (read from the operator's User
 * row) and is used only as the `Authorization` bearer here — it is NEVER logged,
 * echoed, or returned toward the browser.
 *
 * The transport here is deliberately thin: it performs the call, normalises the
 * outcome into a {@link GithubListOutcome}, and on failure delegates to the PURE
 * {@link classifyGithubListError} so the auth-required vs retry-able distinction
 * (4.2) is decided by unit-testable logic, not buried in this I/O layer.
 */

/** GitHub REST endpoint listing the authenticated user's repositories. */
const USER_REPOS_ENDPOINT = 'https://api.github.com/user/repos';

/** A successful listing (possibly empty — empty is NOT an error). */
export interface GithubListSuccess {
  readonly ok: true;
  readonly repos: AvailableGithubRepo[];
}

/** A classified listing failure (auth-required or retry-able). */
export interface GithubListFailure {
  readonly ok: false;
  readonly error: ClassifiedGithubListError;
}

export type GithubListResult = GithubListSuccess | GithubListFailure;

/** Raw shape of a single repo object from GitHub `GET /user/repos`. */
interface GithubApiRepo {
  id?: number;
  full_name?: string;
  name?: string;
  default_branch?: string;
  private?: boolean;
  visibility?: string;
  description?: string | null;
}

@Injectable()
export class GithubReposClient {
  private readonly logger = new Logger(GithubReposClient.name);

  /**
   * Lists the operator's GitHub repositories with THEIR OWN access token.
   *
   * - `accessToken === null` (operator has no stored token) short-circuits to a
   *   `github_auth_required` failure WITHOUT any network call — a missing
   *   credential is the same operator signal as an expired/revoked one.
   * - On a non-OK GitHub response or a thrown transport error, the outcome is
   *   normalised and run through {@link classifyGithubListError} so the failure
   *   mode is distinct and (when retry-able) cause-preserving.
   * - A 2xx with zero repos returns `{ ok: true, repos: [] }` — empty-but-
   *   successful is never conflated with failure.
   */
  async listForOperator(accessToken: string | null): Promise<GithubListResult> {
    if (accessToken === null || accessToken.length === 0) {
      return { ok: false, error: classifyGithubListError({ tokenMissing: true }) };
    }

    let response: Response;
    try {
      response = await fetch(
        `${USER_REPOS_ENDPOINT}?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'cap-orchestrator',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
    } catch (cause) {
      // Network/transport failure: no HTTP response. Retry-able, cause preserved.
      this.logger.warn(
        `GitHub /user/repos transport error: ${
          cause instanceof Error ? cause.message : 'unknown'
        }`,
      );
      return { ok: false, error: classifyGithubListError({ networkError: true }) };
    }

    if (!response.ok) {
      const outcome: GithubListOutcome & {
        headers: Record<string, string | undefined>;
      } = {
        status: response.status,
        headers: {
          'retry-after': response.headers.get('retry-after') ?? undefined,
          'x-ratelimit-remaining':
            response.headers.get('x-ratelimit-remaining') ?? undefined,
        },
      };
      const error = classifyGithubListError(outcome);
      // Log the status + classified mode, never the token.
      this.logger.warn(
        `GitHub /user/repos failed: HTTP ${response.status} -> ${error.code}`,
      );
      return { ok: false, error };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A 2xx with an unparseable body is treated as a retry-able outage.
      return { ok: false, error: classifyGithubListError({ status: 502 }) };
    }

    const rawList: GithubApiRepo[] = Array.isArray(payload)
      ? (payload as GithubApiRepo[])
      : [];

    // Normalise each repo to the contracts AvailableGithubRepo shape, dropping
    // any malformed entries (missing id/full_name) rather than failing the whole
    // list. An empty result here is a legitimate "no repos", NOT an error.
    const repos = rawList.flatMap((r) => this.toAvailable(r));
    return { ok: true, repos };
  }

  /** Maps a raw GitHub repo to the contracts shape, or `[]` when malformed. */
  private toAvailable(r: GithubApiRepo): AvailableGithubRepo[] {
    if (
      typeof r.id !== 'number' ||
      !Number.isInteger(r.id) ||
      r.id <= 0 ||
      typeof r.full_name !== 'string' ||
      r.full_name.length === 0
    ) {
      return [];
    }
    const name =
      typeof r.name === 'string' && r.name.length > 0
        ? r.name
        : r.full_name.split('/').pop() ?? r.full_name;
    const defaultBranch =
      typeof r.default_branch === 'string' && r.default_branch.length > 0
        ? r.default_branch
        : 'main';
    // Prefer explicit `visibility`; fall back to the `private` boolean.
    const visibility =
      r.visibility === 'private' || r.visibility === 'public'
        ? r.visibility
        : r.private
          ? 'private'
          : 'public';
    return [
      {
        id: r.id,
        full_name: r.full_name,
        name,
        defaultBranch,
        visibility,
        description: typeof r.description === 'string' ? r.description : null,
      },
    ];
  }
}
