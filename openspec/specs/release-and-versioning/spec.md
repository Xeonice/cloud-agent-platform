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

The repository SHALL define a CI workflow triggered on `release: published` and
`workflow_dispatch` that builds and pushes a matched set of
`ghcr.io/<owner>/cap-api`, `cap-web`, `cap-aio-sandbox`, and
`cap-boxlite-sandbox`, all tagged with one `vX.Y.Z` release version and built
with `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME`. The final `cap-api` runtime image SHALL
contain the Git executable required by production remote-ref resolution. Before
the API image is published, the workflow SHALL execute a container-level
dependency smoke against the built artifact, including `git --version`, and
SHALL fail without pushing a known-bad API image when the command is absent or
not executable. The workflow SHALL use the built-in token with `packages: write`
and make published packages publicly pullable. Merely committing the workflow
SHALL remain inert until a Release is published.

#### Scenario: Publishing a Release builds and pushes the matched image set

- **WHEN** a GitHub Release `vX.Y.Z` is published
- **THEN** the workflow builds and pushes all four matched CAP images with version metadata
- **AND** the published packages are publicly pullable

#### Scenario: Built API image proves its Git runtime dependency before push

- **WHEN** the release workflow builds `cap-api:vX.Y.Z`
- **THEN** it runs the required Git executable inside that exact image before publication
- **AND** a missing or non-executable Git binary fails the image job instead of publishing it

#### Scenario: API runtime preflight rejects a missing Git dependency before serving

- **WHEN** a packaged or custom API runtime starts without an executable Git dependency
- **THEN** the bounded startup preflight fails before the API begins serving traffic
- **AND** startup reports only a safe platform-dependency reason without a credential, command argument, or raw diagnostic

#### Scenario: Committing the workflow is inert until a Release is cut

- **WHEN** the workflow file is merged but no Release has been published
- **THEN** no image is built or pushed and the running system is unaffected

#### Scenario: A published api image self-reports its version

- **WHEN** the published `cap-api:vX.Y.Z` image serves `GET /version`
- **THEN** `version` is `vX.Y.Z` and gitSha/buildTime reflect the release build

### Requirement: A documented prebuilt-image self-host path exists without changing the default
The project SHALL provide a way for a self-hoster to run the pinned prebuilt GHCR images instead of building from source, pinning all cap images to the SAME version, in BOTH of these shapes, while the DEFAULT compose path remains build-from-source (additive and opt-in):

1. an OVERLAY (`docker-compose.images.yml`) layered onto the source `docker-compose.yml` (`-f base -f images`), for users who have the source tree and a layer-capable compose runner; and
2. a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`) that has NO `build:` blocks and NO source-tree bind-mounts — the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}` which uses Docker's `latest` tag when unset while preserving the image-baked concrete version for `/version`; operators MAY pin an explicit version for a reproducible / rollback-able deploy. Env comes from a local `.env` next to the compose (and is otherwise optional), and the package needs NO `git clone`. This run package splits RUN from BUILD and SHALL be attached to each GitHub Release (alongside an env example) so it is obtainable without the source. It MAY scope to the core run unit (api + Postgres + an optional web console, plus AIO image staging when the AIO provider is selected) and exclude only source-coupled services that bind-mount config from the source tree (the reverse proxy), which operators provide separately; observability is NOT excluded — it ships as an opt-in inline-configured stack (see "The source-free run package offers an opt-in inline-configured observability stack").

The run package SHALL be runnable as a RESIDENT production stack and, when brought up against an existing deployment with the matching compose project name, SHALL reuse that deployment's existing named volumes, network, and env (e.g. an existing `files/api.env`) rather than creating fresh ones — so adopting the run package in place of a prior build-from-source deployment is behavior-neutral (same data, same secrets, same network), with `prisma migrate deploy` a no-op on the already-migrated database.

The published images MAY be single-architecture (`linux/amd64`); the run package SHALL pin or document the image platform so supported non-amd64 hosts (macOS BoxLite) run api/web through Docker's platform emulation rather than falling back to a source build. Provider-specific limits SHALL remain honest: explicit AIO staging on non-amd64 hosts may be rejected with BoxLite/control-plane guidance. The run package SHALL document the minimum Docker Compose version it requires (Compose Spec >= v2.23.1, for inline `configs.content:`).

#### Scenario: Opt-in image override runs pinned prebuilt images
- **WHEN** a self-hoster brings the stack up with the documented image override at a pinned version
- **THEN** the stack runs the prebuilt `ghcr.io/<owner>/cap-*` images at that single version rather than building from source

#### Scenario: Source-free run package runs without the source tree
- **WHEN** a runner obtains only the self-contained run package (`docker-compose.prod.yml` + its env example) — e.g. downloaded from a Release — fills the `.env`, and runs `docker compose -f docker-compose.prod.yml up -d`
- **THEN** the stack pulls and runs the `ghcr.io/<owner>/cap-*` images with NO `git clone` and NO source-tree bind-mounts, resolving an unset `CAP_VERSION` to Docker's `latest` tag (never a blank tag) while allowing an explicit pin and preserving the image-baked concrete version for `/version`

