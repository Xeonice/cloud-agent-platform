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
with a clear message when they are unmet.

#### Scenario: Missing Docker

- **WHEN** the script runs and Docker or `docker.sock` is not available
- **THEN** it stops before cloning/bootstrapping and prints a clear message
  stating the unmet prerequisite

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

