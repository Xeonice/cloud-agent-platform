# agent-oneclick-deploy Specification

## Purpose

Provide a scripted, source-free, agent-drivable bring-up that stands up a cap instance
from published prebuilt images using `docker-compose.prod.yml` — performing no source
build and no `git clone` of the application source, requiring no GitHub OAuth app
(legacy operator-token auth instead), and gating on architecture and Docker engine
reachability before any mutation, with health verification and credential surfacing.

## Requirements

### Requirement: Scripted source-free prebuilt-image bring-up

The project SHALL provide a committed, agent-drivable bring-up script that stands up a cap
instance from the **published prebuilt images** (`ghcr.io/xeonice/cap-*:${CAP_VERSION}`) using
the source-free `docker-compose.prod.yml`, performing NO source build and requiring NO
`git clone` of the application source. The script SHALL fetch `docker-compose.prod.yml`,
`pull` the version-pinned image set, and `up` the stack, defaulting `CAP_VERSION` to a
published tag. The compose fetch base SHALL be resolved as: a repo-local `docker-compose.prod.yml`
when the script runs from a clone; otherwise an env-overridable base (`CAP_RAW_BASE`) whose
default is the publishing site when the script is the site-served copy (with an in-file fallback
in the committed source). The existing from-source paths (`make up`, `install.sh` → `make up`)
SHALL remain unchanged and SHALL NOT be a prerequisite of this path.

#### Scenario: Agent brings up cap from prebuilt images with no source build

- **WHEN** the script runs on an amd64 host with a reachable Docker engine
- **THEN** it fetches `docker-compose.prod.yml`, pulls the `ghcr.io/xeonice/cap-*:${CAP_VERSION}`
  set, and starts the stack without compiling any image from source and without cloning the
  application source tree

#### Scenario: From-source paths are unaffected

- **WHEN** the new script is added to the repository
- **THEN** `make up` and `install.sh` → `make up` continue to work exactly as before, and the
  new path does not depend on them

#### Scenario: Compose fetch base resolves by run context

- **WHEN** the script runs from a clone with a repo-local `docker-compose.prod.yml`
- **THEN** it uses the repo-local file; **AND WHEN** it runs as the site-served copy without a
  repo, it fetches `docker-compose.prod.yml` from its default base (the publishing site), which
  `CAP_RAW_BASE` overrides

### Requirement: No GitHub OAuth required via synthesized legacy-token env

The script SHALL boot the prebuilt images WITHOUT a GitHub OAuth app by synthesizing a
legacy-token `.env` next to the compose file: it SHALL enable the legacy operator-token path
(`AUTH_TOKEN_LEGACY_ENABLED=true`) with a strong random `AUTH_TOKEN`, and generate strong
random `SESSION_SECRET` and `CODEX_CRED_ENC_KEY`. The synthesis SHALL be IDEMPOTENT and
NON-DESTRUCTIVE: an existing `.env` SHALL be reused as-is and never overwritten, and the
generated file SHALL remain gitignored so no secret is written to a tracked file.

#### Scenario: Prebuilt image boots without an OAuth app

- **WHEN** the script synthesizes the `.env` and brings up the stack
- **THEN** the prebuilt api boots and authenticates operators via the legacy bearer token,
  with no GitHub OAuth app configured

#### Scenario: Existing env is reused, never overwritten

- **WHEN** the script runs and a `.env` already exists next to the compose file
- **THEN** it reuses that `.env` unchanged and does not regenerate or overwrite it

#### Scenario: Generated secrets are not tracked

- **WHEN** the script generates the `.env`
- **THEN** the file is gitignored and no secret value is written into any tracked file

### Requirement: Architecture gate for amd64-only prebuilt images

The script SHALL verify the host architecture is amd64/x86_64 BEFORE pulling, because the
published images (including the per-task AIO sandbox base) are amd64-only. On a non-amd64 host
(e.g. arm64 / Apple Silicon) it SHALL stop with a clear message that directs the user to the
from-source `make up` path instead of failing later with an opaque manifest error.

#### Scenario: arm64 host is stopped early with guidance

- **WHEN** the script runs on an arm64 host
- **THEN** it stops before pulling and prints that the prebuilt images are amd64-only and that
  the from-source `make up` path should be used instead

