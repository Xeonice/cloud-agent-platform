## MODIFIED Requirements

### Requirement: BoxLite provisions from a resolved environment source

The BoxLite provider SHALL provision a task sandbox from the resolved sandbox
environment when the managed environment source is a compatible BoxLite registry
image reference. If task creation omits an environment and no managed default
exists, BoxLite SHALL continue to use the existing deployment-level image/rootfs
configuration and runtime maps. Managed BoxLite environment selection SHALL NOT
accept rootfs paths, loaded-image handles, uploaded artifacts, or local
provider-specific source descriptors.

#### Scenario: Selected BoxLite image environment is used

- **WHEN** a task selects a ready BoxLite image environment
- **THEN** BoxLite creates the sandbox with that resolved registry image source
- **AND** it does not use `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` for that task

#### Scenario: Managed BoxLite rootfs environment is rejected

- **WHEN** a task or environment record attempts to select a BoxLite rootfs-path
  environment as a managed image-library source
- **THEN** BoxLite provisioning is not attempted
- **AND** CAP returns an unsupported environment source error

#### Scenario: Omitted environment preserves current BoxLite default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** BoxLite resolves the source from the existing deployment-level
  image/rootfs configuration for the selected runtime
- **AND** existing BoxLite deployments continue to provision as before

#### Scenario: BoxLite does not silently fall back on mismatch

- **WHEN** a task selects an environment that is not ready or not compatible with
  the selected runtime/provider family
- **THEN** BoxLite provisioning is not attempted
- **AND** CAP returns an environment compatibility error rather than silently
  using a different BoxLite image/rootfs
