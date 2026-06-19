import { Injectable, Logger } from '@nestjs/common';
import {
  degradedUpdateStatus,
  isNewer,
  UNKNOWN_VERSION_VALUE,
  VERSION_ENV_VARS,
  type UpdateStatus,
} from '@cap/contracts';

/**
 * The default repo whose GitHub Releases are checked when `GITHUB_RELEASES_REPO`
 * is not set (design D3). A self-hoster who cuts their own releases points the
 * env at their fork.
 */
export const DEFAULT_RELEASES_REPO = 'Xeonice/cloud-agent-platform';

/** The env var naming the `owner/repo` whose latest Release is compared (design D3). */
export const RELEASES_REPO_ENV = 'GITHUB_RELEASES_REPO';

/**
 * The default release-lookup upstream base URL (mirror-release-checks-via-worker D4).
 * Defaults to cap's public cache-only mirror Worker, which transparently proxies
 * GitHub's `releases/latest` and serves it from the CF edge cache — so the fleet's
 * update checks converge onto one cached upstream and survive a GitHub blip within
 * the cache window. A self-hoster who wants a fully-direct, zero-dependency lookup
 * sets {@link RELEASES_API_BASE_ENV} back to `https://api.github.com`. A fork that
 * cuts its own releases changes this single constant (or sets the env).
 */
export const DEFAULT_RELEASES_API_BASE = 'https://releases.cap.douglasdong.com';

/** Env var overriding the release-lookup upstream base — the escape hatch to direct GitHub. */
export const RELEASES_API_BASE_ENV = 'GITHUB_API_BASE';

/**
 * Resolve the release-lookup upstream base: the {@link RELEASES_API_BASE_ENV} env
 * (trimmed, trailing slash(es) stripped) when non-blank, else
 * {@link DEFAULT_RELEASES_API_BASE}. Changing it moves ONLY the host the lookup
 * targets — the request path, headers, caching, and honest-degrade are unchanged.
 */
export function resolveReleasesApiBase(
  env: Record<string, string | undefined>,
): string {
  const raw = env[RELEASES_API_BASE_ENV];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, '');
  }
  return DEFAULT_RELEASES_API_BASE;
}

/**
 * Default in-process cache TTL for the upstream GitHub Release lookup (5 min,
 * responsive-update-check D1). One fetch per TTL is shared across all browsers/
 * requests so GitHub's anonymous rate limit (60/hr) is respected — 5 min ⇒
 * ≤12 fetches/hr. Overridable via {@link CACHE_TTL_ENV_VAR} (clamped to
 * {@link MIN_CACHE_TTL_MS}), or for tests via {@link UpdateStatusOptions.cacheTtlMs}.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Floor for the env-configured cache TTL (60s). Keeps the shared upstream fetch
 * at ≤60/hr — GitHub's anonymous rate limit — so a misconfigured low value can
 * never exceed it. The test-only {@link UpdateStatusOptions.cacheTtlMs} bypasses
 * this floor so tests can drive sub-second TTLs.
 */
export const MIN_CACHE_TTL_MS = 60 * 1000;

/** Env var (ms) overriding {@link DEFAULT_CACHE_TTL_MS}, clamped to the floor. */
export const CACHE_TTL_ENV_VAR = 'UPDATE_CHECK_CACHE_TTL_MS';

/**
 * Resolve the effective cache TTL: an explicit option (tests; no floor) wins;
 * else the {@link CACHE_TTL_ENV_VAR} env value clamped to {@link MIN_CACHE_TTL_MS};
 * else {@link DEFAULT_CACHE_TTL_MS}. An unset/invalid env falls back to the default.
 */
