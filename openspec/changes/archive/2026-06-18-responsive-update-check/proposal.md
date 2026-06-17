# Responsive update notification (near-live update check)

## Why

The in-app update banner exists so an operator NOTICES a new GitHub Release and one-click-upgrades — no host ops. But today a freshly-published Release can take **up to 6 hours + a manual page reload** to surface, because:
1. the backend `GET /update-status` caches the GitHub `releases/latest` lookup for **6 hours** (`DEFAULT_CACHE_TTL_MS`), and
2. the frontend `updateStatusQuery` reads `/update-status` **once, with no client-side poll**.

So the "notice → upgrade" loop is effectively broken for a just-cut release. Observed live: **v0.4.0 was published, but the v0.3.3 backend's banner stayed absent** — the 6h cache still held `latest = v0.3.3` and the open tab never re-polled. The version source + comparison are correct; only the FRESHNESS is wrong.

## What Changes

- **Backend**: shorten the update-check cache TTL from 6h to **~5 min (default)**, env-configurable with a rate-limit-safe **floor (≥60s)**. The single shared in-process fetch per TTL keeps GitHub's 60-req/hr anonymous limit respected (5 min ⇒ ≤12 fetches/hr).
- **Frontend**: add a modest poll to `updateStatusQuery` (`refetchInterval` ~5 min + refetch on window focus) so a long-open console surfaces a new Release within minutes **without a reload**.
- **Unchanged**: GitHub `releases/latest` as the version source, `isNewer` comparison, degraded-honesty behavior, operator-auth on the endpoint, the per-version dismissal, and the admin-gated one-click `/self-update` action.

## Impact

- **API** (`apps/api`): `UpdateStatusService` cache TTL default lowered + read from an env override (with a floor).
- **Web** (`apps/web`): `updateStatusQuery` gains `refetchInterval` + focus refetch.
- **Capability**: `update-availability-check` (this layers a timeliness guarantee onto the shipped notify-only feature).
- **One-time note**: the running backend must be upgraded once to pick up the shorter TTL — this is the last release that needs a manual nudge; after it ships, every future release notifies within minutes.
