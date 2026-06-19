## Context

`update-availability-check` already ships: `apps/api/src/update-status/update-status.service.ts`
fetches GitHub's `releases/latest` for `GITHUB_RELEASES_REPO`, caches it in-process
(5 min default, `UPDATE_CHECK_CACHE_TTL_MS`, 60 s floor) with in-flight coalescing,
compares against `CAP_VERSION`, and degrades honestly. `self-update.service.ts`
does NOT hit GitHub independently — it cross-checks against the same cached lookup,
so the *only* GitHub call site is `fetchLatestGithubRelease`.

That design already keeps a single instance under GitHub's anonymous 60/hr-per-IP
limit. The two motivations for this change (confirmed with the user) are NOT rate
limiting — GitHub limits per IP, so N instances = N independent budgets — but:
(1) **decouple update checks from GitHub availability** within a cache window, and
(2) **converge the fleet** onto one cached upstream. The chosen shape is a thin,
public, cache-only Cloudflare Worker; the instance points its release lookup at it.

Verified constraint (CF docs): Cloudflare edge caching (`caches.default` and the
`fetch` `cf.cacheTtl` option) is effectively a no-op on `*.workers.dev` — it needs
a real zone. The project already runs `douglasdong.com` on Cloudflare.

## Goals / Non-Goals

**Goals:**
- A pure cache layer: transparently proxy `releases/latest` and serve it via the CF
  edge cache, so the fleet's GitHub requests converge to ~cache-miss frequency.
- Immunity to GitHub blips *within the cache TTL window*.
- Zero change to the `/update-status` contract, `UpdateStatus` schema, operator
  guard, honest-degrade semantics, and `GITHUB_RELEASES_REPO`.
- A mandatory escape hatch so a self-hoster can stay fully direct/zero-dependency.

**Non-Goals:**
- stale-if-error / serve-last-good across GitHub outages longer than the TTL
  (would forfeit the pure-`cf.cacheTtl` simplicity — see Risks).
- Authenticated upstream (GH token / 5000/hr) — unneeded while hit-rate is high.
- Release gating, canary, rollback control, or install telemetry.
- Any auth on the Worker endpoint.

## Decisions

### D1 — Worker caches via `fetch(..., { cf: { cacheTtl } })`, not the Cache API
For a pure transparent proxy the `cf` object on the upstream `fetch` makes CF cache
the response directly (`cacheEverything`, `cacheTtl`, `cacheTtlByStatus`), collapsing
the Worker to ~15 lines with no manual `caches.default` match/put bookkeeping.
*Alternative — `caches.default`*: more boilerplate, only worth it if we later add
stale-if-error (manual last-good control). Deferred with that non-goal.

### D2 — Mirror GitHub's path verbatim: `GET /repos/{owner}/{repo}/releases/latest`
The Worker exposes the exact GitHub path, so the instance change is a host swap only
— `fetchLatestGithubRelease` keeps its path/headers and just reads a base URL.
*Alternative — custom `/latest?repo=`*: forces the instance to rebuild the path and
diverges from GitHub's shape for no benefit.

### D3 — Run behind a custom domain `releases.cap.douglasdong.com` (required)
Edge caching does not work on `workers.dev`, so the Worker MUST be bound to a route
on the CF zone. This is the load-bearing infra decision: without it the Worker is a
pass-through with no cache and the change achieves nothing.
*Alternative — `workers.dev`*: rejected; no caching.

### D4 — `GITHUB_API_BASE` env, defaulting to the mirror, with a direct escape hatch
`fetchLatestGithubRelease` reads `GITHUB_API_BASE` (trimmed, trailing-slash-normalized)
and builds `${base}/repos/${repo}/releases/latest`. The **default is the official
mirror** (`https://releases.cap.douglasdong.com`) so "full migration" is the
out-of-the-box behavior; setting `GITHUB_API_BASE=https://api.github.com` restores
direct GitHub. The default lives in one named constant (`DEFAULT_RELEASES_API_BASE`)
so a fork flips it in one line.
*Alternatives*: (a) default to `api.github.com`, official prod sets the env to the
mirror — more OSS-neutral but not the "full migration" the user asked for;
(b) hard-wire the mirror with no env — rejected, it violates the self-host
zero-dependency premise. We take the middle: mirror-by-default **plus** the escape
hatch. The OSS-neutrality cost of a maintainer domain as the default is called out
in Risks/Open Questions.

