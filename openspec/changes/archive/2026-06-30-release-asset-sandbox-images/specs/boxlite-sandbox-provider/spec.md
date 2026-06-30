## ADDED Requirements

### Requirement: BoxLite can provision from a local rootfs path

The BoxLite provider SHALL support a local rootfs source in addition to registry
image names. Configuration MAY provide `BOXLITE_ROOTFS_PATH` or
`BOXLITE_ROOTFS_PATH_MAP`, parallel to `BOXLITE_IMAGE` and `BOXLITE_IMAGE_MAP`.
For each runtime, the provider SHALL resolve exactly one sandbox source: either
an image name or a rootfs path. Native BoxLite create requests SHALL use
`rootfs_path` when a rootfs source is selected.

#### Scenario: Rootfs path configuration enables BoxLite without an image

- **WHEN** BoxLite env includes `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and a
  valid `BOXLITE_ROOTFS_PATH`
- **THEN** BoxLite provider configuration is valid without `BOXLITE_IMAGE`
- **AND** the provider registers with the configured capabilities after runtime
  preflight passes

#### Scenario: Native create uses rootfs_path

- **WHEN** CAP provisions a BoxLite sandbox and the resolved runtime source is a
  rootfs path
- **THEN** the native BoxLite create request includes that path as `rootfs_path`
- **AND** it does not include a registry image value for the sandbox source

#### Scenario: Image mode remains unchanged

- **WHEN** BoxLite env includes `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` and no
  rootfs path for the selected runtime
- **THEN** the provider creates sandboxes with the resolved image name exactly as
  before

#### Scenario: Ambiguous runtime source fails closed

- **WHEN** a runtime resolves to both an image name and a rootfs path
- **THEN** BoxLite provider configuration is invalid
- **AND** the error identifies the conflicting runtime source configuration

#### Scenario: Rootfs path is rejected for unsupported protocol mode

- **WHEN** BoxLite rootfs-path configuration is selected with a protocol mode
  that cannot create native rootfs sandboxes
- **THEN** provider readiness fails with a clear compatibility error
- **AND** CAP does not advertise the BoxLite provider as ready

## MODIFIED Requirements

### Requirement: BoxLite provider registration is explicit and capability-gated

The system SHALL register a BoxLite sandbox provider only when BoxLite
configuration is explicitly present. The provider SHALL declare only capabilities
that its configured client, sandbox source, and runtime preflight have validated,
and it SHALL NOT be selected for a task whose required capabilities are not fully
satisfied.

#### Scenario: BoxLite is disabled by default

- **WHEN** no BoxLite provider configuration is present
- **THEN** no BoxLite provider candidate is registered
- **AND** the existing AIO provider remains the default sandbox provider

#### Scenario: Invalid BoxLite configuration fails closed

- **WHEN** BoxLite configuration is present but the endpoint, credential, image
  mapping, rootfs mapping, or client mode is invalid
- **THEN** the BoxLite provider is not advertised as eligible for task
  provisioning
- **AND** task provisioning selects another compatible provider or fails with a
  provider-selection error

#### Scenario: BoxLite capabilities gate selection

- **WHEN** a task requires capabilities that BoxLite does not advertise
- **THEN** the scheduler does not select BoxLite for that task

### Requirement: BoxLite runtime preflight proves image readiness

Before BoxLite is selected for a runtime, the system SHALL preflight the selected
BoxLite sandbox source for required tools and runtime CLIs. The source MAY be a
registry image or a local rootfs path. Missing tools, an unreadable rootfs path,
or an unsupported sandbox source SHALL fail provider eligibility before
credentials are injected, workspace materialization runs, or a long-running task
slot is consumed.

#### Scenario: Missing tmux blocks interactive selection

- **WHEN** the selected BoxLite sandbox source lacks `tmux` for an interactive
  runtime
- **THEN** runtime preflight fails and BoxLite is not selected for that task

#### Scenario: Missing agent CLI blocks runtime selection

- **WHEN** a task selects a runtime whose CLI is absent from the BoxLite sandbox
  source
- **THEN** runtime preflight fails with a distinct image/tooling error

#### Scenario: Missing rootfs path blocks selection

- **WHEN** BoxLite is configured with a rootfs path that is absent or unreadable
  by the BoxLite service
- **THEN** runtime preflight fails with a distinct rootfs readiness error
- **AND** BoxLite is not selected for that task

### Requirement: BoxLite readiness probes validate image and workspace assumptions

BoxLite readiness probes SHALL validate that the configured image, image map,
rootfs path, or rootfs map can create and start a sandbox, create or verify the
configured workspace path during command execution, and execute commands required
for provider preflight. Native probes SHALL follow the same live BoxLite
contract as the runtime client: create without unsupported labels or a future
workspace `working_dir`, call the native start endpoint, then exec
workspace/tool checks. Missing image, missing rootfs path, missing shell, missing
workspace path, or incompatible architecture SHALL fail readiness before task
creation is reported usable.

#### Scenario: BoxLite image missing required runtime tools fails readiness

- **WHEN** the configured BoxLite sandbox source starts but lacks required
  shell/runtime tools for the advertised capabilities
- **THEN** the readiness probe fails with a distinct image/tooling error
- **AND** the provider is not selected for tasks requiring those capabilities

#### Scenario: Native readiness mirrors create-start-exec runtime contract

- **WHEN** quick-deploy runs a native BoxLite readiness probe
- **THEN** it creates the probe sandbox without `working_dir`
- **AND** it calls the native start endpoint before command execution
- **AND** it performs workspace and tool checks through exec after the sandbox is
  running

#### Scenario: Native readiness can probe rootfs path

- **WHEN** quick-deploy runs a native BoxLite readiness probe with
  `BOXLITE_ROOTFS_PATH`
- **THEN** it creates the probe sandbox from `rootfs_path`
- **AND** it performs the same start, workspace, and tool checks as image mode
