# @cap/release-cache-worker

A public, **cache-only** Cloudflare Worker that fronts cap's update-availability
check. It transparently proxies GitHub's `releases/latest` for a validated
`owner/repo` and serves it through Cloudflare's edge cache.

It exists so the fleet's update checks converge onto one cached upstream and stay
working during a GitHub API blip (within the cache window), instead of every
self-hosted instance hitting `api.github.com` directly. The api points
`GITHUB_API_BASE` at this Worker by default (see `docs/self-hosting.md`).

It is a **pure cache layer**: no authentication, no GitHub token, no telemetry, no
payload rewrite, no release gating. Any path that is not the exact
`/repos/{owner}/{repo}/releases/latest` shape is rejected with 404 and makes no
upstream fetch, so the open endpoint can never proxy an arbitrary URL.

## Must run behind a CF zone custom domain

Cloudflare edge caching (`cf.cacheTtl`) is **inoperative on `*.workers.dev`**. The
Worker MUST be bound to a custom domain on a Cloudflare zone (`wrangler.toml`
`custom_domain = true`), or it degenerates into a pass-through with no cache.

## Develop / test / deploy

```bash
pnpm --filter @cap/release-cache-worker build       # tsc → dist (also what tests import)
pnpm --filter @cap/release-cache-worker test        # node:test over the pure proxy logic
pnpm --filter @cap/release-cache-worker typecheck
pnpm --filter @cap/release-cache-worker deploy      # wrangler deploy (needs a Workers-edit CF token)
```

Verify after deploy: a repeat request to a valid path reports `cf-cache-status: HIT`,
and a non-matching path returns 404.
