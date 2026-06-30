## ADDED Requirements

### Requirement: Releases publish sandbox image assets

Each GitHub Release SHALL attach a version-matched sandbox image asset manifest,
checksum files, and provider-specific sandbox image artifacts for the release.
The assets SHALL be source-free and SHALL be usable by the release-image install
path without cloning the repository, running `make up`, or building sandbox
images locally. The asset manifest SHALL bind each asset to the release version,
provider, platform, artifact kind, checksum, and the local staging contract.

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

## MODIFIED Requirements

### Requirement: A GitHub-Release-triggered workflow publishes a matched, versioned image set to GHCR

The repository SHALL define a CI workflow triggered on `release: published` (and
`workflow_dispatch` for manual runs) that builds and pushes a MATCHED set of
container images -- `ghcr.io/<owner>/cap-api`, `ghcr.io/<owner>/cap-web`,
`ghcr.io/<owner>/cap-aio-sandbox`, and
`ghcr.io/<owner>/cap-boxlite-sandbox` -- ALL tagged with the SINGLE release
version `vX.Y.Z` (so a release is one matched, mutually-compatible set),
injecting `CAP_VERSION`/`GIT_SHA`/`BUILD_TIME` build args so the published images
self-report via `/version`. The workflow SHALL use the built-in token with
`packages: write` and SHALL make the published packages publicly pullable.
Merely committing the workflow SHALL NOT publish anything -- publishing occurs
only when a Release is published.

#### Scenario: Publishing a Release builds and pushes the matched image set

- **WHEN** a GitHub Release `vX.Y.Z` is published
- **THEN** the workflow builds and pushes `cap-api`, `cap-web`,
  `cap-aio-sandbox`, and `cap-boxlite-sandbox` to GHCR, all tagged `vX.Y.Z`,
  with the version build args injected
- **AND** the published packages are publicly pullable

#### Scenario: Committing the workflow is inert until a Release is cut

- **WHEN** the workflow file is merged but no Release has been published
- **THEN** no image is built or pushed and the running system is unaffected

#### Scenario: A published api image self-reports its version

- **WHEN** the `cap-api:vX.Y.Z` image published by the workflow is run and
  `GET /version` is requested
- **THEN** `version` is `vX.Y.Z` and `gitSha`/`buildTime` reflect the release
  build

### Requirement: Release tail is scriptized and verifies all three images

The project SHALL provide a release script for the post-merge mechanical tail:
given a target version (or the bumped manifest version), it SHALL create the
GitHub Release with a non-`GITHUB_TOKEN` identity (so the image-build workflow
fires), watch the build to success, and verify every published CAP image
(`cap-api`, `cap-web`, `cap-aio-sandbox`, and `cap-boxlite-sandbox`) plus the
sandbox image Release assets are present at the tag. It SHALL NOT perform the
change-selection / version-bump / changelog / PR steps -- those remain operator
and skill judgment. Each gate SHALL fail fast with a clear message.

#### Scenario: Release script tags and verifies all three images

- **WHEN** the release script runs against a merged, version-bumped main
- **THEN** it creates the Release under a PAT identity, the build workflow runs
  to success, and all CAP GHCR images plus the sandbox image Release assets are
  confirmed present at the tag

#### Scenario: Release script flags a GITHUB_TOKEN identity

- **WHEN** the script cannot confirm a non-`GITHUB_TOKEN` `gh` identity
- **THEN** it warns that the image-build workflow may not fire

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