export function resolveCacheTtlMs(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const raw = env[CACHE_TTL_ENV_VAR];
  const parsed = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(parsed, MIN_CACHE_TTL_MS);
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * The single GitHub Release fact the comparison needs: the tag plus the
 * changelog link/name. `null` means "no latest Release" (degraded), distinct
 * from a fetch failure (also degraded). Pure data; no GitHub API shape leaks out.
 */
export interface LatestRelease {
  /** The Release tag (e.g. `v1.2.3`); compared against `CAP_VERSION`. */
  tag: string;
  /** The Release HTML URL (changelog link), or null when GitHub omits it. */
  url: string | null;
  /** The Release display name, or null when GitHub omits it. */
  name: string | null;
}

/**
 * Fetches the LATEST published Release for `owner/repo`, or `null` when there is
 * no published Release (404 / empty). MUST resolve `null` rather than reject for
 * the "no releases / private / unreachable" case so the service degrades
 * honestly; it MAY reject only on an unexpected transport error (the service
 * catches that too). Injectable so the test substitutes a deterministic fetcher.
 * The optional `apiBase` is the resolved upstream base (the cache mirror or direct
 * GitHub); the default fetcher builds its request against it.
 */
export type ReleaseFetcher = (
  repo: string,
  apiBase?: string,
) => Promise<LatestRelease | null>;

/** Construction-time tunables (cache TTL, clock, fetcher) — all defaulted. */
export interface UpdateStatusOptions {
  /** Cache TTL in ms; defaults to {@link DEFAULT_CACHE_TTL_MS}. */
  cacheTtlMs?: number;
  /** Clock source; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
  /** Release fetcher; defaults to {@link fetchLatestGithubRelease}. */
  fetcher?: ReleaseFetcher;
  /** Env source; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

interface CacheEntry {
  /** The resolved latest Release (or null = no releases), captured at fetch time. */
  release: LatestRelease | null;
  /** Epoch ms the entry was stored; the TTL is measured from here. */
  storedAt: number;
  /** ISO 8601 timestamp the upstream lookup was performed (becomes `checkedAt`). */
  checkedAtIso: string;
}

/**
 * Best-effort, cached update-availability check (update-availability-check,
 * Phase 2 / design D1+D2).
 *
 * It performs ONE GitHub Release lookup per TTL (shared across all callers) and
 * compares the latest tag against the running `CAP_VERSION` via the contract's
 * pure {@link isNewer} predicate — the single source of comparison truth. The
 * lookup is BEST-EFFORT: a failure (or no releases / unknown current) yields a
 * {@link degradedUpdateStatus} (`updateAvailable: false`, `latestVersion: null`),
 * never a throw and never a fabricated prompt. `updateAvailable` is `true` ONLY
 * when current is known, a latest Release exists, and latest > current.
 */
@Injectable()
export class UpdateStatusService {
  private readonly log = new Logger(UpdateStatusService.name);
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly fetcher: ReleaseFetcher;
  private readonly env: Record<string, string | undefined>;
  /** The resolved release-lookup upstream base (cache mirror by default, or direct GitHub). */
  private readonly releasesApiBase: string;

  /** The cached latest-Release lookup; one entry shared across all requests. */
  private cache: CacheEntry | null = null;
  /** In-flight lookup, so concurrent requests within the TTL coalesce to one fetch. */
  private inFlight: Promise<CacheEntry> | null = null;

  constructor(options: UpdateStatusOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetchLatestGithubRelease;
    this.env = options.env ?? process.env;
    // responsive-update-check D1 — explicit option (tests) wins; else the env
    // value clamped to the floor; else the short default. Resolved after `env`.
    this.cacheTtlMs = resolveCacheTtlMs(options.cacheTtlMs, this.env);
    // mirror-release-checks-via-worker D4 — resolve the upstream base from env
    // (default = the cache mirror; escape hatch = api.github.com). Resolved after `env`.
    this.releasesApiBase = resolveReleasesApiBase(this.env);
  }

  /** The configured `owner/repo`, defaulting to the cap repo (design D3). */
  private repo(): string {
    const raw = this.env[RELEASES_REPO_ENV];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
    return DEFAULT_RELEASES_REPO;
  }

  /** The running `CAP_VERSION`, or the `"unknown"` sentinel for a source build. */
  private currentVersion(): string {
    const raw = this.env[VERSION_ENV_VARS.version];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
    return UNKNOWN_VERSION_VALUE;
  }

  /**
   * Builds the {@link UpdateStatus}, fetching the latest Release through the TTL
   * cache. Best-effort: any failure degrades honestly (never throws). The
   * comparison is delegated entirely to the contract's {@link isNewer}.
   */
  async getStatus(): Promise<UpdateStatus> {
    const current = this.currentVersion();
    const entry = await this.loadLatestRelease();
    const checkedAt = entry?.checkedAtIso ?? new Date(this.now()).toISOString();

    // No latest Release (none published / unreachable / fetch failed) → degraded.
    const release = entry?.release ?? null;
    if (release === null) {
      return degradedUpdateStatus(current, checkedAt);
    }

    // A latest Release exists; isNewer guards the unknown-current + unparseable
    // cases, so updateAvailable is true ONLY for a genuinely newer known version.
    const updateAvailable = isNewer(release.tag, current);
    if (!updateAvailable) {
      // Up-to-date (or current unknown / tag unparseable): still surface the
      // latest tag + link honestly, but no prompt.
      return {
        currentVersion: current,
        latestVersion: release.tag,
        updateAvailable: false,
        releaseUrl: release.url,
        releaseName: release.name,
        checkedAt,
      };
    }

    return {
      currentVersion: current,
      latestVersion: release.tag,
      updateAvailable: true,
      releaseUrl: release.url,
      releaseName: release.name,
      checkedAt,
    };
  }

  /**
   * Returns the cached latest-Release entry, refreshing it through the fetcher
   * when the cache is empty or past its TTL. Concurrent callers within the TTL
   * coalesce onto a single in-flight fetch. A fetch error is swallowed here (the
   * caller degrades): it resolves a `release: null` entry and does NOT cache the
   * failure, so a transient outage is retried on the next request.
   */
  private async loadLatestRelease(): Promise<CacheEntry> {
    const now = this.now();
    if (this.cache && now - this.cache.storedAt < this.cacheTtlMs) {
      return this.cache;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const repo = this.repo();
    this.inFlight = (async (): Promise<CacheEntry> => {
      const checkedAtIso = new Date(this.now()).toISOString();
      try {
        const release = await this.fetcher(repo, this.releasesApiBase);
        const entry: CacheEntry = { release, storedAt: this.now(), checkedAtIso };
        this.cache = entry;
        return entry;
      } catch (err) {
        // Best-effort: a fetch failure degrades, never throws. Do NOT cache the
        // failure so the next request retries; return a transient null entry.
        this.log.warn(
          `update-status: latest-release lookup for ${repo} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { release: null, storedAt: this.now(), checkedAtIso };
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}

/** GitHub `releases/latest` user-agent — GitHub requires one or returns 403. */
const GITHUB_USER_AGENT = 'cap-update-check';

/**
 * Default {@link ReleaseFetcher}: queries the configured upstream base (`apiBase`,
 * defaulting to the cache mirror) for the latest published Release of `owner/repo`,
 * hitting `{apiBase}/repos/{repo}/releases/latest`. Returns `null` for "no published
 * Release" (HTTP 404) or a private/unreachable repo (any non-OK status), so those
 * degrade honestly rather than throwing. A network/transport error rejects and is
 * caught by the service. Uses the global `fetch` (Node 18+); no new dependency.
 */
export async function fetchLatestGithubRelease(
  repo: string,
  apiBase: string = DEFAULT_RELEASES_API_BASE,
): Promise<LatestRelease | null> {
  const url = `${apiBase}/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': GITHUB_USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  // 404 = no published Release; 401/403 = private/rate-limited → "no info" honestly.
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    name?: unknown;
  };
  const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
  if (tag.length === 0) {
    return null;
  }
  return {
    tag,
    url: typeof body.html_url === 'string' && body.html_url.length > 0 ? body.html_url : null,
    name: typeof body.name === 'string' && body.name.length > 0 ? body.name : null,
  };
}
