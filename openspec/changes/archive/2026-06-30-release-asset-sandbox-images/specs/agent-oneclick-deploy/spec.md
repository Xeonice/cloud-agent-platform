## ADDED Requirements

### Requirement: Quick-deploy supports Release-asset sandbox image delivery

Quick-deploy SHALL support `CAP_SANDBOX_IMAGE_DELIVERY` with valid values
`registry`, `release-assets`, and `auto`. `registry` SHALL preserve the existing
provider image pull behavior. `release-assets` SHALL stage the selected
provider's sandbox runtime from the release image asset manifest and SHALL fail
clearly if the required asset is unavailable, invalid, or incompatible with the
host. `auto` SHALL prefer a matching Release asset for BoxLite and MAY fall back
to registry delivery only with explicit output that identifies the fallback.

#### Scenario: Invalid image delivery mode fails before mutation

- **WHEN** quick-deploy starts with an unsupported
  `CAP_SANDBOX_IMAGE_DELIVERY` value
- **THEN** it exits before downloading, loading, pulling, or starting containers
- **AND** it prints the accepted values

#### Scenario: Release asset delivery verifies manifest and checksums

- **WHEN** quick-deploy stages a sandbox runtime from Release assets
- **THEN** it downloads the release image asset manifest for `CAP_VERSION`
- **AND** it downloads the selected asset and checksum with resumable or
  temporary-file semantics
- **AND** it verifies the checksum before loading, extracting, or reporting
  provider readiness

#### Scenario: AIO asset delivery loads a Docker archive

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=aio` and Release-asset
  delivery
- **THEN** it stages the matching AIO sandbox asset by loading the Docker archive
  into the host Docker engine
- **AND** it verifies `AIO_SANDBOX_IMAGE` is inspectable locally before task
  provisioning is considered ready

#### Scenario: BoxLite asset delivery stages a rootfs path

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite` and
  Release-asset delivery
- **THEN** it stages the matching BoxLite sandbox asset into a stable local path
- **AND** it writes `BOXLITE_ROOTFS_PATH` or `BOXLITE_ROOTFS_PATH_MAP` for the
  API container instead of requiring BoxLite to pull a registry image

#### Scenario: Registry delivery remains available

- **WHEN** quick-deploy runs with `CAP_SANDBOX_IMAGE_DELIVERY=registry`
- **THEN** Linux/AIO staging continues through Docker/Compose image pulls
- **AND** BoxLite continues to use `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP`

## MODIFIED Requirements

### Requirement: Scripted source-free prebuilt-image bring-up

The project SHALL provide a committed, agent-drivable bring-up script that
stands up a cap instance from the published prebuilt images
(`ghcr.io/xeonice/cap-*:${CAP_VERSION}`) using the source-free
`docker-compose.prod.yml`, performing NO source build and requiring NO
`git clone` of the application source. The script SHALL resolve
`CAP_VERSION=latest` (or unset) to the latest GitHub Release tag, fetch
`docker-compose.prod.yml`, stage the selected provider's sandbox runtime through
the configured sandbox image delivery mode, pull the remaining version-pinned cap
image set, and `up` the stack. The compose fetch base SHALL be resolved as: a
repo-local `docker-compose.prod.yml` when the script runs from a clone;
otherwise an env-overridable base (`CAP_RAW_BASE`) whose default is the
publishing site when the script is the site-served copy (with an in-file
fallback in the committed source). The existing from-source paths (`make up`)
SHALL remain available for local development and SHALL NOT be a prerequisite of
this path. The site-hosted `install.sh` SHALL delegate to this release-image path
rather than to `make up`.

#### Scenario: Agent brings up cap from prebuilt images with no source build

- **WHEN** the script runs on a Linux/amd64 host with a reachable Docker engine
- **THEN** it fetches `docker-compose.prod.yml`, stages the selected sandbox
  runtime, pulls the required `ghcr.io/xeonice/cap-*:${CAP_VERSION}` runtime
  services, and starts the stack without compiling any image from source and
  without cloning the application source tree

