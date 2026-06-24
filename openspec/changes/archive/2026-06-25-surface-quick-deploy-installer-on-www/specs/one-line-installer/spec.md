## ADDED Requirements

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