#### Scenario: Run package is distributed via Release assets
- **WHEN** a Release is published
- **THEN** the self-contained run package and its env example are attached to that Release as downloadable assets

#### Scenario: Platform/provider requirement is documented
- **WHEN** the published images are single-architecture and a non-amd64 host runs the package
- **THEN** the run package documents the `linux/amd64` platform pin, the macOS BoxLite path, and the explicit AIO/non-amd64 rejection so the behavior is explained rather than opaque

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

The project SHALL provide a release script for the post-merge mechanical tail:
given a target version or the bumped manifest version, it SHALL create the GitHub Release with a
non-`GITHUB_TOKEN` identity, watch the build to success, and verify every
published CAP image (`cap-api`, `cap-web`, `cap-aio-sandbox`, and
`cap-boxlite-sandbox`) plus sandbox Release assets at the tag. Verification
SHALL include executing or equivalently attesting the required Git runtime
dependency in the published `cap-api` image, not merely checking that its tag
exists. The script SHALL NOT perform change selection, version bump, changelog,
or PR judgment. Each gate SHALL fail fast with a clear message.

#### Scenario: Release script tags and verifies every image and API dependency

- **WHEN** the release script runs against a merged version-bumped main branch
- **THEN** it creates the Release, observes a successful build, and confirms all CAP images and sandbox assets
- **AND** it verifies the published API image can execute its required Git dependency

#### Scenario: Release script flags a GITHUB_TOKEN identity

- **WHEN** the script cannot confirm a non-`GITHUB_TOKEN` GitHub identity
- **THEN** it warns that the image-build workflow may not fire

### Requirement: The release skill drives the server upgrade end-to-end

The release bundling skill SHALL include a step, AFTER the post-merge tag, that directs upgrading the
running server — via the manual upgrade script or the in-app one-click — so the documented release
flow is end-to-end (PR → merge → tag → images → upgrade server → verify) rather than ending at
"images built". The step SHALL carry the force-both-images guarantee (never api alone).

#### Scenario: Release flow includes upgrading the server

- **WHEN** the release skill completes the tag + image build
- **THEN** its flow directs upgrading the server via the force-both upgrade path before the release is considered deployed

### Requirement: Release docs document the platform-aware prebuilt install path

The release and self-host documentation SHALL document the source-free prebuilt run package as the install path. The installer SHALL document macOS defaulting to BoxLite and Linux defaulting to AIO, with explicit AIO on non-amd64 hosts rejected before staging. Source `make up` remains documented as a local development/custom-build path. Both paths SHALL document that api/web host ports bind to `0.0.0.0` by default while public DNS, TLS, reverse proxy, auth callback/cookie scope, and firewall setup remain operator-owned.

#### Scenario: Release run-package caveats remain honest

- **WHEN** a user reads the source-free run-package docs
- **THEN** the docs state that the prebuilt path is BoxLite-capable on macOS and AIO-capable on Linux
- **AND** they state that explicit AIO staging on non-amd64 hosts is rejected with guidance

#### Scenario: Prebuilt install docs show platform defaults

- **WHEN** a user reads the installer docs
- **THEN** macOS is documented as defaulting to BoxLite and Linux as defaulting to AIO

#### Scenario: Public exposure is documented as operator configuration

- **WHEN** a user reads install or release docs
- **THEN** all-interface host binding is documented separately from public DNS/TLS/proxy/OAuth/cookie/firewall configuration

### Requirement: Release install docs enumerate external dependencies

The release and self-host documentation SHALL enumerate external dependencies by
phase: install-time required dependencies, selected-provider dependencies, and
task-time optional dependencies. The docs SHALL make clear which missing
dependencies block install and which only affect later task execution or optional
features. When Release-asset sandbox image delivery is selected, the docs SHALL
list the GitHub Release asset endpoint, image asset manifest, checksum files,
local staging directory, and selected provider runtime probe as install-time
dependencies.

#### Scenario: Docs separate install-time dependencies

- **WHEN** a user reads the release-image install documentation
- **THEN** required install-time dependencies include shell tooling,
  Docker/Compose/socket, release asset endpoints, GHCR images or Release sandbox
  image assets according to the selected delivery mode, Docker Hub Postgres
  image, and selected provider readiness
- **AND** selected-provider dependencies include BoxLite endpoint/token/protocol
  plus either image or rootfs-path readiness, and native create/start/exec runtime
  tool checks when BoxLite is selected
- **AND** optional task-time dependencies such as GitHub/GitLab/Gitee repo
  access, optional GitHub validation token, OpenAI or Claude auth, package
  registries, public DNS/TLS/proxy, external Postgres, and SMTP are listed
  separately

#### Scenario: Docs describe Docker install behavior

