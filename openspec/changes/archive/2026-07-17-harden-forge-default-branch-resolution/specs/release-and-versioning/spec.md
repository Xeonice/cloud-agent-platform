## MODIFIED Requirements

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
