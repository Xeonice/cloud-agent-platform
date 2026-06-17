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
The project SHALL provide a way for a self-hoster to run the pinned prebuilt GHCR images instead of building from source, pinning all cap images to the SAME version, in BOTH of these shapes, while the DEFAULT compose path remains build-from-source (additive and opt-in):

1. an OVERLAY (`docker-compose.images.yml`) layered onto the source `docker-compose.yml` (`-f base -f images`), for users who have the source tree and a layer-capable compose runner; and
2. a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`) that has NO `build:` blocks and NO source-tree bind-mounts — the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}` which DEFAULTS to `latest` (the newest published Release) when unset, so a bare `docker compose up` runs the latest release as a resident stack and never resolves a blank/garbage tag; operators MAY pin an explicit version for a reproducible / rollback-able deploy. Env comes from a local `.env` next to the compose (and is otherwise optional), and the package needs NO `git clone`. This run package splits RUN from BUILD and SHALL be attached to each GitHub Release (alongside an env example) so it is obtainable without the source. It MAY scope to the core run unit (api + the per-task sandbox image + Postgres + an optional web console) and exclude source-coupled services (reverse proxy / observability), which operators provide separately.

The published images MAY be single-architecture (amd64); the run package SHALL document any host-architecture requirement so an unsupported host gets a clear reason rather than an opaque pull error.

#### Scenario: Opt-in image override runs pinned prebuilt images
- **WHEN** a self-hoster brings the stack up with the documented image override at a pinned version
- **THEN** the stack runs the prebuilt `ghcr.io/<owner>/cap-*` images at that single version rather than building from source

#### Scenario: Source-free run package runs without the source tree
- **WHEN** a runner obtains only the self-contained run package (`docker-compose.prod.yml` + its env example) — e.g. downloaded from a Release — fills the `.env`, and runs `docker compose -f docker-compose.prod.yml up -d`
- **THEN** the stack pulls and runs the `ghcr.io/<owner>/cap-*` images with NO `git clone` and NO source-tree bind-mounts, resolving an unset `CAP_VERSION` to `latest` (the newest published release, never a blank tag) while allowing an explicit pin

#### Scenario: Run package is distributed via Release assets
- **WHEN** a Release is published
- **THEN** the self-contained run package and its env example are attached to that Release as downloadable assets

#### Scenario: Host-architecture requirement is documented
- **WHEN** the published images are single-architecture and a host of another architecture attempts to run the package
- **THEN** the run package documents the required architecture so the failure is explained rather than opaque

#### Scenario: Default path is unchanged
- **WHEN** the stack is brought up without the override or the run package
- **THEN** it builds from source exactly as before, unaffected by their existence

