# one-line-installer Specification

## Purpose
TBD - created by archiving change add-marketing-www-site. Update Purpose after archive.
## Requirements
### Requirement: Site-hosted install script

The site SHALL host an `install.sh` as a static asset (served from the site's
own deployment) consumable as `curl -fsSL https://<domain>/install.sh | sh`,
requiring no backend service.

#### Scenario: Script is served statically

- **WHEN** a client requests `https://<domain>/install.sh`
- **THEN** the static site returns the shell script as plain text with no
  server-side execution

#### Scenario: Site domain is resolved at build

- **WHEN** the site is built
- **THEN** the published `install.sh` contains the correct site domain
  (injected/templated at build time, not placeholders)

### Requirement: Installer wraps the release-image bring-up flow

The script SHALL bootstrap a local self-host by wrapping the release-image bring-up flow — preflight Docker, delegate to the site-hosted `quick-deploy.sh`, fetch `docker-compose.prod.yml`, and run the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images — rather than cloning the repository or running `make up`. When `CAP_VERSION` is unset, the delegated quick-deploy path SHALL resolve it to the latest GitHub Release tag before starting the stack. The default target SHALL select a sandbox backend by host OS: macOS defaults to the BoxLite sandbox path, Linux defaults to the AIO sandbox path. Operators SHALL be able to override the selected provider before running the installer.

#### Scenario: macOS bootstrap defaults to BoxLite

- **WHEN** the site-hosted installer runs on macOS with no provider override
- **THEN** it delegates to the BoxLite-backed prebuilt bring-up path without cloning the repository
- **AND** the resulting local stack is configured to register BoxLite as the default eligible sandbox provider

#### Scenario: Linux bootstrap defaults to AIO

- **WHEN** the site-hosted installer runs on Linux with no provider override
- **THEN** it delegates to the AIO-backed prebuilt bring-up path without cloning the repository
- **AND** the AIO sandbox image is staged from the matching release image

#### Scenario: Provider override is honored

- **WHEN** an operator sets an explicit provider override before running the installer
- **THEN** the installer passes that choice to the release-image bring-up path rather than applying OS auto-selection

#### Scenario: No source build

- **WHEN** the script is inspected
- **THEN** it contains no `git clone`, no `make up`, and no local image build

### Requirement: Environment preflight and honest failure

The script SHALL verify prerequisites before mutating the system and SHALL exit with a clear message when they are unmet. The preflight SHALL distinguish a missing Docker CLI, missing Docker Compose plugin, and installed-but-unreachable Docker engine. When Docker is absent, the installer SHALL attempt a platform-supported Docker installation path before fetching the release installer: Linux MAY install Docker Engine plus the Compose plugin using the host package manager and start the service; macOS MAY bootstrap Homebrew only when needed, then install missing Docker CLI, Compose, and Colima formulae. When Docker CLI exists but Compose is missing, the installer SHALL install only the Compose plugin and SHALL NOT reinstall Docker Engine. When Docker is already installed and usable, the installer SHALL leave it untouched. When Docker is installed but its daemon/socket/context is not reachable, the installer SHALL NOT reinstall or upgrade Docker; it MAY perform bounded safe starts such as `systemctl start docker` or `colima start`, then SHALL fail with exact remediation if `docker info` still fails. The preflight SHALL verify every non-Docker tool the script invokes (`curl`, `bash`, `openssl`, `awk`) so a host missing a required tool is stopped before fetching the release installer. For macOS default bring-up, the delegated startup path SHALL require BoxLite connection settings and provider readiness before reporting success. For Linux default bring-up, the delegated startup path SHALL verify Docker and the AIO compose path as before.

#### Scenario: Missing Docker is installed on supported Linux

- **WHEN** the installer runs on a supported Linux host with no Docker CLI installed
- **THEN** it installs Docker Engine and the Compose plugin through the supported package-manager path
- **AND** it starts or enables the Docker service as needed
- **AND** it proceeds only after `docker info` succeeds for the current installer context

