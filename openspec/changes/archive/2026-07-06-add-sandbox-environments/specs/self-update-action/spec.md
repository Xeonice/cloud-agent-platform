## ADDED Requirements

### Requirement: Self-update preserves custom sandbox environments

Self-update SHALL preserve managed custom sandbox environment records and SHALL
NOT overwrite them with the release default sandbox image/rootfs. When the target
CAP version changes the sandbox contract or required runtime tooling, self-update
SHALL either revalidate custom environments or mark them stale before future task
creation can use them.

#### Scenario: Custom environments survive upgrade

- **WHEN** an enabled self-update upgrades CAP to a new version
- **THEN** managed custom sandbox environments remain in the registry
- **AND** their source descriptors are not replaced by the release default image
  or rootfs

#### Scenario: Contract change marks custom environments stale

- **WHEN** the target CAP version requires a newer sandbox contract than a custom
  environment last validated against
- **THEN** that environment is marked stale or scheduled for revalidation
- **AND** new task creation cannot select it until it becomes ready again

#### Scenario: Release default staging remains available

- **WHEN** self-update stages the target release's default sandbox runtime asset
- **THEN** the staged release default remains available as the deployment fallback
- **AND** custom environments are preserved as separate managed choices
