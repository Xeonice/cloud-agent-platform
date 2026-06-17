# update-availability-check Specification

## ADDED Requirements

### Requirement: Update detection is near-live (short, configurable cache TTL)

The `GET /update-status` GitHub-Release lookup cache SHALL use a SHORT default TTL (on the order of minutes, not hours) so a newly-published Release surfaces promptly, and the TTL SHALL be configurable via an environment variable, clamped to a floor that respects GitHub's anonymous rate limit. The single shared in-process fetch-per-TTL + coalescing behavior SHALL be preserved.

#### Scenario: A newly-published release surfaces within minutes

- **WHEN** a new Release is published and the running version is older than it
- **THEN** within the (minutes-scale) cache TTL, the next `GET /update-status` re-fetches the latest Release and reports `updateAvailable: true` — it does NOT remain stale for hours

#### Scenario: TTL is configurable with a rate-limit-safe floor

- **WHEN** `UPDATE_CHECK_CACHE_TTL_MS` is set
- **THEN** the cache uses that TTL, clamped to a minimum floor (≥ 60s) so the shared upstream fetch cannot exceed GitHub's anonymous rate limit
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

## Notes

- This layers a TIMELINESS guarantee onto the shipped notify-only `update-availability-check`; the version source (GitHub `releases/latest`), `isNewer` comparison, degraded-honesty, operator auth, per-version dismissal, and the admin-gated one-click `/self-update` action are all unchanged.
- Rate-limit math: default ~5 min ⇒ ≤12 shared fetches/hr; the ≥60s floor ⇒ ≤60/hr, at GitHub's anonymous limit (hence a floor, not lower).
- One-time: an already-running old backend keeps its 6h cache until upgraded once; this change makes all future releases prompt.
