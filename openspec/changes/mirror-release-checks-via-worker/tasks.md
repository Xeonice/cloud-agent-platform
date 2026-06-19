<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: worker (depends: none)

- [x] 1.1 Scaffold `apps/release-cache-worker/` (Worker entry + `wrangler` config) and add it to `pnpm-workspace.yaml`; configure the deploy as a **custom-domain route on the CF zone** (`releases.cap.douglasdong.com`), NOT a `*.workers.dev` route, since edge caching is inoperative on `workers.dev`.
- [x] 1.2 Implement the fetch handler: accept ONLY `GET` paths matching `^/repos/[\w.-]+/[\w.-]+/releases/latest$`, return 404 with NO upstream fetch otherwise; proxy matches to `https://api.github.com/repos/{owner}/{repo}/releases/latest` forwarding the GitHub headers (`Accept: application/vnd.github+json`, a `User-Agent`, `X-GitHub-Api-Version`).
- [x] 1.3 Configure edge caching on the upstream `fetch` via `cf: { cacheEverything: true, cacheTtl: ~300, cacheTtlByStatus: { '200-299': 300, '404': 60, '500-599': 0 } }` so 2xx/404 cache briefly and 5xx is never cached; return GitHub's body + status unchanged (pure cache layer — no payload rewrite, no auth).
- [x] 1.4 Add a minimal test/smoke for the handler (path-validation accept + reject-without-fetch; proxied response shape), matching the repo's worker/test conventions.
- [x] 1.5 Wire the new package into the turbo build/typecheck/lint pipeline so it passes the CI gate.

## 2. Track: api-upstream (depends: none)

- [x] 2.1 In `apps/api/src/update-status/update-status.service.ts` add a `DEFAULT_RELEASES_API_BASE` constant (the official mirror) and resolve `GITHUB_API_BASE` from env (trim + strip trailing slash), defaulting to the constant.
- [x] 2.2 Change `fetchLatestGithubRelease` to build `${base}/repos/${repo}/releases/latest` from the resolved base instead of the literal `https://api.github.com`; keep the path, headers, and `LatestRelease` return shape identical.
- [x] 2.3 Extend `update-status.spec.ts`: default resolves the mirror base; `GITHUB_API_BASE=https://api.github.com` resolves direct GitHub; a failing/unreachable base still degrades honestly (`updateAvailable:false`, `latestVersion:null`); assert the request path + headers are unchanged across bases.
- [x] 2.4 Confirm `self-update.service.ts` needs no change (it cross-checks via the same cached `UpdateStatusService`, with no independent GitHub call site).

## 3. Track: docs-config (depends: none)

- [x] 3.1 `docs/self-hosting.md`: document that update checks default through the mirror and how to set `GITHUB_API_BASE=https://api.github.com` to stay fully direct/zero-dependency; note the OSS-neutral escape hatch prominently.
- [x] 3.2 `.env.example` (and any compose env passthrough for the api): add `GITHUB_API_BASE` with the mirror default and the direct-GitHub alternative as a documented option.

## 4. Track: deploy-verify (depends: worker, api-upstream)

> Done in-session (2026-06-19) via local wrangler OAuth to
> `releases.cap.douglasdong.com` and verified: cf-cache-status MISS→HIT on a real
> release lookup, 404 on a non-matching path (no upstream), 405 on POST, and the
> api fetcher resolving via the mirror by default + the direct escape hatch
> (cli/cli v2.95.0; cap repo v0.7.0). The api code change ships with the PR; prod
> api picks up the mirror default on its next deploy.

- [x] 4.1 Provision the CF custom-domain route `releases.cap.douglasdong.com` (needs a **Workers-edit** CF token — the current DNS-read-only token is insufficient) and `wrangler deploy` the Worker.
- [x] 4.2 Verify the Worker: a valid `releases/latest` path proxies correctly; a repeat request within the TTL reports `cf-cache-status: HIT`; a non-matching path returns 404 with no upstream fetch.
- [x] 4.3 Verify end-to-end from the api: with the default (unset `GITHUB_API_BASE`), `/update-status` resolves through the mirror; with `GITHUB_API_BASE=https://api.github.com` the escape hatch still resolves and degrades honestly when the base is unreachable.
