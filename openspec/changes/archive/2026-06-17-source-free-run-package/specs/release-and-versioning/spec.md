## MODIFIED Requirements

### Requirement: A documented prebuilt-image self-host path exists without changing the default
The project SHALL provide a way for a self-hoster to run the pinned prebuilt GHCR images instead of building from source, pinning all cap images to the SAME version, in BOTH of these shapes, while the DEFAULT compose path remains build-from-source (additive and opt-in):

1. an OVERLAY (`docker-compose.images.yml`) layered onto the source `docker-compose.yml` (`-f base -f images`), for users who have the source tree and a layer-capable compose runner; and
2. a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`) that has NO `build:` blocks and NO source-tree bind-mounts — the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}` with a required-variable pin (an unset version MUST fail loudly, never run a stray tag), env comes from a local `.env` next to the compose (and is otherwise optional), and the package needs NO `git clone`. This run package splits RUN from BUILD and SHALL be attached to each GitHub Release (alongside an env example) so it is obtainable without the source. It MAY scope to the core run unit (api + the per-task sandbox image + Postgres + an optional web console) and exclude source-coupled services (reverse proxy / observability), which operators provide separately.

The published images MAY be single-architecture (amd64); the run package SHALL document any host-architecture requirement so an unsupported host gets a clear reason rather than an opaque pull error.

#### Scenario: Opt-in image override runs pinned prebuilt images
- **WHEN** a self-hoster brings the stack up with the documented image override at a pinned version
- **THEN** the stack runs the prebuilt `ghcr.io/<owner>/cap-*` images at that single version rather than building from source

#### Scenario: Source-free run package runs without the source tree
- **WHEN** a runner obtains only the self-contained run package (`docker-compose.prod.yml` + its env example) — e.g. downloaded from a Release — fills the `.env`, and runs `docker compose -f docker-compose.prod.yml up -d`
- **THEN** the stack pulls and runs the pinned `ghcr.io/<owner>/cap-*` images with NO `git clone` and NO source-tree bind-mounts, and an unset `CAP_VERSION` fails loudly instead of running a stray tag

#### Scenario: Run package is distributed via Release assets
- **WHEN** a Release is published
- **THEN** the self-contained run package and its env example are attached to that Release as downloadable assets

#### Scenario: Host-architecture requirement is documented
- **WHEN** the published images are single-architecture and a host of another architecture attempts to run the package
- **THEN** the run package documents the required architecture so the failure is explained rather than opaque

#### Scenario: Default path is unchanged
- **WHEN** the stack is brought up without the override or the run package
- **THEN** it builds from source exactly as before, unaffected by their existence
