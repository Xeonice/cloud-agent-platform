## ADDED Requirements

### Requirement: Self-update stages sandbox runtimes by delivery mode

When self-update is enabled, the updater SHALL preserve the selected sandbox
runtime delivery mode for the target version before it recreates CAP services.
Registry-backed deployments SHALL keep the existing pull-before-recreate
behavior. Release-asset-backed deployments SHALL download, verify, and stage the
target version's sandbox runtime asset before the API is recreated or the
deployment is reported upgraded.

#### Scenario: Asset-backed AIO upgrade loads the target archive before recreate

- **WHEN** an enabled self-update targets `vX.Y.Z` on an AIO deployment using
  Release-asset sandbox image delivery
- **THEN** the updater downloads and verifies the matching AIO sandbox asset
- **AND** it loads the Docker archive so `cap-aio-sandbox:vX.Y.Z` is inspectable
  locally before recreating the API

#### Scenario: Asset-backed BoxLite upgrade stages the target rootfs before recreate

- **WHEN** an enabled self-update targets `vX.Y.Z` on a BoxLite deployment using
  Release-asset sandbox image delivery
- **THEN** the updater downloads and verifies the matching BoxLite sandbox asset
- **AND** it extracts or activates the target rootfs path and persists the
  corresponding `BOXLITE_ROOTFS_PATH` or `BOXLITE_ROOTFS_PATH_MAP` value before
  recreating the API

#### Scenario: Failed asset staging leaves the prior version running

- **WHEN** self-update cannot download, verify, load, or extract the target
  sandbox runtime asset
- **THEN** the updater fails before recreating CAP services
- **AND** the prior version remains running

#### Scenario: Post-upgrade tasks use the staged sandbox runtime

- **WHEN** a self-update completes on an asset-backed deployment and a new task
  is created afterward
- **THEN** the selected provider uses the target version's locally staged sandbox
  runtime
- **AND** task provisioning does not fail because the target sandbox image or
  rootfs is missing
