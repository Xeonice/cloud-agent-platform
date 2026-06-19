## Why

Today every self-hosted instance checks for updates by hitting GitHub's
`releases/latest` API directly. An in-process 5-minute cache already keeps a
single instance well under GitHub's anonymous rate limit, so this is safe — but
the fleet never converges (every instance is its own egress) and update checks
are coupled to GitHub's availability: when GitHub's API blips, the banner
silently degrades. Putting a thin, public, **cache-only** Cloudflare Worker in
front of the release lookup converges the fleet onto one cached upstream and
makes update checks immune to GitHub blips within the cache window — without
adding any release-control or telemetry surface.

## What Changes

- **New cache-only Worker** (`releases.cap.douglasdong.com`): a public,
  unauthenticated edge proxy that mirrors `GET /repos/{owner}/{repo}/releases/latest`
  to GitHub and serves it through Cloudflare's edge cache (short TTL). It is a
  pure cache layer — no GitHub token, no release gating, no telemetry.
- **Configurable release upstream**: the api's release lookup gains a
  `GITHUB_API_BASE` env (replacing the hard-coded `https://api.github.com`),
  **defaulting to the mirror Worker**. A self-hoster can set it back to
  `https://api.github.com` to stay fully direct/zero-dependency — this escape
  hatch is mandatory, it keeps "full migration" compatible with the self-host
  premise.
- **Injection-safe proxy**: the Worker strictly validates the `owner/repo` path
  segment so it can only ever proxy `releases/latest` for a well-formed repo,
  never become an arbitrary proxy.
- **Docs**: self-hosting guide documents that update checks default through the
  mirror and how to opt back into direct GitHub.
- **No contract change**: `GET /update-status`, the `UpdateStatus` schema, the
  operator guard, the honest-degrade semantics, and `GITHUB_RELEASES_REPO` all
  stay exactly as they are. Only the *upstream the lookup talks to* moves.

## Capabilities

### New Capabilities
- `release-check-mirror`: a public, cache-only Cloudflare Worker that transparently
  proxies GitHub `releases/latest` for a validated `owner/repo` and serves it via
  the CF edge cache, decoupling fleet update checks from GitHub availability.

### Modified Capabilities
- `update-availability-check`: the GitHub-Release lookup upstream becomes
  configurable via `GITHUB_API_BASE` (defaulting to the mirror), with a documented
  escape hatch to point back at `https://api.github.com`. The in-process
  cache, coalescing, honest-degrade, and operator-guard requirements are unchanged.

## Impact

- **New deploy unit**: a Worker package (Worker entry + `wrangler` config) bound
  to a custom domain on the existing CF zone. *Edge caching only works behind a
  real zone — `*.workers.dev` does not cache*, so the custom-domain route is
  required, not optional.
- **Code**: `apps/api/src/update-status/update-status.service.ts` —
  `fetchLatestGithubRelease` reads `GITHUB_API_BASE` instead of a literal host.
  `self-update.service.ts` is unaffected (it rides the same cached lookup).
- **Docs**: `docs/self-hosting.md` (and `.env.example`) document `GITHUB_API_BASE`.
- **Ops**: a CF custom-domain route (`releases.cap.douglasdong.com`) + `wrangler
  deploy` (CI or manual). The CF API token needs **Workers edit** scope — the
  current DNS-read-only token is insufficient.
- **Behavior**: two cache layers now (instance in-proc TTL + Worker edge TTL), so
  worst-case update-visibility lag is ~the sum of both TTLs. Update notification
  is not real-time, so this is acceptable.
- **Abuse surface**: a public, unauthenticated proxy of anonymous public data.
  Low harm; mitigated by strict `owner/repo` validation, covered by CF's free
  tier (100k req/day), with WAF rate-limiting as the fallback if abused.
