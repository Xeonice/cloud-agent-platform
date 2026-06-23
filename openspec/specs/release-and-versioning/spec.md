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
2. a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`) that has NO `build:` blocks and NO source-tree bind-mounts — the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}` which DEFAULTS to `latest` (the newest published Release) when unset, so a bare `docker compose up` runs the latest release as a resident stack and never resolves a blank/garbage tag; operators MAY pin an explicit version for a reproducible / rollback-able deploy. Env comes from a local `.env` next to the compose (and is otherwise optional), and the package needs NO `git clone`. This run package splits RUN from BUILD and SHALL be attached to each GitHub Release (alongside an env example) so it is obtainable without the source. It MAY scope to the core run unit (api + the per-task sandbox image + Postgres + an optional web console) and exclude only source-coupled services that bind-mount config from the source tree (the reverse proxy), which operators provide separately; observability is NOT excluded — it ships as an opt-in inline-configured stack (see "The source-free run package offers an opt-in inline-configured observability stack").

The run package SHALL be runnable as a RESIDENT production stack and, when brought up against an existing deployment with the matching compose project name, SHALL reuse that deployment's existing named volumes, network, and env (e.g. an existing `files/api.env`) rather than creating fresh ones — so adopting the run package in place of a prior build-from-source deployment is behavior-neutral (same data, same secrets, same network), with `prisma migrate deploy` a no-op on the already-migrated database.

The published images MAY be single-architecture (amd64); the run package SHALL document any host-architecture requirement so an unsupported host gets a clear reason rather than an opaque pull error. The run package SHALL document the minimum Docker Compose version it requires (Compose Spec >= v2.23.1, for inline `configs.content:`).

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

#### Scenario: Run package adopted as a resident stack reuses an existing deployment in place
- **WHEN** the run package is brought up with the project name of an existing deployment (e.g. `docker compose -p <project> -f docker-compose.prod.yml up -d`) whose named volumes, network, and env file already exist
- **THEN** it reuses those existing volumes (database + workspaces), network, and env rather than creating new ones, the database keeps its data with `prisma migrate deploy` a no-op, and the resident stack reproduces the prior deployment's behavior

#### Scenario: Compose version floor is documented
- **WHEN** the run package relies on inline `configs.content:` and a host runs a Compose older than the documented floor
- **THEN** the package documents the required minimum Compose version so the failure is explained rather than an opaque parse error

#### Scenario: Default path is unchanged
- **WHEN** the stack is brought up without the override or the run package
- **THEN** it builds from source exactly as before, unaffected by their existence

### Requirement: The source-free run package offers an opt-in inline-configured observability stack
The source-free run package (`docker-compose.prod.yml`) SHALL include the observability stack — `loki` + `grafana-alloy` under an `observability` profile and `grafana` under a `grafana` profile, mirroring the source compose's tiers — using the pinned upstream images. Every observability config (the Loki config, the Alloy config, and the Grafana provisioning files + dashboard JSON) SHALL be supplied via top-level inline `configs.<name>.content:` blocks attached to their services in long form (a `source` plus a full-file `target:`), with NO source-tree bind-mounts, so the package stays a single source-free file. The observability services SHALL be profile-gated such that the DEFAULT no-profile invocation starts ONLY the core run unit and materializes NONE of the observability configs. Operators SHALL select the stack at startup via `COMPOSE_PROFILES` / `--profile`. The package SHALL still declare the observability data volumes (loki-data / alloy-data / grafana-data) and SHALL retain Alloy's read-only host bind `/var/lib/docker/containers` (the one inherently host-specific dependency, not a source-tree path). Grafana's runtime env tokens embedded in an inline config (`${GRAFANA_PG_USER}` / `${GRAFANA_PG_PASSWORD}`) SHALL be escaped (`$${...}`) so Compose render-time interpolation does not consume them. The Grafana Loki datasource SHALL work out-of-box once enabled; the Grafana Postgres-Audit datasource depends on an out-of-band read-only role (`grafana-ro-role.sql`) and `GRAFANA_PG_USER`/`GRAFANA_PG_PASSWORD`/`GRAFANA_ADMIN_PASSWORD` env, which the env example and self-host docs SHALL document.

#### Scenario: Observability enabled via profiles starts from inline config, source-free
- **WHEN** a runner brings up the source-free run package with `COMPOSE_PROFILES=observability,grafana` (or the equivalent `--profile` flags)
- **THEN** loki, grafana-alloy, and grafana start using their inline `configs.content:` with NO source-tree bind-mount and NO `git clone`, Alloy scrapes the host Docker logs via its read-only `/var/lib/docker/containers` bind, and Grafana provisions the Loki datasource and dashboard

#### Scenario: Default invocation is observability-free and unaffected
- **WHEN** the run package is brought up with no observability profile selected
- **THEN** `docker compose config` renders the observability services as absent, none of their inline configs are materialized, and the core stack (api + per-task sandbox image + Postgres + optional web) comes up byte-for-byte unaffected

#### Scenario: Grafana Postgres-Audit datasource documents its out-of-band prerequisites
- **WHEN** an operator enables the `grafana` profile and wants the audit_events panel
- **THEN** the docs/env example direct them to run the read-only-role SQL against the cap database and set `GRAFANA_PG_USER`/`GRAFANA_PG_PASSWORD` (and `GRAFANA_ADMIN_PASSWORD`/`GRAFANA_ROOT_URL` before exposure), and absent that step the Loki log panels still function while only the Postgres-Audit panel is unavailable

