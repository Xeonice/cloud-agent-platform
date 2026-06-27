## MODIFIED Requirements

### Requirement: Static install script endpoint

The marketing site SHALL serve `/install.sh` as a static shell script suitable for `curl | sh`,
requiring no backend service.

#### Scenario: Script is available at a stable path

- **WHEN** the site is deployed
- **THEN** `GET /install.sh` returns `200` with a shell script body

#### Scenario: Script is static

- **WHEN** the site is exported/deployed as static assets
- **THEN** the static site returns the shell script as plain text with no server-side execution

#### Scenario: Site domain is resolved at build

- **WHEN** the site is built
- **THEN** the published `install.sh` contains the correct site domain (injected/templated at build time, not placeholders)

### Requirement: Installer wraps the release-image bring-up flow

The script SHALL bootstrap a local self-host by wrapping the release-image bring-up flow --
preflight Docker, delegate to the site-hosted `quick-deploy.sh`, fetch `docker-compose.prod.yml`,
and run the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images -- rather than cloning the
repository or running `make up`. When `CAP_VERSION` is unset, the delegated quick-deploy path SHALL
resolve it to the latest GitHub Release tag before starting the stack. The default target SHALL
select a sandbox backend by host OS: macOS defaults to the BoxLite sandbox path, Linux defaults to
the AIO sandbox path. Operators SHALL be able to override the selected provider before running the
installer.

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

The script SHALL verify prerequisites before mutating the system and SHALL exit with a clear message
when they are unmet. The preflight SHALL verify every tool the script invokes (`docker`, `curl`,
`bash`) so a host missing a required tool is stopped before fetching the release installer. For
macOS default bring-up, the delegated startup path SHALL require BoxLite connection settings before
reporting success. For Linux default bring-up, the delegated startup path SHALL verify Docker and
the AIO compose path as before.

#### Scenario: Missing Docker

- **WHEN** the script runs and Docker or `docker.sock` is not available
- **THEN** it stops before fetching/bootstrapping and prints a clear message stating the unmet prerequisite

#### Scenario: Missing bash

- **WHEN** the script runs on a host without `bash`
- **THEN** it stops before fetching quick-deploy and prints a clear message that `bash` is required

#### Scenario: macOS BoxLite default fails clearly when unavailable

- **WHEN** the installer runs on macOS with the default BoxLite provider and required BoxLite env is missing
- **THEN** the bring-up exits non-zero with a clear remediation message
- **AND** it does not report the stack as sandbox-ready

#### Scenario: Linux AIO default keeps AIO guidance

- **WHEN** the installer runs on Linux with the default AIO provider
- **THEN** it stages the matching prebuilt AIO image and reports AIO-specific failures honestly

### Requirement: Auditable and disclosed

The install experience SHALL make the script inspectable and SHALL disclose the host-root trust
boundary and manual alternative, consistent with the host-root trust boundary.

#### Scenario: Inspectable script and manual alternative are shown

- **WHEN** a visitor views the install instructions on the site
- **THEN** the inspectable script URL is shown and an equivalent `docker-compose.prod.yml` + `.env`
  alternative is presented so users are not required to pipe an unreviewed script to a shell

### Requirement: Site-hosted prebuilt one-line installer (quick-deploy)

The marketing site SHALL also serve `/quick-deploy.sh` as a static shell script suitable for
`curl | bash`. The committed repository file `scripts/quick-deploy.sh` SHALL remain the single
source-of-truth; the site-served copy SHALL be produced from it at build time (staged into the
static export and marker-substituted by the same build step that produces the published
`install.sh`), NOT a separately maintained duplicate. The published file SHALL contain literal
build-time values (site domain / compose fetch base), not placeholders, while the committed source
keeps in-file fallbacks. This ADDS a second site-hosted installer alongside `install.sh`;
`install.sh` is a friendly wrapper around this same release-image path.

#### Scenario: quick-deploy is served statically

- **WHEN** the site is deployed
- **THEN** `GET /quick-deploy.sh` returns `200` with a shell script body generated from
  `scripts/quick-deploy.sh`

#### Scenario: quick-deploy fetches compose from the site by default

- **WHEN** the site-served `quick-deploy.sh` runs without `CAP_RAW_BASE`
- **THEN** its compose fetch base resolves to the same public site that served it
- **AND** it downloads `/docker-compose.prod.yml` from that site

#### Scenario: Both installers coexist

- **WHEN** the site is inspected
- **THEN** both `install.sh` (friendly wrapper) and `quick-deploy.sh` (direct prebuilt path) are served,
  and neither removes or breaks the other

### Requirement: Prebuilt installer is auditable and discloses caveats

The site's prebuilt install path SHALL be inspectable and SHALL disclose the equivalent manual
alternative and the path's caveats, consistent with the host-root trust boundary. The site SHALL
present the inspectable `quick-deploy.sh` URL and SHALL state that this path is platform-aware
(macOS BoxLite, Linux AIO, explicit AIO requires amd64), legacy-token (not local-account
production), host-root-equivalent via `docker.sock`, and that the prebuilt `cap-web` console is
localhost-only.

#### Scenario: Inspectable URL and manual alternative disclosed

- **WHEN** a visitor views the prebuilt install option
- **THEN** the inspectable `quick-deploy.sh` URL is shown
- **AND** the equivalent manual steps (download `docker-compose.prod.yml`, run the prebuilt compose)
  are presented

#### Scenario: Caveats disclosed

- **WHEN** a visitor views the prebuilt install option
- **THEN** it states the path is platform-aware (macOS BoxLite, Linux AIO, explicit AIO requires amd64),
  legacy-token (not local-account production), host-root-equivalent, and that the prebuilt `cap-web`
  is localhost-only
