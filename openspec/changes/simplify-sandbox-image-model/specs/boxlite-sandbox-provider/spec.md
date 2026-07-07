## MODIFIED Requirements

### Requirement: BoxLite provisions from a resolved environment source

The BoxLite provider SHALL provision a task sandbox from the resolved sandbox
environment when the environment source is a BoxLite image reference. Managed
BoxLite environments SHALL NOT model local rootfs paths, release assets, or other
delivery-specific local paths as custom image sources. If task creation omits an
environment and no managed default exists, BoxLite SHALL continue to use the
existing deployment-level provider configuration for the server default.

#### Scenario: Selected BoxLite image environment is used

- **WHEN** a task selects a ready BoxLite image environment
- **THEN** BoxLite creates the sandbox with that resolved image source
- **AND** it does not use `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` for that task

#### Scenario: BoxLite rootfs managed environment is rejected

- **WHEN** a task or API request resolves a managed environment source kind that
  represents a BoxLite rootfs path
- **THEN** task admission or provider selection rejects the environment before
  provisioning
- **AND** BoxLite does not create a sandbox from that managed rootfs source

#### Scenario: Omitted environment preserves current BoxLite default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** BoxLite resolves the source from the existing deployment-level
  provider configuration for the selected runtime
- **AND** existing BoxLite deployments continue to provision as before

#### Scenario: BoxLite does not silently fall back on mismatch

- **WHEN** a task selects an environment that is not ready or not compatible with
  the selected runtime/provider family
- **THEN** BoxLite provisioning is not attempted
- **AND** CAP returns an environment compatibility error rather than silently
  using a different BoxLite image
