# update-availability-check Specification

## Purpose
The console learns when a newer version is available: a cached, server-side GET /update-status compares the running CAP_VERSION against the latest GitHub Release for the configured repo and returns an honest discriminated status (degrading for source-build / no-releases / fetch-failure), and the app shell surfaces a dismissible update banner with the changelog link. Notify-only. (created by archiving change update-availability-check)

## Requirements
### Requirement: A cached server-side endpoint reports update availability
The api SHALL expose `GET /update-status` (behind the operator-auth guard) that compares the running version against the latest GitHub Release for the configured repo and returns a discriminated `UpdateStatus` `{ currentVersion, latestVersion, updateAvailable, releaseUrl, releaseName, checkedAt }`. The GitHub Release lookup SHALL be CACHED in-process with a TTL (so concurrent browsers share one upstream fetch and GitHub rate limits are respected), and SHALL be BEST-EFFORT — a fetch failure SHALL return a degraded status (`updateAvailable: false`, `latestVersion: null`) rather than throwing. The checked repo SHALL come from configuration (`GITHUB_RELEASES_REPO`, defaulting to the cap repo) and the current version from the same source `/version` uses (`CAP_VERSION`). An `UpdateStatus` schema SHALL be added to `@cap/contracts` and used to validate the response on the client.

#### Scenario: Endpoint reports an available update
- **WHEN** the running `CAP_VERSION` is a known version older than the latest GitHub Release for the configured repo
- **THEN** `GET /update-status` returns `updateAvailable: true` with `currentVersion`, `latestVersion`, and the release URL/name

#### Scenario: Lookup is cached across requests
- **WHEN** `GET /update-status` is requested repeatedly within the cache TTL
- **THEN** the GitHub Release is fetched at most once per TTL and subsequent requests are served from the cache

#### Scenario: Endpoint is operator-guarded
- **WHEN** an unauthenticated request hits `GET /update-status`
- **THEN** the global operator-auth guard rejects it (it is console data + triggers an outbound fetch), unlike the unauthenticated `/version`

### Requirement: Update status degrades honestly and never fabricates an update
The endpoint SHALL report `updateAvailable: true` ONLY when the current version is KNOWN (not `"unknown"`), a latest Release EXISTS, and the latest version is strictly greater than the current (semver comparison, tolerant of a `v` prefix). In every other case — current version `"unknown"` (a source build), no releases published, an unparseable tag, or a failed GitHub fetch — it SHALL report `updateAvailable: false` with `latestVersion` null and SHALL NOT fabricate a prompt.

#### Scenario: Source build with unknown version shows no update
- **WHEN** the running version is `"unknown"`
- **THEN** `update-status` returns `updateAvailable: false` (no comparison is possible), not a prompt

#### Scenario: No releases yet shows no update
- **WHEN** the configured repo has no published Releases (or the repo is private/unreachable)
- **THEN** `update-status` returns `updateAvailable: false` with `latestVersion` null, not an error

#### Scenario: Up-to-date shows no update
- **WHEN** the current version equals (or is newer than) the latest Release
- **THEN** `update-status` returns `updateAvailable: false`

### Requirement: The console surfaces a dismissible update banner
When `update-status` reports an available update, the console app shell SHALL render a non-intrusive, DISMISSIBLE banner indicating a newer version is available with a link to the release (the changelog). It SHALL read through the standard query seam (`queryKeys.updateStatus` + `updateStatusQuery`, with `real.getUpdateStatus` validating via the contract schema and a mock fallback selected by a `updateCheck` capability flag), so it renders on the typed mock until verified live. When no update is available the banner SHALL be absent. Dismissal SHALL be per-version, so a later newer version re-surfaces the banner.

#### Scenario: Banner appears when an update is available
- **WHEN** the console loads and `update-status` reports `updateAvailable: true`
- **THEN** a dismissible banner appears in the app shell with the new version and a link to the release

#### Scenario: Banner is absent when no update
- **WHEN** `update-status` reports `updateAvailable: false`
- **THEN** no update banner is shown

#### Scenario: Dismissal is per-version
- **WHEN** the operator dismisses the banner for version vY
- **THEN** it stays dismissed for vY but re-appears if a later version vZ (> vY) becomes available

#### Scenario: Real/mock seam is plumbed
- **WHEN** the console requests update status
- **THEN** it uses `queryKeys.updateStatus` + `updateStatusQuery` with `real.getUpdateStatus` validating via the `@cap/contracts` `UpdateStatus` schema and a mock fallback selected by the `updateCheck` capability flag, mirroring the existing domains


### Requirement: Update detection is near-live (short, configurable cache TTL)
The `GET /update-status` GitHub-Release lookup cache SHALL use a SHORT default TTL (on the order of minutes, not hours) so a newly-published Release surfaces promptly, and the TTL SHALL be configurable via an environment variable, clamped to a floor that respects GitHub's anonymous rate limit. The single shared in-process fetch-per-TTL + coalescing behavior SHALL be preserved.

#### Scenario: A newly-published release surfaces within minutes
- **WHEN** a new Release is published and the running version is older than it
- **THEN** within the (minutes-scale) cache TTL, the next `GET /update-status` re-fetches the latest Release and reports `updateAvailable: true` — it does NOT remain stale for hours

#### Scenario: TTL is configurable with a rate-limit-safe floor
- **WHEN** `UPDATE_CHECK_CACHE_TTL_MS` is set
- **THEN** the cache uses that TTL, clamped to a minimum floor (>= 60s) so the shared upstream fetch cannot exceed GitHub's anonymous rate limit
- **AND** when the env var is unset, a short minutes-scale default applies

#### Scenario: Shared cache + coalescing preserved
- **WHEN** many requests hit `GET /update-status` within one TTL
- **THEN** at most one upstream GitHub fetch occurs per TTL (shared across all callers), as before

### Requirement: The banner polls for new releases without a reload
The console SHALL periodically re-read `GET /update-status` (a modest poll plus a refetch on window focus) so a newly-available Release surfaces in the banner without a manual page reload, riding the existing query seam unchanged.

#### Scenario: A long-open console notices a new release
- **WHEN** the console has been open since before a Release was published
- **THEN** within the poll interval (minutes-scale) it re-reads `/update-status` and the banner appears — no reload required

#### Scenario: Refocusing the tab re-checks
- **WHEN** the operator returns focus to a console tab that was backgrounded across a release
- **THEN** the update-status query refetches and the banner reflects the latest availability
