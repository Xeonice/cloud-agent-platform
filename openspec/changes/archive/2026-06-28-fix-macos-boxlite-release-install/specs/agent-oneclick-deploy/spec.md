## ADDED Requirements

### Requirement: Quick-deploy is portable across Linux and macOS shells

The prebuilt quick-deploy script SHALL avoid GNU-only assumptions on supported hosts. Time-bounded probes SHALL work when GNU `timeout` is absent, and the script SHALL support stdin execution where no script path is available.

#### Scenario: macOS without GNU timeout still probes Docker

- **WHEN** quick-deploy runs on macOS where `timeout` is not installed
- **THEN** Docker engine probes still use a bounded timeout
- **AND** a reachable Docker engine is not reported as unreachable solely because GNU `timeout` is absent

#### Scenario: Piped quick-deploy has no script path

- **WHEN** quick-deploy is executed from stdin with `bash`
- **THEN** it does not read `BASH_SOURCE[0]` unsafely
- **AND** it treats the run as a source-free site/default-base invocation

### Requirement: Quick-deploy safely refreshes managed run-package assets

Quick-deploy SHALL detect stale managed run-package files and refresh them from the selected source while preserving operator-owned secrets and data. When replacing a managed `docker-compose.prod.yml`, it SHALL write a timestamped backup before replacement. It SHALL NOT overwrite a user-managed compose file unless an explicit refresh or force option is provided.

#### Scenario: Managed stale compose is refreshed

- **WHEN** quick-deploy finds a managed `docker-compose.prod.yml` older than the selected release package
- **THEN** it backs up the existing file
- **AND** it writes the current managed compose file
- **AND** it preserves `.env`, Postgres data, and workspace volumes

#### Scenario: User-managed compose is not overwritten by default

- **WHEN** quick-deploy finds an existing compose file without a managed marker
- **THEN** it stops or prompts through a documented non-interactive force flag
- **AND** it does not silently overwrite the file

### Requirement: Quick-deploy verifies selected provider readiness

Quick-deploy SHALL verify the selected sandbox provider before reporting the install as sandbox-ready. Linux/AIO readiness includes staging the matching AIO sandbox image. BoxLite readiness includes endpoint reachability, credential validation, image availability or pull readiness, native create/start/exec compatibility, and capability compatibility with the task smoke mode. When the BoxLite readiness endpoint is local to the install host, readiness also includes host virtualization capability checks before endpoint probing.

#### Scenario: Linux AIO image is staged

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=aio`
- **THEN** it pulls the matching `cap-aio-sandbox:${CAP_VERSION}` image before task provisioning is considered ready

#### Scenario: macOS BoxLite endpoint is verified

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite`
- **THEN** it verifies the BoxLite endpoint and token before reporting success
- **AND** it verifies that the configured BoxLite protocol mode is compatible with the CAP provider implementation
- **AND** native readiness creates a probe box without a future workspace `working_dir`, starts it, then execs the workspace/tool checks

#### Scenario: Local BoxLite host virtualization is verified

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite`
- **AND** the BoxLite readiness endpoint is `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, or `host.docker.internal`
- **THEN** macOS hosts must report Apple Silicon, macOS 12.0+, and `kern.hv_support=1`
- **AND** Linux or WSL2 hosts must expose a read/write `/dev/kvm`
- **AND** missing host virtualization fails before any BoxLite endpoint probe is attempted
- **AND** non-local BoxLite endpoints skip the install host Hypervisor/KVM check and continue with endpoint/runtime readiness

#### Scenario: Provider readiness failure blocks success

- **WHEN** the API and web containers are healthy but the selected sandbox provider readiness check fails
- **THEN** quick-deploy exits non-zero
- **AND** it prints the provider-specific remediation instead of reporting the install complete

### Requirement: Quick-deploy can validate GitHub dependency with a local test token

Quick-deploy and its verification scripts SHALL support an optional local GitHub validation token for dependency checks. The token SHALL be read from an ignored local env file or process environment, SHALL be redacted in logs, and SHALL NOT be required for normal installs or unit tests.

#### Scenario: GitHub validation uses local token when present

- **WHEN** a local ignored GitHub validation token is present and GitHub dependency validation is enabled
- **THEN** the validation request authenticates to GitHub without printing the token
- **AND** the validation result reports API reachability and authentication status

#### Scenario: GitHub validation skips without token

- **WHEN** GitHub dependency validation is enabled but no local token is present
- **THEN** the validation either uses unauthenticated public API checks or skips token-specific assertions
- **AND** it prints a clear non-secret message

### Requirement: Quick-deploy end-to-end verification covers macOS with lume

The project SHALL provide a maintainer-run end-to-end verification path that uses `lume` to run a clean macOS VM, install Docker if absent, run the release-image installer, and validate the installed stack plus selected provider readiness.

#### Scenario: Lume macOS install verifies the release path

- **WHEN** the maintainer-run `lume` verification is executed on a host capable of running macOS VMs
- **THEN** it provisions or reuses a clean macOS VM
- **AND** it runs the site-style release-image install path without cloning the repository or building images locally
- **AND** it verifies `/version`, local-account login, selected provider readiness, and a task smoke matching the provider's advertised capabilities
