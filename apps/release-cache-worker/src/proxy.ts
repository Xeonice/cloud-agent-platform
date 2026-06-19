/**
 * Pure proxy logic for the release-check cache mirror — no Worker globals, no I/O,
 * so it is unit-testable from plain Node (see test/proxy.test.mjs). The Worker entry
 * (index.ts) wires these into a `fetch` handler with edge caching.
 */

/** GitHub REST origin the mirror proxies to. The Worker is a pure cache in front of this. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** Edge-cache TTL (seconds) for a successful release lookup; mirrors the api's minutes-scale cadence. */
export const CACHE_TTL_SECONDS = 300;

/**
 * Headers GitHub's REST API requires/recommends — it returns 403 without a
 * `User-Agent`. Forwarded verbatim on the upstream fetch.
 */
export const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'cap-release-cache-mirror',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * The path shape the mirror serves: GitHub's `releases/latest` for a well-formed
 * `owner/repo`, segments in `[A-Za-z0-9._-]`. The charset stays permissive because a
 * repo name may legitimately start with a dot (e.g. an org's `.github` repo). Anchored
 * start-to-end so there are no extra/empty segments; {@link parseReleasesPath} then
 * rejects a bare `.`/`..` segment as defense in depth (see there).
 */
const RELEASES_LATEST_PATH =
  /^\/repos\/(?<owner>[A-Za-z0-9._-]+)\/(?<repo>[A-Za-z0-9._-]+)\/releases\/latest$/;

/** A validated GitHub repository reference. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse a request pathname into a validated {@link RepoRef}, or `null` when it is not
 * the exact `releases/latest` shape. `null` MUST be treated as "reject without an
 * upstream fetch" by the caller.
 */
export function parseReleasesPath(pathname: string): RepoRef | null {
  const groups = RELEASES_LATEST_PATH.exec(pathname)?.groups;
  const owner = groups?.owner;
  const repo = groups?.repo;
  if (!owner || !repo) {
    return null;
  }
  // Defense in depth against path traversal. The sole caller passes a WHATWG-
  // normalized `new URL(...).pathname`, so `.`/`..` segments are already collapsed
  // before they reach the regex (verified: the live Worker 404s a raw
  // `/repos/../x/releases/latest`). Reject a bare dot/dot-dot segment anyway, so the
  // guarantee never silently depends on that normalization if the caller changes. A
  // LEADING dot (e.g. the `.github` repo) is legal and still accepted.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }
  return { owner, repo };
}

/** Build the GitHub upstream URL for a validated repo ref. */
export function buildUpstreamUrl(ref: RepoRef): string {
  return `${GITHUB_API_ORIGIN}/repos/${ref.owner}/${ref.repo}/releases/latest`;
}

/**
 * Cloudflare edge-cache policy for the upstream fetch. A 2xx caches for the full TTL;
 * a 404 ("no release yet") caches briefly since it can flip; a 5xx is NEVER cached
 * (`0`) so a transient GitHub error never sticks as the served answer.
 */
export function cacheCfOptions(): RequestInitCfProperties {
  return {
    cacheEverything: true,
    cacheTtl: CACHE_TTL_SECONDS,
    cacheTtlByStatus: {
      '200-299': CACHE_TTL_SECONDS,
      '300-399': 0,
      '404': 60,
      '500-599': 0,
    },
  };
}
