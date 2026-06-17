# Responsive update notification — Tasks

> Two small, independent tracks (backend TTL, frontend poll). Each ships with tests (per CLAUDE.md: no hardcoding to satisfy tests).

## 1. Backend: short, configurable cache TTL

- [x] 1.1 In `update-status.service.ts`, lower `DEFAULT_CACHE_TTL_MS` from 6h to 5 min (`5 * 60 * 1000`).
- [x] 1.2 Read an env override `UPDATE_CHECK_CACHE_TTL_MS` (ms) in the service (via the injected `env`), clamped to a `MIN_CACHE_TTL_MS` floor of 60s; fall back to the default when unset/invalid. Keep `UpdateStatusOptions.cacheTtlMs` precedence for tests.
- [x] 1.3 Preserve the shared in-process cache + in-flight coalescing exactly as-is.
- [x] 1.4 Update `update-status.spec.ts`: a fetch refreshes after the (short) TTL elapses; an env override is honored; below-floor values clamp to the floor; coalescing still does one fetch per TTL.

## 2. Frontend: poll the update-status query

- [x] 2.1 In `queries.ts`, add `refetchInterval` (~5 min) + `refetchOnWindowFocus: true` to `updateStatusQuery`; update its doc-comment (drop the "no client-side poll" note).
- [x] 2.2 Confirm the app-shell `update-banner.tsx` needs no change (it already reads the query); verify no extra re-render churn from the interval.
- [x] 2.3 Front-end test (or extend an existing one): `updateStatusQuery` carries the polling options; the banner surfaces when a later poll returns `updateAvailable: true`.

## 3. Finalize

- [x] 3.1 `typecheck` / `lint` / `build` green; targeted tests pass.
- [ ] 3.2 After release + backend upgrade: confirm a subsequently-published Release surfaces in the banner within minutes on a long-open console (no reload).
