## Why

For a self-hoster to ever know "is there a new version" and pull it, two things must exist that don't today: the running system must report WHAT version it is (`/version`), and cutting a release must publish a matched, pinned set of container images others can pull (GHCR). cap has no `/version` and no CI/release pipeline. This is **Phase 1** of the OSS self-update epic (`docs/oss-self-update-epic.md`) — the version substrate that Phase 2 (update-check banner) and Phase 3 (one-click upgrade) consume.

> Side-car: `research-brief.md` records the grounded seam + the autonomous-vs-operator-gated split. Epic context in `docs/oss-self-update-epic.md`.

## What Changes

- **Add `GET /version` self-reporting to the api.** A sibling to the existing unauthenticated `/health` returning `{ version, gitSha, buildTime }`, read from `process.env` injected via Docker `ARG`→`ENV` in `apps/api/Dockerfile`. It degrades honestly to `"unknown"` when the build args are not provided (e.g. a plain source build), and carries no secrets.
- **Bake a web build id.** Surface `VITE_BUILD_ID` (a Vite `define`, baked at build) through the existing `apps/web/src/lib/config.ts`, so the console knows its own build.
- **Add a Release-triggered CI workflow that publishes versioned GHCR images.** `.github/workflows/release.yml`, triggered ONLY on `release: published`, builds and pushes the matched set `ghcr.io/xeonice/cap-api`, `ghcr.io/xeonice/cap-web`, `ghcr.io/xeonice/cap-aio-sandbox` all at the single cap version `:vX.Y.Z` (decision ⑤), injecting `GIT_SHA`/`BUILD_TIME`/`CAP_VERSION` build args so the published images self-report via `/version`. The workflow sets the published packages to public visibility. Committing this workflow is INERT until a Release is cut — it changes nothing about the running system.
- **Document the prebuilt-image self-host path.** A documented compose `image:` override (e.g. a `docker-compose.images.yml`) letting a self-hoster run pinned `ghcr.io/xeonice/cap-*:vX.Y.Z` images instead of building from source. The DEFAULT compose stays build-from-source (the published images do not exist until a Release is cut), so nothing changes for existing users until they opt in.
- **Document the operator-gated activation steps** (NOT performed by this change): making the repo + GHCR packages public, cutting the first GitHub Release (which triggers CI to publish), and migrating the maintainer's own prod (Dokploy) from build-on-push to deploy-a-pinned-release (the unified-release-line decision ④).

## Capabilities

### New Capabilities
- `release-and-versioning`: The running cap reports its version (`GET /version` on the api, a baked web build id), and a GitHub-Release-triggered CI workflow publishes a matched, pinned set of versioned container images to GHCR (`cap-api`/`cap-web`/`cap-aio-sandbox` at one cap version), with a documented prebuilt-image self-host path — the version substrate the update-check and one-click upgrade consume.

## Impact

- **api:** `apps/api/src/health/health.controller.ts` (or a sibling controller in the health module) gains `GET /version`; `apps/api/Dockerfile` gains `ARG GIT_SHA`/`BUILD_TIME`/`CAP_VERSION` → `ENV` in the runtime stage. Unauthenticated, like `/health` (build metadata, no secrets).
- **contracts:** a small `VersionResponse` shape in `@cap/contracts` for `/version` (optional but mirrors the project convention).
- **web:** `apps/web/vite.config.ts` (a `define` for `VITE_BUILD_ID`) + `apps/web/src/lib/config.ts` (read it); the web Dockerfile passes a `VITE_BUILD_ID` build arg.
- **CI:** new `.github/workflows/release.yml` (the FIRST workflow), `release: published` trigger, `packages: write`, building/pushing the three GHCR images at the release tag + setting them public.
- **Compose/docs:** a documented `docker-compose.images.yml` (or `image:` override) for the prebuilt-image path; `docs/self-hosting.md` + `deploy/DEPLOY.md` gain the release process + the operator-gated activation steps.
- **Dependencies:** none new (GitHub Actions + GHCR are platform; `docker/build-push-action` is a standard action).
- **Explicitly NOT in this change (operator-gated, surfaced not executed):** making the repo/packages public, cutting a Release, migrating the maintainer's prod pipeline. And NOT flipping the default compose to image-pull. Phase 2 (banner) + Phase 3 (button) are later.
- **Specs:** 1 new (`release-and-versioning`). No existing spec's requirements change (the default deploy path is unchanged; image-pull is additive/opt-in).
