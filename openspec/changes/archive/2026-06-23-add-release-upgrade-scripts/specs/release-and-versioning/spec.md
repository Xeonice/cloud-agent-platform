## ADDED Requirements

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