#### Scenario: amd64 host passes the gate

- **WHEN** the script runs on an x86_64 host
- **THEN** the architecture gate passes and the bring-up proceeds

### Requirement: Docker engine reachability gate with WSL self-heal and honest remediation

The script SHALL verify the Docker engine is reachable BEFORE fetching, pulling, or starting
anything, so a dead engine never leaves a half-bootstrapped host. When the engine is
unreachable it SHALL attempt bounded, non-destructive self-heal — selecting a live non-default
Docker context if one exists, and, on a WSL host with interop available, requesting Docker
Desktop to start and waiting a bounded time. If the engine is still unreachable after
self-heal, the script SHALL STOP with an exact human remediation (enable Docker Desktop WSL
Integration for the distro, or `sudo systemctl restart docker`) rather than proceeding.

#### Scenario: Unreachable engine stops before any mutation

- **WHEN** the script runs and `docker info` fails and self-heal does not recover it
- **THEN** it stops before fetching/pulling/starting and prints the precise remediation steps,
  leaving the host unmodified

#### Scenario: WSL self-heal recovers a reachable engine

- **WHEN** the script runs on a WSL host where a live non-default context exists or Docker
  Desktop can be started via interop
- **THEN** it selects/starts that engine and proceeds once `docker info` succeeds

### Requirement: Health verification and credential surfacing

After bringing up the stack the script SHALL wait until the api `/health` reports ready within
a bounded timeout and SHALL print the `Authorization: Bearer` token to use, along with the api
and (when the web profile is enabled) web URLs and the teardown command. The printed teardown
command SHALL be correct for the profiles that were brought up: when the web console was started
(the `web` profile), the teardown hint SHALL include the `web` profile so it actually removes the
profile-gated `cap-web` (a bare `docker compose down` leaves it running). If `/health` does not
become ready within the bound, the script SHALL fail loudly and point at the api logs.

#### Scenario: Healthy bring-up surfaces the token

- **WHEN** the stack starts and the api becomes healthy
- **THEN** the script prints the bearer token and the api URL, and a subsequent request to a
  token-gated route with that bearer succeeds while an unauthenticated request is rejected

#### Scenario: Teardown hint matches the started profiles

- **WHEN** the bring-up started the web console (web profile enabled)
- **THEN** the printed teardown command includes the `web` profile so running it removes
  `cap-web` as well as the api/postgres, leaving no orphaned profile-gated container

#### Scenario: Unhealthy bring-up fails loudly

- **WHEN** the api does not report `/health` ready within the timeout
- **THEN** the script exits non-zero with a message pointing at the api logs

### Requirement: Positioned as legacy-token self-host, not OAuth-first production

The script and its documentation SHALL make explicit that this path is the legacy-token,
localhost/trial-or-single-user self-host path and NOT the OAuth-first production deploy. It
SHALL preserve the host-root-equivalent disclosure (it mounts the host `docker.sock`) and SHALL
state the localhost-only caveat for the prebuilt `cap-web` (its `VITE_*` are baked to localhost
at build time, so the in-compose console is only correct for a same-host trial).

#### Scenario: Positioning and caveats are disclosed

- **WHEN** a user reads the script header or the self-hosting documentation for this path
- **THEN** it states this is legacy-token (not OAuth-first production), that it is
  host-root-equivalent via `docker.sock`, and that the prebuilt `cap-web` console is
  localhost-only

### Requirement: Optional provision smoke

The script SHALL support an opt-in provision smoke that creates a throwaway task, confirms the
per-task sandbox provisions (the task reaches a running state), then stops it — mirroring scripts/upgrade.sh's provision smoke rather than reimplementing it. When the smoke cannot run (no
credential / repo available) it SHALL be skipped with a warning rather than failing the
bring-up.

#### Scenario: Smoke confirms sandbox provisioning when enabled

- **WHEN** the smoke is enabled and a repo/credential is available
- **THEN** the script creates a task, confirms it provisions a sandbox, and stops it

#### Scenario: Smoke skipped without prerequisites

- **WHEN** the smoke is enabled but no credential/repo is available
- **THEN** the smoke is skipped with a warning and the bring-up still succeeds
