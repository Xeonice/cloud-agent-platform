# Research Brief — update-availability-check (OSS self-update epic, Phase 2)

> Side-car. NOT tracked. Phase 2 of `docs/oss-self-update-epic.md` ("the instance knows
> there's an update"). Builds on Phase 1 (`/version` + GitHub Releases).

## Goal
The console tells the operator a newer version is available (notify-only), by comparing the
running `/version` against the latest GitHub Release. The one-click upgrade is Phase 3.

## Grounded facts
- The frontend has a clean real/mock query seam: `isCapable(domain) ? real() : mock()` with
  stable query keys (`apps/web/src/lib/api/queries.ts`, `capabilities.ts`) — metrics/history/
  sessionHistory all use it. The banner plugs in as a new `updateCheck` domain (flag false →
  renders on mock until verified live).
- Phase 1 added `GET /version` (`CAP_VERSION`/`GIT_SHA`/`BUILD_TIME`, honest "unknown") and
  the GHCR release pipeline. The current version source is `CAP_VERSION`.
- GitHub Releases REST API gives the latest release for a repo; for a PUBLIC repo it needs
  no auth. The cap repo is PRIVATE today → the check returns "no info" honestly until Phase 1
  activation makes it public.

## Approach (server-side, cached)
`GET /update-status` (operator-guarded) does one cached (~6h TTL) GitHub Releases fetch,
compares latest tag vs `CAP_VERSION` (semver, `v`-prefix tolerant), returns a discriminated
`UpdateStatus`. Best-effort: failure → degraded, never throws. The console shows a dismissible
banner when `updateAvailable`.

## Ships inert / safe
Until a Release exists AND the version is known (a CI-built image), `update-status` returns
`updateAvailable: false` and the banner is hidden — so shipping Phase 2 changes nothing
visible on the maintainer's current source-build prod (version "unknown" → no banner).

## Anti-scope
- The upgrade button + docker.sock self-update (Phase 3).
- Repo public / cut Release (Phase 1 operator activation).