#### Scenario: Missing Docker is installed on macOS

- **WHEN** the installer runs on macOS with no Docker CLI installed
- **THEN** it uses existing Homebrew or bootstraps Homebrew only if it is absent
- **AND** it installs only missing Docker CLI, Compose, and Colima formulae
- **AND** it starts Colima as needed
- **AND** it proceeds only after `docker info` succeeds for the current installer context

#### Scenario: Missing Compose installs only Compose

- **WHEN** Docker CLI is present but `docker compose version` fails because the Compose plugin is missing
- **THEN** the installer installs only the Compose plugin for the detected host OS
- **AND** it does not reinstall Docker Engine, Docker Desktop, or Colima

#### Scenario: Existing usable Docker is untouched

- **WHEN** the installer runs and Docker CLI, Docker Compose, and `docker info` already work
- **THEN** it does not install, upgrade, restart, or change Docker context
- **AND** it proceeds to the release-image installer

#### Scenario: Installed but unreachable Docker is not reinstalled

- **WHEN** Docker CLI is present but `docker info` fails after bounded safe starts
- **THEN** the installer stops before fetching/bootstrapping
- **AND** it prints a clear message stating that Docker is installed but the daemon/socket/context is not reachable
- **AND** it does not reinstall or upgrade Docker

#### Scenario: Missing bash

- **WHEN** the script runs on a host without `bash`
- **THEN** it stops before fetching quick-deploy and prints a clear message that `bash` is required

#### Scenario: macOS BoxLite default fails clearly when unavailable

- **WHEN** the installer runs on macOS with the default BoxLite provider and required BoxLite env or readiness checks are missing
- **THEN** the bring-up exits non-zero with a clear remediation message
- **AND** it does not report the stack as sandbox-ready

#### Scenario: Linux AIO default keeps AIO guidance

- **WHEN** the installer runs on Linux with the default AIO provider
- **THEN** it stages the matching prebuilt AIO image and reports AIO-specific failures honestly

### Requirement: Auditable and disclosed

The install path SHALL be inspectable and the site SHALL disclose an equivalent
manual alternative, consistent with the host-root trust boundary.

#### Scenario: Manual alternative disclosed

- **WHEN** a visitor views the install instructions on the site
- **THEN** the inspectable script URL is shown and an equivalent manual
  `docker-compose.prod.yml` + `.env` alternative is presented so users are not required to
  pipe an unreviewed script to a shell

### Requirement: Site-hosted prebuilt one-line installer (quick-deploy)

