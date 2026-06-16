<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contract (depends: none)

<!-- Files: packages/contracts/src/update-status.ts + index.ts export. The api (Track 2)
     and web (Track 3) both consume it, so it lands first as its own track. -->

- [x] 1.1 Add an `UpdateStatus` Zod schema + type to `@cap/contracts` (`{ currentVersion, latestVersion (nullable), updateAvailable, releaseUrl (nullable), releaseName (nullable), checkedAt }`) and export it from the package index. Include a pure, tested `compareVersions`/`isNewer` helper (v-prefix tolerant, unparseable → not-newer).

## 2. Track: api-update-status (depends: contract)

<!-- Files: a new update-status module/controller/service under apps/api/src + its test.
     Disjoint from web. -->

- [x] 2.1 Add an update-check service that fetches the latest GitHub Release for `GITHUB_RELEASES_REPO` (default the cap repo) with an in-process TTL cache (~6h), best-effort (failure → degraded, never throws), and compares the latest tag against `CAP_VERSION` using the contract helper.
- [x] 2.2 Add `GET /update-status` (operator-guarded, like `/metrics`) returning the `UpdateStatus`. `updateAvailable` true ONLY when current is known + a latest release exists + latest > current; honest `false` otherwise.
- [x] 2.3 Add tests: update-available, up-to-date, unknown-current, no-releases, fetch-failure (degraded, no throw), cache-hit (one upstream fetch per TTL), and operator-guard rejection.

## 3. Track: web-banner (depends: contract)

<!-- Files: apps/web/src/lib/api/{queries,real,mock}.ts, capabilities.ts, a banner
     component, and the _app shell wiring. Disjoint from api. -->

- [x] 3.1 Add `queryKeys.updateStatus` + `updateStatusQuery` (real/mock seam) in `apps/web/src/lib/api/queries.ts`, `real.getUpdateStatus` (Zod `.parse`) in `real.ts`, a `mockUpdateStatus` in `mock.ts`, and a `updateCheck` capability flag (initially `false`) in `capabilities.ts`.
- [x] 3.2 Add a dismissible "update available" banner component (new version + release link) and wire it into the `_app` shell; shown only when `updateAvailable`. Dismissal is per-version (persist the dismissed version, re-show for a newer one).
- [x] 3.3 Add a focused test/render check: banner appears on `updateAvailable: true`, absent on `false`, and dismissal is per-version.

## 4. Track: integration-verify (depends: api-update-status, web-banner)

- [x] 4.1 Run the api test suite + web build + workspace typecheck/lint green. Confirm `/update-status` degrades honestly (unknown current → `updateAvailable:false`) and the banner is absent in that state — so shipping is inert on the current source-build prod.
- [x] 4.2 NOTE (operator-gated, not done here): verifying a REAL update prompt needs a published Release on a public repo (Phase 1 activation); after that, flip the `updateCheck` capability flag to `true`.
