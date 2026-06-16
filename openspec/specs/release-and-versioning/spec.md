# release-and-versioning Specification

## Purpose
The running cap reports its build version (GET /version on the api, a baked web build id), and a GitHub-Release-triggered CI workflow publishes a matched, pinned set of versioned container images to GHCR (cap-api/cap-web/cap-aio-sandbox at one cap version), with a documented prebuilt-image self-host path — the version substrate the update-check and one-click upgrade consume. (created by archiving change versioned-release-pipeline)

## Requirements
### Requirement: The api reports its build version at an unauthenticated /version endpoint
The api SHALL expose a `GET /version` endpoint, unauthenticated like `/health` (it returns only build metadata and carries no secrets), that reports `{ version, gitSha, buildTime }`. Each field SHALL be read from a build-time-injected environment value (`CAP_VERSION` / `GIT_SHA` / `BUILD_TIME`) and SHALL fall back to `"unknown"` when not provided, so a plain source build (no build args) reports honestly rather than failing. The api Dockerfile SHALL declare the corresponding build `ARG`s and carry them into the runtime stage as `ENV`.

#### Scenario: /version reports injected build metadata
- **WHEN** the api image is built with `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME` build args and `GET /version` is requested
- **THEN** it responds (unauthenticated) with those values as `{ version, gitSha, buildTime }`

#### Scenario: /version degrades honestly without build args
- **WHEN** the api is built from source with no version build args and `GET /version` is requested
- **THEN** it responds with `"unknown"` for the un-injected fields rather than erroring

#### Scenario: /version requires no authentication
- **WHEN** an unauthenticated request hits `GET /version`
- **THEN** it is served (exempt from the operator guard, like `/health`), exposing only build metadata

### Requirement: The web console carries a baked build id
The web build SHALL bake a build identifier (`VITE_BUILD_ID`, a Vite compile-time value) into the console bundle, surfaced through the existing web config module, so the running console knows its own build. It SHALL default to a sentinel (e.g. `"unknown"` / `"dev"`) when not provided at build time.

#### Scenario: Web build id is baked at build time
- **WHEN** the web app is built with a `VITE_BUILD_ID` provided
- **THEN** the built console exposes that build id through its config module
- **AND** when no `VITE_BUILD_ID` is provided the console reports a sentinel rather than failing

### Requirement: A GitHub-Release-triggered workflow publishes a matched, versioned image set to GHCR
The repository SHALL define a CI workflow triggered on `release: published` (and `workflow_dispatch` for manual runs) that builds and pushes a MATCHED set of container images — `ghcr.io/<owner>/cap-api`, `ghcr.io/<owner>/cap-web`, and `ghcr.io/<owner>/cap-aio-sandbox` — ALL tagged with the SINGLE release version `vX.Y.Z` (so a release is one matched, mutually-compatible set), injecting `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME` build args so the published images self-report via `/version`. The workflow SHALL use the built-in token with `packages: write` and SHALL make the published packages publicly pullable. Merely committing the workflow SHALL NOT publish anything — publishing occurs only when a Release is published.

#### Scenario: Publishing a Release builds and pushes the matched image set
- **WHEN** a GitHub Release `vX.Y.Z` is published
- **THEN** the workflow builds and pushes `cap-api`, `cap-web`, and `cap-aio-sandbox` to GHCR, all tagged `vX.Y.Z`, with the version build args injected
- **AND** the published packages are publicly pullable

#### Scenario: Committing the workflow is inert until a Release is cut
- **WHEN** the workflow file is merged but no Release has been published
- **THEN** no image is built or pushed and the running system is unaffected

#### Scenario: A published api image self-reports its version
- **WHEN** the `cap-api:vX.Y.Z` image published by the workflow is run and `GET /version` is requested
- **THEN** `version` is `vX.Y.Z` and `gitSha`/`buildTime` reflect the release build

### Requirement: A documented prebuilt-image self-host path exists without changing the default
The project SHALL provide a documented way for a self-hoster to run the pinned prebuilt GHCR images instead of building from source (e.g. a `docker-compose.images.yml` override mapping each service to `image: ghcr.io/<owner>/cap-*:<version>`), and SHALL pin all three images to the SAME version. The DEFAULT compose path SHALL remain build-from-source, so the prebuilt-image path is additive and opt-in (the published images do not exist until a Release is cut).

#### Scenario: Opt-in image override runs pinned prebuilt images
- **WHEN** a self-hoster brings the stack up with the documented image override at a pinned version
- **THEN** the stack runs the prebuilt `ghcr.io/<owner>/cap-*` images at that single version rather than building from source

#### Scenario: Default path is unchanged
- **WHEN** the stack is brought up without the image override
- **THEN** it builds from source exactly as before, unaffected by the existence of the override
