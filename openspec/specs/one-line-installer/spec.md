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

#### Scenario: Repo URL and domain are resolved at build

- **WHEN** the site is built
- **THEN** the published `install.sh` contains the correct public repository URL
  and site domain (injected/templated at build time, not placeholders)

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

### Requirement: Auditable and disclosed

The install path SHALL be inspectable and the site SHALL disclose an equivalent
manual alternative, consistent with the host-root trust boundary.

#### Scenario: Manual alternative disclosed

- **WHEN** a visitor views the install instructions on the site
- **THEN** the inspectable script URL is shown and an equivalent manual
  `git clone … && make up` alternative is presented so users are not required to
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
installer alongside `install.sh`; the existing source-build install path is preserved.

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
- **THEN** both `install.sh` (source build) and `quick-deploy.sh` (prebuilt images) are served,
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
present the inspectable `quick-deploy.sh` URL and SHALL state that this path is amd64-only,
legacy-token (not OAuth-first production), host-root-equivalent via `docker.sock`, and that the
prebuilt `cap-web` console is localhost-only.

#### Scenario: Inspectable URL and manual alternative disclosed

- **WHEN** a visitor views the prebuilt install instructions on the site
- **THEN** the inspectable `quick-deploy.sh` URL is shown and the equivalent manual steps
  (download `docker-compose.prod.yml`, run the prebuilt compose) are presented, so users are not
  required to pipe an unreviewed script to a shell

#### Scenario: Caveats disclosed

- **WHEN** a visitor views the prebuilt install option
- **THEN** it states the path is amd64-only, legacy-token (not OAuth-first production),
  host-root-equivalent, and that the prebuilt `cap-web` is localhost-only

### Requirement: Installer discloses all-interface binding without configuring public access

The installer output SHALL state that the local api/web host ports bind to `0.0.0.0` by default, while public DNS, TLS, reverse proxy, OAuth callback URL, cookie domain, and firewall exposure remain operator-managed configuration.

#### Scenario: Public access is not implied

- **WHEN** installer bring-up completes
- **THEN** the output identifies the all-interface bind and the local access URL
- **AND** it does not claim that a public domain or TLS endpoint has been configured automatically

