# Responsive update notification — Design

## Context

`update-availability-check` (shipped) works end-to-end: `GET /update-status` (operator-guarded) compares the running `CAP_VERSION` against the configured repo's GitHub `releases/latest` via the contract's `isNewer`, and the app-shell banner reads it through `updateStatusQuery` (capability-gated real/mock). The version source and comparison are correct.

Two freshness defects make a just-published Release invisible for hours:
- **`UpdateStatusService`**: the GitHub lookup is cached in-process with `DEFAULT_CACHE_TTL_MS = 6h`. A backend that cached `latest = vN-1` before `vN` was published serves the stale result for up to 6h (or until the process restarts).
- **`updateStatusQuery`**: documented as "a plain read with no client-side poll" — no `refetchInterval`. A long-open tab never re-fetches, so even after the backend cache refreshes the banner needs a manual reload.

Verified live: v0.4.0 published 17:07; the v0.3.3 backend's `/update-status` still reported no update (stale 6h cache), and the open console never re-polled.

## Goals / Non-Goals

**Goals**
- A newly-published Release surfaces in the banner within minutes, with no manual reload and no host ops.
- Stay within GitHub's anonymous rate limit (60 req/hr/IP).

**Non-Goals**
- Changing the version source (still GitHub `releases/latest`), `isNewer`, degraded behavior, the endpoint auth, the per-version dismissal, or the one-click `/self-update` action.
- Authenticated GitHub API calls / webhooks (out of scope; the cached anonymous poll suffices).

## Decisions

### D1 — Backend: short, configurable cache TTL with a floor
Lower `DEFAULT_CACHE_TTL_MS` 6h → **5 min**. Read an env override `UPDATE_CHECK_CACHE_TTL_MS` (ms), clamped to a **≥60s floor** so a misconfiguration can't exceed the rate limit. Keep the existing single shared in-process cache + in-flight coalescing (one upstream fetch per TTL across all browsers/requests). Rate-limit math: 5 min ⇒ ≤12 fetches/hr (≪ 60/hr); the 60s floor ⇒ ≤60/hr (at the limit, hence the floor, not lower).

### D2 — Frontend: poll `updateStatusQuery`
Add `refetchInterval` (~5 min, aligned with the backend TTL) and `refetchOnWindowFocus: true` so a long-open console — or one re-focused after a release — re-reads `/update-status` and surfaces the banner without a reload. The query already rides the real/mock seam unchanged.

### D3 — Everything else unchanged
Source (`releases/latest`), comparison (`isNewer`), degraded honesty, operator auth, per-version dismissal, admin-gated one-click upgrade all stay exactly as shipped. This change is purely about timeliness.

## Risks / Trade-offs

- **GitHub rate limit**: mitigated by the shared per-TTL cache + the ≥60s floor. Default 5 min is far under the limit even with many browsers (they share one backend fetch).
- **Slightly more frequent GitHub traffic**: from ≤1/6h to ≤12/hr — negligible and well within limits.
- **One-time chicken-and-egg**: the *running* backend has the old 6h-cache code, so v0.4.0 still won't notify promptly until the backend is upgraded once (manually this time). After this change ships, all future releases notify within minutes. (No code can retroactively fix an already-running old backend.)

## Migration Plan

Purely a config/cadence change; additive and backward-compatible. Default behavior improves with no env required; `UPDATE_CHECK_CACHE_TTL_MS` lets self-hosters tune. No API contract change, no schema change.

## Open Questions

- Exact default TTL (5 min proposed) and floor (60s proposed) — tune if GitHub traffic is a concern.
- Whether to also surface `checkedAt` staleness in the UI (out of scope; the banner already shows the release link).
