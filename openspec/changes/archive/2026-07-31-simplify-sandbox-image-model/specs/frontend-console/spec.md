## MODIFIED Requirements

### Requirement: Console exposes sandbox image management

The console SHALL expose a left-sidebar `镜像管理` product navigation entry that
opens an authenticated `/images` page for task startup image/default management.
The `/settings` access/defaults form SHALL render a user-scoped default image
selector as a plain dropdown backed by account settings; the saved value SHALL
follow the current user and SHALL be used for new task creation when no
per-task override is supplied. The `/images` page SHALL be dedicated to the
admin-only image library. Image-library controls SHALL be separate from the user
default selector and SHALL be hidden behind an explicit add/import action rather
than occupying the settings form. The image library SHALL list sandbox
environments with name, provider family, image reference, runtime compatibility,
readiness status, and last validation time. Admins SHALL be able to create/import
an AIO image or BoxLite image, run validation, inspect validation errors, and
view/copy provider-specific extension templates. The settings area SHALL NOT
surface image-library management controls.

#### Scenario: Admin opens image management from the sidebar

- **WHEN** an admin opens the console sidebar
- **THEN** the sidebar includes `镜像管理`
- **WHEN** the admin opens `/images`
- **THEN** the page shows the admin image library with configured images,
  readiness, and compatibility information
- **AND** validation details are available without crowding the main list

#### Scenario: Admin imports an AIO image

- **WHEN** an admin chooses to add an image and selects provider `AIO`
- **THEN** the form asks for an image name, a pinned image reference, and optional
  runtime compatibility
- **AND** the form does not expose an `AIO loaded image` source type

#### Scenario: Admin imports a BoxLite image

- **WHEN** an admin chooses to add an image and selects provider `BoxLite`
- **THEN** the form asks for an image name, a pinned image reference, and optional
  runtime compatibility
- **AND** the form does not expose a `BoxLite rootfs` source type

#### Scenario: Image extension template is available

- **WHEN** an admin is adding or viewing an AIO or BoxLite image
- **THEN** the image library provides a copyable Dockerfile template derived from
  the matching official CAP sandbox base image
- **AND** it provides build, tag, push, and import guidance using a pinned tag
  rather than `latest`

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