### D5 — Keep both cache layers; accept the additive lag
The instance in-proc TTL stays as-is; the Worker adds an edge TTL. A new Release is
visible after at most ~(instance TTL + Worker TTL). The instance layer also shields
the Worker from per-request fleet traffic. Update notification is not real-time, so
the additive lag is acceptable; no need to shrink the instance TTL.
*Alternative — drop instance TTL to 0/60 s*: unnecessary churn for a non-real-time
signal.

### D6 — Public, unauthenticated, with strict `owner/repo` validation
The Worker takes no auth (the data is anonymous-public). It MUST validate the path
matches `^/repos/[\w.-]+/[\w.-]+/releases/latest$` and reject anything else, so it
can never be coerced into proxying an arbitrary URL. Accepting any well-formed repo
(not a fixed allowlist) is deliberate: it preserves a self-hoster pointing
`GITHUB_RELEASES_REPO` at their own fork while still using the mirror.
*Alternatives*: endpoint auth (user declined); repo allowlist (breaks fork support).

### D7 — Short edge TTL with status-aware overrides
`cacheTtl` ~300 s for 2xx to match the instance cadence; `cacheTtlByStatus` keeps
404 short (~60 s, "no release yet" can flip) and 5xx uncached (`0`) so a transient
GitHub error is never cached as the answer. Tunable in `wrangler` config.

## Risks / Trade-offs

- **The Worker is a new single point of failure.** → Within the TTL it serves cache
  independent of GitHub. If the Worker itself is down, the instance degrades exactly
  as it does today when GitHub is unreachable (honest `updateAvailable: false`), and
  an operator can set `GITHUB_API_BASE=https://api.github.com` to bypass it entirely.
- **Centralized egress re-introduces a 60/hr ceiling at the Worker.** → Only matters
  on cache miss; with a healthy hit-rate misses are ≤ a handful/hr. If the single
  egress IP ever approaches 60/hr, add a GH token in the Worker (the deferred
  non-goal) to lift it to 5000/hr.
- **Additive cache lag** (D5). → Accepted; documented.
- **Open GitHub-Release proxy abuse.** → Strict `owner/repo` validation prevents
  arbitrary proxying; CF free tier (100k/day) absorbs casual abuse; WAF rate-limit
  is the fallback.
- **OSS-neutrality: the default points at a maintainer domain.** → Unconfigured
  self-hosters send update-check traffic to the maintainer's Worker. Mitigated by
  the one-line escape hatch (D4) and documenting it prominently. A fork changes
  `DEFAULT_RELEASES_API_BASE` (or sets the env) in one place.
- **`workers.dev` silently doesn't cache** (D3). → Bind the custom-domain route and
  verify a `cf-cache-status: HIT` on a second request before considering it done.

## Migration Plan

1. Deploy the Worker to `releases.cap.douglasdong.com` (custom-domain route on the CF
   zone). Verify it proxies correctly and that a repeat request reports
   `cf-cache-status: HIT`.
2. Ship the api change (`GITHUB_API_BASE`, default = mirror). New deploys check
   updates through the mirror automatically.
3. **Rollback**: set `GITHUB_API_BASE=https://api.github.com` on the api (no
   redeploy of the Worker needed); the lookup goes direct again. The Worker can be
   left running harmlessly.

## Open Questions

- **Worker location in the monorepo**: `apps/release-cache-worker/` (consistent with
  `apps/www` as an independent deploy unit) vs a top-level `workers/`. Lean
  `apps/release-cache-worker/`; settle at implementation.
- **Deploy automation**: first cut can be a manual `wrangler deploy`; folding it into
  CI (and provisioning a Workers-edit CF token) can follow.
- **Re-confirm D4 default** before apply: is mirror-by-default the desired OSS
  posture, or should the code default stay `api.github.com` with official prod
  setting the env? (User asked for full migration → mirror-by-default as written.)