The site SHALL ALSO host the prebuilt-image bring-up script `quick-deploy.sh` as a static asset
(served from the site's own deployment) consumable as
`curl -fsSL https://<domain>/quick-deploy.sh | bash`, requiring no backend service. The repo's
`scripts/quick-deploy.sh` SHALL remain the single source-of-truth: the published copy SHALL be
produced from it at build time (staged into the static export and marker-substituted by the same
build step that produces the published `install.sh`), NOT a separately maintained duplicate. The
published file SHALL contain literal build-time values (site domain / compose fetch base), not
placeholders, while the committed source keeps in-file fallbacks. This ADDS a second site-hosted
installer alongside `install.sh`; `install.sh` is a friendly wrapper around this same release-image path.

#### Scenario: quick-deploy is served statically

- **WHEN** a client requests `https://<domain>/quick-deploy.sh`
- **THEN** the static site returns the shell script as plain text with no server-side execution

#### Scenario: Published quick-deploy is built from the repo source-of-truth with resolved markers

- **WHEN** the site is built
- **THEN** the published `quick-deploy.sh` is generated from `scripts/quick-deploy.sh` with the
  site domain / compose fetch base substituted to literal values (not placeholders), and there is
  no second hand-maintained copy of the script that could drift from the repo source

#### Scenario: Both installers coexist

- **WHEN** the site is inspected
- **THEN** both `install.sh` (friendly wrapper) and `quick-deploy.sh` (direct prebuilt path) are served,
  and neither removes or breaks the other

### Requirement: Site-hosted prod compose asset

The site SHALL serve `docker-compose.prod.yml` as a static asset
(`https://<domain>/docker-compose.prod.yml`), staged from the repo at build time, so the
site-hosted `quick-deploy.sh` run is self-contained and version-consistent with the site rather
than depending on a GitHub branch at runtime. The published `quick-deploy.sh` SHALL default its
compose fetch base to the site so it retrieves this asset, while remaining overridable.

#### Scenario: Compose file is served statically

- **WHEN** a client requests `https://<domain>/docker-compose.prod.yml`
- **THEN** the static site returns the compose file as plain text, and a site-hosted
  `quick-deploy.sh | bash` run fetches it from the site without needing a clone or a GitHub fetch

#### Scenario: Fetch base is overridable

- **WHEN** `CAP_RAW_BASE` is set before running the published `quick-deploy.sh`
- **THEN** the script fetches the compose file from that base instead of the site default

### Requirement: Prebuilt installer is auditable and discloses caveats

The site's prebuilt install path SHALL be inspectable and SHALL disclose the equivalent manual
alternative and the path's caveats, consistent with the host-root trust boundary. The site SHALL
present the inspectable `quick-deploy.sh` URL and SHALL state that this path is platform-aware
(macOS BoxLite, Linux AIO, explicit AIO requires amd64), legacy-token (not local-account production),
host-root-equivalent via `docker.sock`, and that the prebuilt `cap-web` console is localhost-only.

#### Scenario: Inspectable URL and manual alternative disclosed

- **WHEN** a visitor views the prebuilt install instructions on the site
- **THEN** the inspectable `quick-deploy.sh` URL is shown and the equivalent manual steps
  (download `docker-compose.prod.yml`, run the prebuilt compose) are presented, so users are not
  required to pipe an unreviewed script to a shell

#### Scenario: Caveats disclosed

- **WHEN** a visitor views the prebuilt install option
- **THEN** it states the path is platform-aware (macOS BoxLite, Linux AIO, explicit AIO requires amd64),
  legacy-token (not local-account production), host-root-equivalent, and that the prebuilt `cap-web`
  is localhost-only

### Requirement: Installer discloses all-interface binding without configuring public access

The installer output SHALL state that the local api/web host ports bind to `0.0.0.0` by default, while public DNS, TLS, reverse proxy, OAuth callback URL, cookie domain, and firewall exposure remain operator-managed configuration.

#### Scenario: Public access is not implied

- **WHEN** installer bring-up completes
- **THEN** the output identifies the all-interface bind and the local access URL
- **AND** it does not claim that a public domain or TLS endpoint has been configured automatically

### Requirement: Installer reports external dependency classes

The installer SHALL report install-time dependencies separately from task-time optional dependencies. Install-time dependencies include shell tools, Docker/Compose/socket, release asset endpoints, image registries, and selected sandbox provider readiness. Task-time dependencies include repository host access, forge credentials, OpenAI or Claude auth, package registries used by the task repository, and optional SMTP.

#### Scenario: Dependency report separates install and task dependencies

- **WHEN** the installer prints preflight or failure output
- **THEN** required install-time dependencies are identified separately from optional task-time dependencies
- **AND** missing optional task-time dependencies do not block a basic password-login install unless a corresponding smoke test is enabled

### Requirement: Site installer remains pipe-safe

The site-hosted installer SHALL be executable through `curl -fsSL https://<domain>/install.sh | sh` and SHALL delegate to a quick-deploy path that is safe when its script file path is unavailable.

#### Scenario: Piped installer delegates without BASH_SOURCE

- **WHEN** `install.sh` pipes the site-hosted `quick-deploy.sh` into `bash`
- **THEN** quick-deploy does not require `BASH_SOURCE[0]`
- **AND** it still locates or fetches the source-free compose asset without cloning the repository