- **WHEN** a user reads the installer documentation
- **THEN** it states that Docker is installed only when absent
- **AND** it states that a missing Compose plugin is installed without
  reinstalling Docker Engine
- **AND** it states that an existing usable Docker installation is left untouched
- **AND** it states that installed-but-unreachable Docker is treated as a
  daemon/socket/context issue rather than a reinstall trigger

### Requirement: Releases publish sandbox image assets

Each GitHub Release SHALL attach a version-matched sandbox image asset manifest,
checksum files, and provider-specific sandbox image artifacts for the release.
The assets SHALL be source-free and SHALL be usable by the release-image install
path without cloning the repository, running `make up`, or building sandbox
images locally. The asset manifest SHALL bind each asset to the release version,
provider, platform, artifact kind, checksum, and the local staging contract. When
a compressed logical artifact would reach the GitHub Release per-file limit, the
workflow SHALL publish it as ordered parts smaller than that limit. The manifest
SHALL retain the logical artifact checksum and size and SHALL list every part's
name, checksum, and size so consumers can verify both each part and the ordered
combined stream without publishing the oversized logical file.
Manifests carrying toolchain metadata or ordered parts SHALL use schema version 2;
consumers SHALL continue to accept schema-version-1 manifests as legacy
single-file manifests without toolchain metadata.

#### Scenario: Release includes a sandbox image asset manifest

- **WHEN** a GitHub Release `vX.Y.Z` is published
- **THEN** the Release assets include `cap-image-assets.json`
- **AND** that manifest lists the available AIO and BoxLite sandbox assets for
  `vX.Y.Z` with checksums and platform metadata

#### Scenario: Release includes an AIO Docker archive asset

- **WHEN** the release workflow publishes `vX.Y.Z`
- **THEN** the Release assets include a compressed Docker archive for
  `cap-aio-sandbox:vX.Y.Z` on the supported AIO platform
- **AND** the asset can be loaded with Docker without building from source

#### Scenario: Release includes a BoxLite rootfs asset

- **WHEN** the release workflow publishes `vX.Y.Z`
- **THEN** the Release assets include a compressed BoxLite-compatible rootfs or
  OCI-layout asset for `cap-boxlite-sandbox:vX.Y.Z` on the supported BoxLite
  platform
- **AND** the asset can be staged locally without requiring BoxLite to pull the
  image from GHCR during sandbox creation

#### Scenario: Missing or mismatched sandbox assets fail release verification

- **WHEN** a release verification step inspects `vX.Y.Z`
- **THEN** it fails if the manifest is missing, a listed asset is missing, or a
  listed checksum does not match the uploaded asset

#### Scenario: Oversized sandbox asset is published as verified parts

- **WHEN** a compressed sandbox artifact is too large for one GitHub Release asset
- **THEN** the release publishes deterministic ordered parts, each below the
  platform limit and carrying its own checksum
- **AND** the manifest records the logical artifact checksum and size plus every
  part's checksum and size
- **AND** release verification fails on a missing, reordered, truncated, or
  checksum-mismatched part

### Requirement: Release image assets remain coupled to the GHCR image set

Sandbox image assets SHALL be generated from the same versioned release images
that are pushed to GHCR. The release workflow SHALL NOT publish an asset with a
different CAP version, runtime toolchain, or image digest than the matched
release image it represents.

#### Scenario: Asset generation follows successful image publication

- **WHEN** the release workflow packages sandbox image assets
- **THEN** it uses the already-published `ghcr.io/xeonice/cap-aio-sandbox:vX.Y.Z`
  and `ghcr.io/xeonice/cap-boxlite-sandbox:vX.Y.Z` images as inputs
- **AND** it records the source image identity in the asset manifest

#### Scenario: Asset packaging does not replace GHCR publication

- **WHEN** a Release is published
- **THEN** GHCR images are still published for registry-backed installs
- **AND** Release image assets are attached as an additional distribution path

### Requirement: Official sandbox releases publish matching toolchain metadata

The release workflow SHALL build the official AIO and BoxLite sandbox images with the same exact sandbox, Codex, Claude Code, and OpenSpec version inputs. Release verification SHALL read the required metadata from both published images and their packaged offline assets and SHALL fail when metadata is missing, invalid, mismatched between distribution forms, or does not identify the target CAP release.

#### Scenario: Official images share one toolchain contract
- **WHEN** a CAP release builds the official AIO and BoxLite sandbox images
- **THEN** both images contain schema-version-1 metadata with identical official dependency versions
- **AND** each metadata document identifies the target CAP release as its sandbox version

#### Scenario: Offline assets preserve image metadata
- **WHEN** release CI packages the AIO Docker archive and BoxLite OCI/rootfs assets from the published images
- **THEN** the metadata contained in each packaged asset equals the corresponding published image metadata

#### Scenario: Release verification rejects metadata drift
- **WHEN** an official sandbox image or packaged asset is missing metadata or contains different dependency versions from its sibling artifact
- **THEN** the release verification fails and does not report the sandbox artifact set complete
