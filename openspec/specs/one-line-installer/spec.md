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

The script SHALL bootstrap a local self-host by wrapping the existing
`make up` flow — clone the public repository, `cd` into it, and run `make up` —
rather than reimplementing provisioning logic.

#### Scenario: Happy path bootstrap

- **WHEN** the script runs on a host with Docker and `docker.sock` available
- **THEN** it clones the repository, runs `make up`, and surfaces the printed
  `Authorization: Bearer` token to the user

#### Scenario: No bespoke provisioning

- **WHEN** the script is inspected
- **THEN** it delegates bring-up to `make up`/`make up-cp` and contains no
  independent reimplementation of the bootstrap that could drift from the repo

### Requirement: Environment preflight and honest failure

The script SHALL verify prerequisites before mutating the system and SHALL exit
with a clear message when they are unmet. The preflight SHALL verify EVERY tool the
script invokes — including `make`, which the script calls to perform the bring-up —
so a host missing a required tool is stopped BEFORE cloning rather than failing
mid-run after the repository has been cloned.

#### Scenario: Missing Docker

- **WHEN** the script runs and Docker or `docker.sock` is not available
- **THEN** it stops before cloning/bootstrapping and prints a clear message
  stating the unmet prerequisite

#### Scenario: Missing make

- **WHEN** the script runs on a host without `make` (e.g. a fresh Ubuntu / WSL)
- **THEN** it stops before cloning and prints a clear message that `make` is required,
  rather than cloning the repository and then failing when it invokes `make`

#### Scenario: Apple Silicon guidance

- **WHEN** the script runs on an arm64 host
- **THEN** it warns that the first `make up` is slow under amd64 emulation and
  points at the faster control-plane-only path (`make up-cp`)

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

