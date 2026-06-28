## MODIFIED Requirements

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

## ADDED Requirements

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
