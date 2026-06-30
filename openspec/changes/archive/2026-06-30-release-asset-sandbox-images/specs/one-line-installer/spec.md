## ADDED Requirements

### Requirement: Installer reports sandbox image asset dependencies

The site one-line installer and prebuilt install documentation SHALL describe
sandbox image Release assets as install-time dependencies when the selected
sandbox image delivery mode uses Release assets. The output SHALL distinguish
Release asset reachability, checksum validation, local staging/storage, provider
runtime readiness, and task-time package/repository dependencies.

#### Scenario: Preflight output names Release asset dependencies

- **WHEN** the installer runs with Release-asset sandbox image delivery
- **THEN** its preflight or progress output identifies the release image asset
  manifest, selected sandbox asset, checksum validation, and local staging path
  as install-time dependencies
- **AND** it keeps task-time dependencies such as repository access, agent auth,
  and package registries separate

#### Scenario: Asset failure reports provider-specific remediation

- **WHEN** sandbox image asset download, checksum validation, Docker load, or
  BoxLite rootfs extraction fails
- **THEN** the installer exits non-zero
- **AND** it reports whether the failure is a Release asset, local storage,
  Docker, or BoxLite readiness problem

#### Scenario: Registry caveat remains documented

- **WHEN** a user reads the prebuilt install option
- **THEN** it documents that `CAP_SANDBOX_IMAGE_DELIVERY=registry` uses GHCR
  sandbox image pulls
- **AND** it documents that Release-asset delivery can avoid BoxLite pulling the
  sandbox image from GHCR during sandbox creation
