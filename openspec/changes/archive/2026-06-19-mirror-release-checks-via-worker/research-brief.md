# Research brief — mirror-release-checks-via-worker

> Side-car notes grounding the proposal. Captured from an explore session
> (2026-06-19) with a codebase read + a Cloudflare-docs verification pass.
> NOT a tracked artifact.

## Current state (grounded)

- `apps/api/src/update-status/update-status.service.ts` is the only place that
  hits GitHub. `fetchLatestGithubRelease()` does an **anonymous** `GET
  https://api.github.com/repos/{repo}/releases/latest` with a fixed base URL
  hard-coded in the function (line ~250).
- It is already cached: an **in-process TTL cache** (default 5 min,
  `UPDATE_CHECK_CACHE_TTL_MS`, floored at 60 s) plus **in-flight coalescing**, so
  one upstream fetch is shared across all browsers/requests. Design already sized
  this against GitHub's anonymous **60/hr per-IP** limit: 5 min ⇒ ≤12 fetch/hr.
- Repo is configurable via `GITHUB_RELEASES_REPO` (default
  `Xeonice/cloud-agent-platform`); a self-hoster points it at their fork (D3 in
  the existing service docs).
- `self-update.service.ts` does NOT independently hit GitHub — it cross-checks
  the target against `UpdateStatusService.getStatus()`, so it rides the same
  cache. Migrating the source URL is therefore a single-call-site change.

## Key findings driving the design

1. **Single-instance frequency is already a solved problem.** 5 min ⇒ ≤12/hr,
   well under the 60/hr anonymous limit. "Lower the frequency" alone needs only a
   bigger `UPDATE_CHECK_CACHE_TTL_MS`, not a Worker.
2. **GitHub rate-limits per IP, not per repo.** N self-hosted instances = N IPs,
   each with its own 60/hr. So the Worker's value is NOT "dodge rate limits" — it
   is fleet **convergence** + **decoupling from GitHub availability** (the two
   motivations the user selected).
3. **CF edge caching requires a real zone — `*.workers.dev` won't cache.** Both
   `caches.default` and `fetch(..., { cf: { cacheTtl } })` are effectively no-ops
   on `workers.dev`; the Worker MUST run behind a custom domain on a CF zone. The
   project already has `douglasdong.com` on CF, so `releases.cap.douglasdong.com`
   is a near-zero-cost route.
4. **Pure-proxy caching needs no Cache-API boilerplate.** CF docs confirm
   `fetch(url, { cf: { cacheEverything: true, cacheTtl: 300, cacheTtlByStatus } })`
   makes the edge cache the upstream response directly — the Worker collapses to
   ~15 lines.
5. **"Pure cache layer" ≠ full availability immunity.** A plain TTL cache is
   immune to GitHub blips only WITHIN the TTL window; if GitHub is down past the
   TTL the Worker passes the error through and instances degrade as today. True
   stale-if-error (serve last-good on upstream failure) would need manual
   `caches.default` control and is explicitly OUT of scope for the pure-cache cut.

## Decisions locked with the user (explore session)

| # | Decision |
|---|----------|
| D1 | **Double-layer cache accepted.** Instance in-proc TTL stays; Worker adds an edge TTL. Worst-case visibility lag ≈ sum of both TTLs. Update notifications are not real-time, so this is acceptable; no need to shrink the instance TTL. |
| D2 | **Keep a direct-GitHub escape hatch (non-negotiable).** A new `GITHUB_API_BASE` env defaults to the mirror Worker but can be set back to `https://api.github.com`, so a self-hoster who doesn't trust the mirror stays zero-dependency. This is the line that keeps "full migration" compatible with the OSS self-host premise. |
| D3 | **Public, no auth, pure cache.** The Worker is an open GitHub-Release proxy. Harm is low (it proxies anonymous public data), but it MUST validate `owner/repo` format to avoid path-injection / becoming an arbitrary proxy. No GH token, no release-gating, no telemetry. CF free tier (100k req/day) covers it; WAF rate-limit is the fallback if abused. |

## Out of scope (deliberately)

- stale-if-error / serve-last-good across GitHub outages (would drop the
  "pure cache" simplicity).
- GH-token authenticated upstream (5000/hr) — unnecessary while cache hit-rate
  is high; revisit only if the single Worker egress IP starts hitting 60/hr.
- Release gating / canary / rollback control and install telemetry — these are
  product features the user explicitly did NOT ask for.
