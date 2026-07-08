## MODIFIED Requirements

### Requirement: Console exposes sandbox image management

The console SHALL expose a left-sidebar `镜像管理` product navigation entry that
opens an authenticated `/images` page for task startup image/default management.
The `/settings` access/defaults form SHALL render a user-scoped default image
selector as a plain dropdown backed by account settings; the saved value SHALL
follow the current user and SHALL be used for new task creation when no per-task
override is supplied. The `/images` page SHALL be dedicated to the admin-only
image library. Image-library controls SHALL be separate from the user default
selector and SHALL be hidden behind an explicit image-reference registration
action rather than occupying the settings form. The image library SHALL list
sandbox environments with name, provider family/source kind, runtime
compatibility, readiness status, and last validation time. Admins SHALL be able
to register an existing AIO or BoxLite registry image reference, run validation,
and inspect validation errors. The settings area SHALL NOT surface
image-library management controls. The image library SHALL NOT present upload,
build, registry-hosting, registry-credential, loaded-image, or rootfs-source
controls.

#### Scenario: Admin opens image management from the sidebar

- **WHEN** an admin opens the console sidebar
- **THEN** the sidebar includes `镜像管理`
- **WHEN** the admin opens `/images`
- **THEN** the page shows the admin image library with configured environments,
  readiness, and compatibility information
- **AND** validation details are available without crowding the main list

#### Scenario: Admin registers an existing image reference

- **WHEN** an admin opens the image registration form
- **THEN** the form asks for a display name, provider family, already-published
  image reference, and optional runtime ids
- **AND** the primary action uses registration/reference language rather than
  upload/build language
- **AND** the form links to the external build/push guide and base-image
  templates

#### Scenario: Operator chooses their own default image

- **WHEN** an authenticated operator opens `/settings`
- **THEN** the access/defaults form shows a plain default-image dropdown
- **WHEN** the operator selects a ready image and saves
- **THEN** the account settings response stores that image id as
  `defaultSandboxEnvironmentId`
- **AND** a later task created without an explicit sandbox environment uses that
  user's saved image

#### Scenario: Non-admin cannot edit environments

- **WHEN** a non-admin operator opens image management or settings
- **THEN** the operator can still set their own default image
- **AND** environment management actions are absent or disabled
- **AND** direct API attempts to mutate environments are rejected by the backend

#### Scenario: Validation failure is visible

- **WHEN** an environment validation fails
- **THEN** the image-library detail view shows the latest failure reason and probe
  summary
- **AND** the environment is shown as not selectable for new tasks

### Requirement: Custom image help keeps product and deployment paths separate

The console custom image help SHALL present registry image references as the
managed image-library path and SHALL present BoxLite OCI rootfs customization as
an advanced deployment-level server-default path. The help SHALL instruct
operators to extend the official AIO or BoxLite base image, build and push it
with their own Docker/CI/registry tooling, register the resulting reference in
CAP, and validate it before users can select it. The help SHALL NOT describe
BoxLite rootfs paths, loaded Docker images, upload artifacts, or CAP-built
images as image-library source types.

#### Scenario: Image-library instructions use registry references

- **WHEN** an operator reads the console custom image guide for `/images`
- **THEN** the guide instructs them to build, tag, push, register, and validate
  a pinned AIO or BoxLite image reference
- **AND** it does not ask them to select rootfs or loaded-image source types
- **AND** it states that CAP does not build, upload, host, or publish the image

#### Scenario: BoxLite rootfs guide is labeled deployment-level

- **WHEN** an operator reads the BoxLite rootfs customization guidance
- **THEN** the guide labels it as a deployment-level server default using
  `BOXLITE_ROOTFS_PATH`
- **AND** it states that this path is used only when no managed image
  environment is selected
- **AND** it does not describe rootfs as a user-selectable image-library option
