## MODIFIED Requirements

### Requirement: Installer wraps the real bring-up flow

The script SHALL bootstrap a local self-host by wrapping the existing repository bring-up flow — clone the public repository, `cd` into it, and run the platform-aware make target — rather than reimplementing provisioning logic. The default target SHALL select a sandbox backend by host OS: macOS defaults to the BoxLite sandbox path, Linux defaults to the AIO sandbox path. Operators SHALL be able to override the selected provider before running the installer.

#### Scenario: macOS bootstrap defaults to BoxLite

- **WHEN** the site-hosted installer runs on macOS with no provider override
- **THEN** it clones the repository and delegates to the BoxLite-backed bring-up path
- **AND** the resulting local stack is configured to register BoxLite as the default eligible sandbox provider

#### Scenario: Linux bootstrap defaults to AIO

- **WHEN** the site-hosted installer runs on Linux with no provider override
- **THEN** it clones the repository and delegates to the AIO-backed bring-up path
- **AND** the existing AIO sandbox image build/staging behavior is preserved

#### Scenario: Provider override is honored

- **WHEN** an operator sets an explicit provider override before running the installer
- **THEN** the installer passes that choice to the repository bring-up target rather than applying OS auto-selection

#### Scenario: No bespoke provisioning

- **WHEN** the script is inspected
- **THEN** it delegates bring-up to repository make/script targets and contains no independent reimplementation of the bootstrap that could drift from the repo

### Requirement: Environment preflight and honest failure

The script SHALL verify prerequisites before mutating the system and SHALL exit with a clear message when they are unmet. The preflight SHALL verify every tool the script invokes — including `make`, which the script calls to perform the bring-up — so a host missing a required tool is stopped before cloning rather than failing mid-run after the repository has been cloned. For macOS default bring-up, the delegated startup path SHALL verify that BoxLite can be started or reached before reporting success. For Linux default bring-up, the delegated startup path SHALL verify Docker and the AIO compose path as before.

#### Scenario: Missing Docker

- **WHEN** the script runs and Docker or `docker.sock` is not available
- **THEN** it stops before cloning/bootstrapping and prints a clear message stating the unmet prerequisite

#### Scenario: Missing make

- **WHEN** the script runs on a host without `make` (e.g. a fresh Ubuntu / WSL)
- **THEN** it stops before cloning and prints a clear message that `make` is required, rather than cloning the repository and then failing when it invokes `make`

#### Scenario: macOS BoxLite default fails clearly when unavailable

- **WHEN** the installer runs on macOS with the default BoxLite provider and BoxLite cannot be started or reached
- **THEN** the bring-up exits non-zero with a clear remediation message
- **AND** it does not report the stack as sandbox-ready

#### Scenario: Linux AIO default keeps AIO guidance

- **WHEN** the installer runs on Linux with the default AIO provider
- **THEN** it preserves the existing AIO image build/staging guidance and reports AIO-specific failures honestly

## ADDED Requirements

### Requirement: Installer discloses all-interface binding without configuring public access

The installer output SHALL state that the local api/web host ports bind to `0.0.0.0` by default, while public DNS, TLS, reverse proxy, OAuth callback URL, cookie domain, and firewall exposure remain operator-managed configuration.

#### Scenario: Public access is not implied

- **WHEN** installer bring-up completes
- **THEN** the output identifies the all-interface bind and the local access URL
- **AND** it does not claim that a public domain or TLS endpoint has been configured automatically
