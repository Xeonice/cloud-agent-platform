## Why

cap now reports its running version (`/version`, Phase 1) and will publish versioned Releases, but a self-hoster still has no way to LEARN a newer version exists — they'd have to manually watch GitHub. This is **Phase 2** of the OSS self-update epic (`docs/oss-self-update-epic.md`): the console tells the operator "a new version is available" with the changelog, by comparing the running version against the latest GitHub Release. It is the notify half of the update UX (the one-click upgrade button is Phase 3).

> Side-car context: `docs/oss-self-update-epic.md`. Builds on Phase 1's `/version` + GitHub Releases.

## What Changes

- **Add a server-side update check.** A new `GET /update-status` api endpoint (behind the operator guard, like `/metrics`) fetches the latest GitHub Release for the configured repo (`GITHUB_RELEASES_REPO`, default the cap repo), CACHED in-process (e.g. 6h TTL) so each browser does not hit GitHub and rate limits are respected, and compares the latest release tag against the running `CAP_VERSION`. It returns a discriminated, honest `UpdateStatus`: `{ currentVersion, latestVersion, updateAvailable, releaseUrl, releaseName, checkedAt }`. It degrades honestly — `updateAvailable: false` with a reason when the current version is `"unknown"` (a source build), when there are no releases, or when the GitHub fetch fails (never throws, never fabricates).
- **Add an `UpdateStatus` contract** in `@cap/contracts` (Zod schema), validated on the client like the other domains.
- **Show a non-intrusive "update available" banner in the console.** When `updateAvailable`, the app shell renders a dismissible banner ("vY available — what's new") linking to the release. It reads through the standard query seam (`updateStatusQuery`, `queryKeys.updateStatus`) with a `updateCheck` capability flag (real/mock), rendering on the typed mock until verified against the live api — the established "render on mock, flip one flag" pattern. When no update / unknown, the banner is absent.

## Capabilities

### New Capabilities
- `update-availability-check`: The console learns when a newer version is available — a cached, server-side `GET /update-status` compares the running `/version` against the latest GitHub Release for the configured repo and returns an honest discriminated status (degrading cleanly for a source build / no releases / fetch failure), and the app shell surfaces a dismissible "update available" banner with the changelog link. Notify-only; the upgrade action is Phase 3.

## Impact

- **api:** new `GET /update-status` controller (operator-guarded), an update-check service that fetches GitHub Releases (cached in-process, TTL'd, best-effort) and compares semver against `CAP_VERSION`; reads the repo from `GITHUB_RELEASES_REPO` env (default the cap repo). No new persistence.
- **contracts:** new `UpdateStatus` schema in `@cap/contracts`.
- **web:** `queryKeys.updateStatus` + `updateStatusQuery` (real/mock seam), `real.getUpdateStatus` (Zod `.parse`), a mock, a `updateCheck` capability flag (initially `false`), and a dismissible banner component in the app shell.
- **config:** `GITHUB_RELEASES_REPO` env (default `Xeonice/cloud-agent-platform`); documented. For a PRIVATE repo the GitHub Releases API needs auth, so the check returns "no info" until the repo is public (Phase 1 activation) — honest, not an error.
- **Dependencies:** none new (server-side `fetch` to the public GitHub API).
- **Explicitly NOT in this change:** the one-click upgrade button + docker.sock self-update (Phase 3); making the repo public / cutting Releases (operator-gated, Phase 1 activation). The banner shows nothing until a Release exists and the version is known — safe to ship inert.
- **Specs:** 1 new (`update-availability-check`). No existing requirements change.
