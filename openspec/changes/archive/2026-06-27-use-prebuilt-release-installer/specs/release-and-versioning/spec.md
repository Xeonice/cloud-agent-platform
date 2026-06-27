## MODIFIED Requirements

### Requirement: Release images and source-free run packages

The project SHALL provide a way for a self-hoster to run the pinned prebuilt GHCR images instead of
building from source, pinning all cap images to the SAME version, in BOTH of these shapes, while the
DEFAULT compose path remains build-from-source (additive and opt-in):

1. an OVERLAY (`docker-compose.images.yml`) layered onto the source `docker-compose.yml` (`-f base -f images`), for users who have the source tree and a layer-capable compose runner; and
2. a SELF-CONTAINED, SOURCE-FREE run package (`docker-compose.prod.yml`) that has NO `build:` blocks
   and NO source-tree bind-mounts -- the cap services run `image: ghcr.io/<owner>/cap-*:${CAP_VERSION}`
   which uses Docker's `latest` tag when unset while preserving the image-baked concrete version for
   `/version`; operators MAY pin an explicit version for a reproducible / rollback-able deploy. Env
   comes from a local `.env` next to the compose (and is otherwise optional), and the package needs
   NO `git clone`. This run package splits RUN from BUILD and SHALL be attached to each GitHub
   Release (alongside an env example) so it is obtainable without the source. It MAY scope to the
   core run unit (api + Postgres + an optional web console, plus AIO image staging when the AIO
   provider is selected) and exclude only source-coupled services that bind-mount config from the
   source tree (the reverse proxy), which operators provide separately; observability is NOT
   excluded -- it ships as an opt-in inline-configured stack.

The run package SHALL be runnable as a RESIDENT production stack and, when brought up against an
existing deployment with the matching compose project name, SHALL reuse that deployment's existing
named volumes, network, and env (e.g. an existing `files/api.env`) rather than creating fresh ones
-- so adopting the run package in place of a prior build-from-source deployment is
behavior-neutral (same data, same secrets, same network), with `prisma migrate deploy` a no-op on
the already-migrated database.

The published images MAY be single-architecture (`linux/amd64`); the run package SHALL pin or
document the image platform so supported non-amd64 hosts (macOS BoxLite) run api/web through
Docker's platform emulation rather than falling back to a source build. Provider-specific limits
SHALL remain honest: explicit AIO staging on non-amd64 hosts may be rejected with
BoxLite/control-plane guidance. The run package SHALL document the minimum Docker Compose version it
requires (Compose Spec >= v2.23.1, for inline `configs.content:`).

#### Scenario: Source-free run package runs without the source tree

- **WHEN** a runner obtains only the self-contained run package (`docker-compose.prod.yml` + its env example) -- e.g. downloaded from a Release -- fills the `.env`, and runs `docker compose -f docker-compose.prod.yml up -d`
- **THEN** the stack pulls and runs the `ghcr.io/<owner>/cap-*` images with NO `git clone` and NO
  source-tree bind-mounts, resolving an unset `CAP_VERSION` to Docker's `latest` tag (never a blank
  tag) while allowing an explicit pin and preserving the image-baked concrete version for `/version`

#### Scenario: Platform/provider requirement is documented

- **WHEN** the published images are single-architecture and a non-amd64 host runs the package
- **THEN** the run package documents the `linux/amd64` platform pin, the macOS BoxLite path, and the
  explicit AIO/non-amd64 rejection so the behavior is explained rather than opaque

### Requirement: Release docs document the platform-aware prebuilt install path

The release and self-host documentation SHALL document the source-free prebuilt run package as the
install path. The installer SHALL document macOS defaulting to BoxLite and Linux defaulting to AIO,
with explicit AIO on non-amd64 hosts rejected before staging. Source `make up` remains documented as
a local development/custom-build path. Both paths SHALL document that api/web host ports bind to
`0.0.0.0` by default while public DNS, TLS, reverse proxy, auth callback/cookie scope, and firewall
setup remain operator-owned.

#### Scenario: Release run-package caveats remain honest

- **WHEN** a user reads the source-free run-package docs
- **THEN** the docs state that the prebuilt path is BoxLite-capable on macOS and AIO-capable on Linux
- **AND** they state that explicit AIO staging on non-amd64 hosts is rejected with guidance

#### Scenario: Prebuilt install docs show platform defaults

- **WHEN** a user reads the installer docs
- **THEN** macOS is documented as defaulting to BoxLite and Linux as defaulting to AIO

#### Scenario: Public exposure is documented as operator configuration

- **WHEN** a user reads install or release docs
- **THEN** all-interface host binding is documented separately from public DNS/TLS/proxy/OAuth/cookie/firewall configuration
