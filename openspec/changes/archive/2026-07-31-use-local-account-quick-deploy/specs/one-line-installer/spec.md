## MODIFIED Requirements

### Requirement: Installer wraps the release-image bring-up flow

The script SHALL bootstrap a local self-host by wrapping the release-image bring-up flow - preflight Docker, delegate to the site-hosted `quick-deploy.sh`, fetch `docker-compose.prod.yml`, and run the published `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images - rather than cloning the repository or running `make up`. When `CAP_VERSION` is unset, the delegated quick-deploy path SHALL resolve it to the latest GitHub Release tag before starting the stack. The default target SHALL select a sandbox backend by host OS: macOS defaults to the BoxLite sandbox path, Linux defaults to the AIO sandbox path. Operators SHALL be able to override the selected provider before running the installer. The install output SHALL direct operators to log in with the printed admin email/password, not a shared legacy bearer token.

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

#### Scenario: Local account credential is surfaced

- **WHEN** the installer completes successfully
- **THEN** it directs the operator to log in with the admin email/password printed by quick-deploy
- **AND** it does not direct the operator to use an `Authorization: Bearer` token for console login

### Requirement: Prebuilt installer is auditable and discloses caveats

The site's prebuilt install path SHALL be inspectable and SHALL disclose the equivalent manual alternative and the path's caveats, consistent with the host-root trust boundary. The site SHALL present the inspectable `quick-deploy.sh` URL and SHALL state that this path is platform-aware (macOS BoxLite, Linux AIO, explicit AIO requires amd64), local-account based, host-root-equivalent via `docker.sock`, and that the prebuilt `cap-web` console is localhost-only.

#### Scenario: Inspectable URL and manual alternative disclosed

- **WHEN** a visitor views the prebuilt install instructions on the site
- **THEN** the inspectable `quick-deploy.sh` URL is shown and the equivalent manual steps (download `docker-compose.prod.yml`, run the prebuilt compose) are presented, so users are not required to pipe an unreviewed script to a shell

#### Scenario: Caveats disclosed

- **WHEN** a visitor views the prebuilt install option
- **THEN** it states the path is platform-aware (macOS BoxLite, Linux AIO, explicit AIO requires amd64), local-account based, host-root-equivalent, and that the prebuilt `cap-web` is localhost-only
