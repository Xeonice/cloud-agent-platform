## Context

Phase 2 of the OSS self-update epic. Phase 1 shipped `/version` (running identity) and the
Release-triggered GHCR pipeline (version catalog). Phase 2 closes the loop on the NOTIFY
half: compare running version vs latest Release and tell the operator. The frontend already
has a clean real/mock query seam (`isCapable(domain)` → `real()`/`mock()`, stable query
keys) used by metrics/history/etc., so the banner plugs into the established pattern. Low
risk, additive, ships inert (shows nothing until a Release exists + version is known).

## Goals / Non-Goals

**Goals:**
- A cached, server-side check that compares `/version` against the latest GitHub Release.
- An honest discriminated `UpdateStatus` (degrades for source-build / no-releases / fetch-fail).
- A dismissible console banner when an update is available, with the changelog link.
- Ships safe/inert: no banner until there is a real newer Release and a known current version.

**Non-Goals:**
- The one-click upgrade action (Phase 3).
- Making the repo public / cutting Releases (Phase 1 operator activation).
- Auto-update / background pulling (future, opt-in).

## Decisions

### D1 — Server-side, cached check (not per-browser)
A `GET /update-status` endpoint (operator-guarded, like `/metrics`) does ONE cached
GitHub Releases fetch per TTL (~6h) shared across all browsers, rather than each client
hitting GitHub. This respects GitHub rate limits, centralizes the repo/version comparison,
and avoids browser CORS to the GitHub API. The check is best-effort: a fetch failure
returns a degraded status, never throws.
- *Alternative — client fetches GitHub directly:* rejected (per-browser rate limits, CORS,
  and it scatters the comparison logic).

### D2 — Honest discriminated `UpdateStatus`
Returns `{ currentVersion, latestVersion, updateAvailable, releaseUrl, releaseName, checkedAt }`.
`updateAvailable` is true ONLY when the current version is known (not `"unknown"`) AND a
latest Release exists AND latest > current (semver compare). When current is `"unknown"`
(a source build), or there are no releases, or the fetch failed, `updateAvailable` is false
with the latest left null — the banner stays hidden, never a fabricated prompt.

### D3 — Repo + version come from env, default the cap repo
The checked repo is `GITHUB_RELEASES_REPO` (default `Xeonice/cloud-agent-platform`); the
current version is `CAP_VERSION` (same env `/version` reads). For a PRIVATE repo the GitHub
Releases API needs auth — until Phase 1 activation makes the repo public, the check returns
"no info" (honest), not an error. A self-hoster sets `GITHUB_RELEASES_REPO` to their own
fork if they cut their own releases.

### D4 — Banner rides the standard real/mock seam, ships on mock
`updateStatusQuery` + `queryKeys.updateStatus` + `real.getUpdateStatus` (Zod `.parse`) +
a mock, gated by a new `updateCheck` capability flag (initially `false`). The dismissible
app-shell banner renders on the typed mock until the endpoint is verified live, then the
flag flips — the established pattern. Dismissal is per-version (re-shows for a newer one).

## Risks / Trade-offs

- **GitHub rate limits / private repo.** → Cached server-side (one fetch per TTL); private
  repo returns "no info" honestly until public. Acceptable.
- **Semver compare edge cases** (pre-release tags, `v` prefix). → Normalize the `v` prefix
  and use a small, tested compare; unknown/unparseable → treat as "no update" (fail safe,
  never a false prompt).
- **Stale cache** (a just-cut Release not shown for up to TTL). → Acceptable for a notify;
  TTL is a few hours. A manual refresh could bust it (future).
- **Banner noise.** → Dismissible, per-version; hidden entirely when not applicable.

## Migration Plan
1. Ship the endpoint + contract + banner (flag `false` → renders on mock). Safe/inert.
2. After Phase 1 activation (repo public + a Release exists) verify `/update-status` returns
   a real comparison, then flip `updateCheck` to `true`.
- **Rollback:** additive; remove the endpoint/banner/flag to revert.

## Open Questions
- Banner placement (top app-shell strip vs a settings/about area). Lean: a slim dismissible
  top strip in the `_app` shell.
- Should `/update-status` be unauthenticated like `/version`, or operator-guarded? Lean:
  operator-guarded (it's console data and triggers an outbound GitHub fetch).