#### Scenario: Agent brings up cap on macOS with BoxLite from prebuilt images

- **WHEN** the script runs on macOS with valid `BOXLITE_ENDPOINT`,
  `BOXLITE_API_TOKEN`, and either BoxLite image or rootfs configuration
- **THEN** it selects the BoxLite provider, pins the release image platform for
  api/web if needed, stages the BoxLite sandbox runtime according to the selected
  delivery mode, and starts the prebuilt stack without staging the AIO-only
  sandbox image

#### Scenario: From-source paths are unaffected

- **WHEN** the new script is added to the repository
- **THEN** `make up` continues to work for local source development, and the
  release-image install path does not depend on it

#### Scenario: Compose fetch base resolves by run context

- **WHEN** the script runs from a clone with a repo-local
  `docker-compose.prod.yml`
- **THEN** it uses the repo-local file
- **AND WHEN** it runs as the site-served copy without a repo, it fetches
  `docker-compose.prod.yml` from its default base (the publishing site), which
  `CAP_RAW_BASE` overrides

### Requirement: Quick-deploy verifies selected provider readiness

Quick-deploy SHALL verify the selected sandbox provider before reporting the
install as sandbox-ready. Linux/AIO readiness includes staging the matching AIO
sandbox image through the configured delivery mode. BoxLite readiness includes
endpoint reachability, credential validation, image or rootfs availability,
native create/start/exec compatibility, and capability compatibility with the
task smoke mode. When the BoxLite readiness endpoint is local to the install
host, readiness also includes host virtualization capability checks before
endpoint probing.

#### Scenario: Linux AIO image is staged

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=aio`
- **THEN** it stages the matching `cap-aio-sandbox:${CAP_VERSION}` runtime before
  task provisioning is considered ready
- **AND** staging uses Docker/Compose pull in registry mode or `docker load` in
  Release-asset mode

#### Scenario: macOS BoxLite endpoint is verified

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite`
- **THEN** it verifies the BoxLite endpoint and token before reporting success
- **AND** it verifies that the configured BoxLite protocol mode is compatible
  with the CAP provider implementation
- **AND** runtime readiness creates a probe sandbox without a future workspace
  `working_dir` when using native BoxLite, starts it, then execs workspace/tool
  checks
- **AND** the required tool set defaults to the AIO sandbox runtime dependency
  contract (`bash`, `claude`, `codex`, `git`, `gzip`, `node`, `openspec`, `sh`,
  `tar`, `tmux`) unless `BOXLITE_RUNTIME_REQUIRED_TOOLS` is explicitly
  overridden

#### Scenario: Local BoxLite host virtualization is verified

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite`
- **AND** the BoxLite readiness endpoint is `localhost`, `127.0.0.1`, `[::1]`,
  `0.0.0.0`, or `host.docker.internal`
- **THEN** macOS hosts must report Apple Silicon, macOS 12.0+, and
  `kern.hv_support=1`
- **AND** Linux or WSL2 hosts must expose a read/write `/dev/kvm`
- **AND** missing host virtualization fails before any BoxLite endpoint probe is
  attempted
- **AND** non-local BoxLite endpoints skip the install host Hypervisor/KVM check
  and continue with endpoint/runtime readiness

#### Scenario: Provider readiness failure blocks success

- **WHEN** the API and web containers are healthy but the selected sandbox
  provider readiness check fails
- **THEN** quick-deploy exits non-zero
- **AND** it prints the provider-specific remediation instead of reporting the
  install complete

#### Scenario: BoxLite rootfs readiness avoids registry pulls

- **WHEN** quick-deploy runs with `CAP_SANDBOX_PROVIDER=boxlite` and a staged
  `BOXLITE_ROOTFS_PATH`
- **THEN** its native runtime probe creates the probe sandbox from that rootfs
  path
- **AND** it does not require BoxLite to pull `BOXLITE_IMAGE` from GHCR
