<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: api-version (depends: none)

<!-- Files: apps/api/src/health/* (+ a /version handler), apps/api/Dockerfile,
     packages/contracts (optional VersionResponse). Disjoint from web/CI/docs tracks. -->

- [x] 1.1 Add `GET /version` to the api (sibling of `/health` in the health module, exempt from the operator guard) returning `{ version, gitSha, buildTime }` from `process.env.CAP_VERSION`/`GIT_SHA`/`BUILD_TIME`, each defaulting to `"unknown"`. No secrets.
- [x] 1.2 In `apps/api/Dockerfile`, declare `ARG CAP_VERSION`/`GIT_SHA`/`BUILD_TIME` and carry them into the runtime stage as `ENV` so the running api self-reports.
- [x] 1.3 (Optional, project convention) add a `VersionResponse` shape to `@cap/contracts` and parse/return it.
- [x] 1.4 Add a test: `/version` returns injected values when env is set and `"unknown"` when unset, and is reachable unauthenticated (mirror the health/auth-exempt test style).

## 2. Track: web-buildid (depends: none)

<!-- Files: apps/web/vite.config.ts (define), apps/web/src/lib/config.ts (read),
     apps/web/Dockerfile (VITE_BUILD_ID build arg). Disjoint from track 1/3/4. -->

- [x] 2.1 In `apps/web/vite.config.ts`, add a `define` baking `VITE_BUILD_ID` (from `process.env.VITE_BUILD_ID`, default a sentinel like `"dev"`).
- [x] 2.2 Surface the build id through `apps/web/src/lib/config.ts` (a `buildId()` accessor) so the console can read its own build.
- [x] 2.3 In `apps/web/Dockerfile`, accept a `VITE_BUILD_ID` build arg and pass it to the build.

## 3. Track: release-ci (depends: none)

<!-- Files: .github/workflows/release.yml [new — first workflow]. Disjoint. -->

- [x] 3.1 Add `.github/workflows/release.yml` triggered on `release: published` (+ `workflow_dispatch`), `permissions: packages: write`, that builds and pushes `ghcr.io/xeonice/cap-api`, `cap-web`, `cap-aio-sandbox` ALL tagged with the release version `${{ github.event.release.tag_name }}` (+ `latest`), injecting `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME` (and `VITE_BUILD_ID` for web; the AIO triplet build-args for the sandbox image) via `docker/build-push-action`.
- [x] 3.2 Ensure the workflow sets the published GHCR packages to public visibility (workflow step or documented one-time owner setting) so self-hosters pull without auth.
- [x] 3.3 Validate the workflow YAML is well-formed (e.g. `actionlint` if available, or a careful schema review); confirm it is INERT on push (only `release: published`/`workflow_dispatch` triggers).

## 4. Track: image-override-and-docs (depends: none)

<!-- Files: docker-compose.images.yml [new], docs/self-hosting.md, deploy/DEPLOY.md. -->

- [x] 4.1 Add `docker-compose.images.yml`: an override mapping `api`/`web`/(`aio-sandbox-image` consumer) to `image: ghcr.io/xeonice/cap-*:${CAP_VERSION}`, pinning all three to the SAME `CAP_VERSION`, used via `docker compose -f docker-compose.yml -f docker-compose.images.yml up`. Do NOT change the default base compose.
- [x] 4.2 Document the release process + prebuilt-image self-host path in `docs/self-hosting.md` (pull pinned images instead of building), and the OPERATOR-GATED activation in `deploy/DEPLOY.md`: make the repo + GHCR packages public, cut the first Release (triggers CI), and (decision ④) migrate the maintainer's prod from build-on-push to deploy-a-pinned-release. Mark these as owner actions, not done by the change.

## 5. Track: integration-verify (depends: api-version, web-buildid, release-ci, image-override-and-docs)

- [x] 5.1 Build the api image with the version args + run it; confirm `GET /version` reports the injected values and is unauthenticated; confirm a no-arg source build reports `"unknown"`.
- [x] 5.2 Confirm the web build bakes `VITE_BUILD_ID`; run the api test suite + web build + workspace typecheck/lint green.
- [x] 5.3 Confirm the release workflow is inert on a normal push (no image build) and `docker compose -f docker-compose.yml -f docker-compose.images.yml config` resolves (image override well-formed). NOTE: the true end-to-end (a real Release publishing images) is OPERATOR-GATED and verified at the first Release, not here.
