## MODIFIED Requirements

### Requirement: Scripted source-free prebuilt-image bring-up

The project SHALL provide a committed, agent-drivable bring-up script that stands up a cap instance
from the **published prebuilt images** (`ghcr.io/xeonice/cap-*:${CAP_VERSION}`) using the
source-free `docker-compose.prod.yml`, performing NO source build and requiring NO `git clone` of
the application source. The script SHALL resolve `CAP_VERSION=latest` (or unset) to the latest
GitHub Release tag, fetch `docker-compose.prod.yml`, `pull` the version-pinned image set, and `up`
the stack. The compose fetch base SHALL be resolved as: a repo-local `docker-compose.prod.yml` when
the script runs from a clone; otherwise an env-overridable base (`CAP_RAW_BASE`) whose default is
the publishing site when the script is the site-served copy (with an in-file fallback in the
committed source). The existing from-source paths (`make up`) SHALL remain available for local
development and SHALL NOT be a prerequisite of this path. The site-hosted `install.sh` SHALL
delegate to this release-image path rather than to `make up`.

#### Scenario: Agent brings up cap from prebuilt images with no source build

- **WHEN** the script runs on a Linux/amd64 host with a reachable Docker engine
- **THEN** it fetches `docker-compose.prod.yml`, pulls the `ghcr.io/xeonice/cap-*:${CAP_VERSION}`
  set, and starts the stack without compiling any image from source and without cloning the
  application source tree

#### Scenario: Agent brings up cap on macOS with BoxLite from prebuilt images

- **WHEN** the script runs on macOS with valid `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and `BOXLITE_IMAGE`
- **THEN** it selects the BoxLite provider, pins the release image platform for api/web if needed,
  and starts the prebuilt stack without staging the AIO-only sandbox image

#### Scenario: From-source paths are unaffected

- **WHEN** the new script is added to the repository
- **THEN** `make up` continues to work for local source development, and the release-image install
  path does not depend on it

#### Scenario: Compose fetch base resolves by run context

- **WHEN** the committed script is run from a source checkout that includes `docker-compose.prod.yml`
- **THEN** it uses the repo-local compose file
- **WHEN** the site-served script is run outside a checkout
- **THEN** it fetches compose from the publishing site unless `CAP_RAW_BASE` is set

### Requirement: Platform/provider gate for prebuilt images

The prebuilt quick-deploy script SHALL gate the selected sandbox provider rather than blocking the
whole prebuilt path on architecture. macOS/arm64 SHALL be supported through the BoxLite provider,
with api/web release images run through an explicit `linux/amd64` platform pin when the published
image set is single-architecture. Explicit AIO on a non-amd64 host SHALL stop before pulling/staging
the AIO sandbox image and print BoxLite/control-plane guidance, instead of failing later with an
opaque manifest error.

#### Scenario: arm64 macOS uses BoxLite prebuilt path

- **WHEN** the prebuilt quick-deploy script runs on arm64 macOS with valid BoxLite env
- **THEN** it proceeds with `CAP_SANDBOX_PROVIDER=boxlite` and `CAP_IMAGE_PLATFORM=linux/amd64`
- **AND** it does not stage `aio-sandbox-image`

#### Scenario: explicit AIO on non-amd64 fails clearly

- **WHEN** the prebuilt quick-deploy script runs on a non-amd64 host with `CAP_SANDBOX_PROVIDER=aio`
- **THEN** it stops before pulling and prints that AIO sandbox staging requires amd64 by default
- **AND** it directs the user to BoxLite or control-plane mode

#### Scenario: amd64 AIO host passes the gate

- **WHEN** the prebuilt quick-deploy script runs on an x86_64 Linux host
- **THEN** the provider/platform gate passes and the prebuilt AIO bring-up proceeds

### Requirement: Positioned as legacy-token self-host, not local-account production

The script and its documentation SHALL make explicit that this path is the legacy-token,
localhost/trial-or-single-user self-host path and NOT the local-account production deploy. It SHALL
preserve the host-root-equivalent disclosure (it mounts the host `docker.sock`) and SHALL state the
localhost-only caveat for the prebuilt `cap-web` (its `VITE_*` are baked to localhost at build time,
so the in-compose console is only correct for a same-host trial).

#### Scenario: Positioning and caveats are disclosed

- **WHEN** a user reads the script header or the self-hosting documentation for this path
- **THEN** it states this is legacy-token (not local-account production), that it is
  host-root-equivalent via `docker.sock`, and that the prebuilt `cap-web` console is localhost-only

### Requirement: Prebuilt install is the site one-line path

The prebuilt quick-deploy path SHALL be the release-image path used by the site one-line installer.
The source `make up` path remains available for local development, but the site installer SHALL NOT
clone the repository or invoke it.

#### Scenario: Site installer delegates to quick-deploy

- **WHEN** `install.sh` is present on the site
- **THEN** it delegates to `quick-deploy.sh` and runs the same platform-aware prebuilt images
