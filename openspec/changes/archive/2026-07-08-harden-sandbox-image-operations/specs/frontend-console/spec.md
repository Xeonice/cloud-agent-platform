## ADDED Requirements

### Requirement: Image library exposes environment retirement and validation guidance

The console image library SHALL let admins retire failed or obsolete sandbox
environment records from the management surface while preserving their
diagnostic validation history. The UI SHALL refresh the environment list after
retirement, SHALL NOT expose retired environments in the settings default-image
selector, and SHALL present provider validation failures with enough context for
operators to distinguish registry reachability, authorization, architecture, and
missing-tool problems.

#### Scenario: Admin retires an image from the image library

- **WHEN** an admin activates the retire action for a sandbox image record
- **THEN** the console calls the admin lifecycle API
- **AND** the retired image no longer appears as selectable for task creation or
  user default-image settings

#### Scenario: Validation failure shows actionable detail

- **WHEN** image validation fails and the validation record contains provider
  failure details
- **THEN** the image library displays the non-secret failure reason and probe
  details
- **AND** the operator can tell whether the likely issue is registry access,
  image architecture, missing runtime tools, or provider configuration

### Requirement: Custom image help keeps product and deployment paths separate

The console custom image help SHALL present registry image references as the
managed image-library path and SHALL present BoxLite OCI rootfs customization as
an advanced deployment-level server-default path. The help SHALL NOT describe
BoxLite rootfs paths or loaded Docker images as image-library source types.

#### Scenario: Image-library instructions use registry references

- **WHEN** an operator reads the console custom image guide for `/images`
- **THEN** the guide instructs them to build, tag, push, register, and validate
  a pinned AIO or BoxLite image reference
- **AND** it does not ask them to select rootfs or loaded-image source types

#### Scenario: BoxLite rootfs guide is labeled deployment-level

- **WHEN** an operator reads the BoxLite rootfs customization guidance
- **THEN** the guide labels it as a deployment-level server default using
  `BOXLITE_ROOTFS_PATH`
- **AND** it states that this path is used only when no managed image
  environment is selected
