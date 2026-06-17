## ADDED Requirements

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