### Requirement: A release-time generator keeps the run package's inline observability config synced from the canonical source
The canonical, editable observability configuration SHALL remain the source files under `deploy/observability/` (the Loki config, the Alloy config, the Grafana provisioning files, and the dashboard JSON). The release pipeline SHALL include a step that generates and/or validates the inline `configs.content:` blocks in `docker-compose.prod.yml` from those canonical source files — including applying the `$ → $$` escaping for Grafana's runtime env tokens — so the inline blocks cannot silently drift from the source. A mismatch between the canonical source and the inline blocks SHALL fail the release check rather than ship a stale or unescaped config.

#### Scenario: Inline blocks are generated/validated from the canonical source at release time
- **WHEN** the release workflow runs
- **THEN** it derives the run package's inline observability `configs.content:` from `deploy/observability/*` (with `$$` escaping applied) and fails the check if the committed inline blocks do not match the canonical source

#### Scenario: Editing a dashboard or datasource updates the single canonical source
- **WHEN** a maintainer changes an observability dashboard or datasource
- **THEN** they edit only the file under `deploy/observability/` and the release-time generator/validator propagates or verifies the change into the run package's inline blocks, with no hand-maintained YAML-in-YAML copy

### Requirement: Releases are produced automatically from conventional commits via a human-merged release PR
The repository SHALL run release automation (release-please, `release-type: simple`) that watches the default branch, reads the conventional-commit history since the last release, and maintains an always-open **release pull request** proposing the machine-computed next semantic version (`feat`→minor, `fix`→patch, `!`/`BREAKING CHANGE`→major) together with an auto-generated `CHANGELOG.md`. Merging that release PR — and ONLY merging it — SHALL create the `vX.Y.Z` git tag and the corresponding GitHub Release, which drives the existing GHCR image pipeline. The version SHALL be a SINGLE repo-level cap version per release (one tag for the matched three-image set, decision ⑤), tracked in a release manifest seeded from the current `v0.1.0`; the automation SHALL NOT rewrite the repository's `0.0.0` package.json placeholders. The Release SHALL be published under an identity OTHER THAN the built-in Actions `GITHUB_TOKEN` (a GitHub App token or a fine-grained PAT), because a Release created by `GITHUB_TOKEN` does not trigger another workflow — without this the image-build workflow would silently not run. The pre-existing "merely committing the workflow publishes nothing / inert until a Release is published" property SHALL be preserved: ordinary commits and merges only update the release PR; nothing is built or tagged until the release PR is merged, and hand-typed version numbers are eliminated.

#### Scenario: A release PR is maintained from conventional commits
- **WHEN** releasable conventional commits (`feat`/`fix`/breaking) land on the default branch
- **THEN** the automation opens or updates a release PR proposing the computed next `vX.Y.Z` and an updated `CHANGELOG.md`, and NOTHING is tagged, released, or built yet

#### Scenario: Merging the release PR cuts the versioned Release that drives the image pipeline
- **WHEN** the maintainer merges the release PR
- **THEN** a `vX.Y.Z` git tag, a GitHub Release, and the `CHANGELOG.md` entry are created
- **AND** because the Release is published under a non-`GITHUB_TOKEN` identity, the existing `release: published` image workflow fires and builds/pushes the matched `ghcr.io/<owner>/cap-*:vX.Y.Z` (+ `:latest`) set and attaches the run package

#### Scenario: Non-releasable commits propose no release
- **WHEN** only non-releasable commits (e.g. `chore`/`docs`) have landed since the last release
- **THEN** no version bump is proposed and no release PR offers a new version, so nothing is released

#### Scenario: Versioning stays a single repo-level cap version
- **WHEN** a release is cut
- **THEN** one `vX.Y.Z` applies to the whole cap release (the matched three-image set) and the `0.0.0` package.json placeholders are left untouched

#### Scenario: Committing the automation itself publishes nothing
- **WHEN** the release-please workflow/config is merged but no release PR has been merged
- **THEN** no tag, Release, or image is produced — the inert-until-release property holds and releasing remains a deliberate human action (merging the release PR)

### Requirement: Release tail is scriptized and verifies all three images

The project SHALL provide a release script for the post-merge mechanical tail: given a target
version (or the bumped manifest version), it SHALL create the GitHub Release with a
non-`GITHUB_TOKEN` identity (so the image-build workflow fires), watch the build to success, and
verify ALL THREE published images (`cap-api`, `cap-web`, `cap-aio-sandbox`) are present at the tag.
It SHALL NOT perform the change-selection / version-bump / changelog / PR steps — those remain
operator + skill judgment. Each gate SHALL fail fast with a clear message.

#### Scenario: Release script tags and verifies all three images

- **WHEN** the release script runs against a merged, version-bumped main
- **THEN** it creates the Release under a PAT identity, the build workflow runs to success, and all three GHCR images are confirmed present at the tag

#### Scenario: Release script flags a GITHUB_TOKEN identity

- **WHEN** the script cannot confirm a non-`GITHUB_TOKEN` `gh` identity
- **THEN** it warns that the image-build workflow may not fire

### Requirement: The release skill drives the server upgrade end-to-end

The release bundling skill SHALL include a step, AFTER the post-merge tag, that directs upgrading the
running server — via the manual upgrade script or the in-app one-click — so the documented release
flow is end-to-end (PR → merge → tag → images → upgrade server → verify) rather than ending at
"images built". The step SHALL carry the force-both-images guarantee (never api alone).

#### Scenario: Release flow includes upgrading the server

- **WHEN** the release skill completes the tag + image build
- **THEN** its flow directs upgrading the server via the force-both upgrade path before the release is considered deployed

