# multi-target-deploy Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Web target is Vercel web-only
The `apps/web` target SHALL be deployable EITHER to Vercel (via a `vercel.json` / the Nitro `vercel` preset) OR as a self-contained Node server inside the docker-compose stack (via the Nitro `node-server` preset, which emits `.output/server/index.mjs` run as a long-running Node process by a `web` compose service). The deployment target SHALL be selectable at build time (e.g. a `NITRO_PRESET` build arg) so BOTH targets remain first-class — the Vercel path is preserved and a compose-hosted web service is added. In NEITHER target SHALL the web app host or bundle a WebSocket server of its own, because the realtime stream is served by the api orchestrator (the web app proxies/points to the api's WS via env-configured URLs); Vercel serverless functions categorically cannot maintain WebSocket connections, and the compose web service likewise does not run a WS server.

#### Scenario: Web ships a Vercel config and no WS server
- **WHEN** the deployment configuration for `apps/web` is inspected for the Vercel target
- **THEN** a `vercel.json` (or Nitro `vercel` preset) exists for the web app
- **AND** the web app does not run or bundle a WebSocket server process

#### Scenario: Web also ships as a self-contained Node server in compose
- **WHEN** the docker-compose stack is inspected
- **THEN** a `web` service (behind the `web` compose profile) builds the `apps/web` Nitro `node-server` output and runs `.output/server/index.mjs` as a long-running process, joined to the stack network and reaching the api by its env-configured URLs
- **AND** that web service runs no WebSocket server of its own

#### Scenario: Deployment target is selectable at build time
- **WHEN** the web app is built for a given target
- **THEN** the Nitro preset (Vercel vs node-server) is selected at build time (e.g. via `NITRO_PRESET`) without a source edit, so both the Vercel deploy and the compose-hosted deploy remain available

### Requirement: API target is Fly.io or docker-compose
The `apps/api` orchestrator SHALL be deployable as a stateful long-running process to Fly.io via a `fly.toml` and via `docker-compose` via a `docker-compose.yml`, both running the same NestJS WebSocket + PTY orchestrator. The docker-compose self-host topology SHALL build cleanly: the derived runner Dockerfile SHALL NOT run a filtered `pnpm --filter X prune --prod` (which fails on pnpm 10 with "Unknown option: recursive"). The compose `api` service SHALL join BOTH the default network AND `cap-net` so it can reach Postgres (joining `cap-net` only drops it off the default network and breaks Postgres reachability, P1001), while Postgres stays default-only and sandboxes stay `cap-net`-only. The compose `api` service SHALL run as `user: root` so it can read the root-owned `/var/run/docker.sock` and provision sandboxes via DooD (a non-root user gets EACCES), consistent with the host-root-equivalent threat model. The compose `api` service SHALL pass `MAX_CONCURRENT_TASKS` and `TASK_REPO_URL` through to the orchestrator, which reads them.

#### Scenario: API ships both deploy configs
- **WHEN** the deployment configuration for `apps/api` is inspected
- **THEN** a `fly.toml` and a `docker-compose.yml` both exist that run the api orchestrator
- **AND** both target the same NestJS WebSocket + PTY orchestrator process

#### Scenario: Compose self-host image builds without a filtered prune
- **WHEN** the docker-compose self-host image is built
- **THEN** the derived runner Dockerfile does NOT invoke `pnpm --filter X prune --prod`
- **AND** the image build completes successfully on pnpm 10

#### Scenario: API reaches Postgres and provisions sandboxes
- **WHEN** the compose `api` service starts
- **THEN** it is attached to BOTH the default network and `cap-net`, so it reaches Postgres (no P1001) while Postgres stays default-only and sandboxes stay `cap-net`-only
- **AND** it runs as `user: root`, so `/var/run/docker.sock` is readable and it can provision sandboxes via DooD without EACCES

#### Scenario: Concurrency and repo-URL env are passed through to the api
- **WHEN** the compose `api` service environment is inspected
- **THEN** `MAX_CONCURRENT_TASKS` and `TASK_REPO_URL` are passed through to the orchestrator process

### Requirement: Web and API are independently deployable via env-configurable URLs
The web app SHALL reach the api exclusively through env-configurable `API_BASE_URL` and `WS_URL` values, which SHALL be allowed to point at a different origin than the web app, and the system SHALL NOT assume web and api share an origin.

#### Scenario: Web reads API location from environment
- **WHEN** the web app resolves where to send REST and WebSocket traffic
- **THEN** it reads `API_BASE_URL` and `WS_URL` from environment configuration rather than a hardcoded origin

#### Scenario: Cross-origin api is supported
- **WHEN** `API_BASE_URL` and `WS_URL` point to a host different from the web app's own origin
- **THEN** the web app functions correctly against that cross-origin api without requiring same-origin

### Requirement: Persistent volume for session.log survives restart
The api deployment SHALL mount a persistent volume backing `workspaces/<id>/session.log` so that the file survives an orchestrator process restart, configured as a Fly volume mount on Fly.io and as a named volume in docker-compose. Under the connect-in AIO model the orchestrator bridge (not an in-sandbox runner) writes `workspaces/<id>/session.log`, so the mounted volume SHALL back the path written by the orchestrator.

#### Scenario: Deploy configs declare a persistent volume
- **WHEN** the `fly.toml` and `docker-compose.yml` are inspected
- **THEN** each declares a persistent volume mounted at the `workspaces` path that holds `session.log`

#### Scenario: session.log survives an orchestrator restart
- **WHEN** the orchestrator process restarts while a task's `session.log` exists on the mounted volume
- **THEN** the previously written `session.log` content is still present after restart

### Requirement: DooD docker-compose execution topology with docker.sock and cap-net
The docker-compose self-host topology SHALL mount the host docker socket `/var/run/docker.sock` into the `api` service so the orchestrator can provision sibling sandbox containers via Docker-out-of-Docker, and SHALL define a user-defined network `cap-net` (the default bridge has no container-name DNS) joined by the `api` service. Each per-task AIO sandbox SHALL be attached to `cap-net`, SHALL be reachable by container name, and SHALL publish NO host port — making NETWORK ISOLATION the execution security boundary. It SHALL be documented that mounting `/var/run/docker.sock` into `api` is host-root-equivalent and is accepted only for single-user self-host.

#### Scenario: docker.sock is mounted into the api service
- **WHEN** the `docker-compose.yml` is inspected
- **THEN** the `api` service mounts `/var/run/docker.sock` so it can provision sibling sandbox containers via DooD

#### Scenario: cap-net is defined and joined for container-name addressing
- **WHEN** the `docker-compose.yml` is inspected
- **THEN** a user-defined network `cap-net` is defined and the `api` service joins it
- **AND** per-task AIO sandboxes attach to `cap-net` and are dialed by container name rather than by host port

#### Scenario: Sandboxes publish no host port
- **WHEN** a per-task AIO sandbox container is provisioned under the compose topology
- **THEN** it publishes no host port and is reachable only on `cap-net` by the orchestrator
- **AND** network isolation is the execution security boundary

#### Scenario: Host-root-equivalent risk is documented
- **WHEN** the compose self-host topology documentation is inspected
- **THEN** it states that mounting `/var/run/docker.sock` into `api` grants host-root-equivalent access and is accepted only for single-user self-host

### Requirement: One-command local dev bring-up bootstraps a usable env

The docker-compose self-host target SHALL provide a single-command local bring-up (e.g. `make up` / `scripts/dev-up.sh`) that makes a freshly-cloned repo start and be usable without hand-authoring secrets or configuring a GitHub OAuth app. The command SHALL, when `apps/api/.env` is absent, generate it from `apps/api/.env.example` with strong random values for `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, and `AUTH_TOKEN`, and SHALL enable the legacy operator-token auth path (`AUTH_TOKEN_LEGACY_ENABLED=true`) plus set `WEB_ORIGIN` for local dev, so a local operator can authenticate with the generated token alone (OAuth stays optional).

The command SHALL select the default sandbox backend by host OS unless explicitly overridden: macOS defaults to a BoxLite-backed sandbox path, Linux defaults to the existing AIO-backed sandbox path, and control-plane-only remains an explicit mode rather than the macOS default. The selected provider mode SHALL be surfaced in script output and encoded in generated local configuration without overwriting existing operator-supplied env values. The command SHALL wait until the api `/health` endpoint reports ready before reporting success, printing how to authenticate (the generated token) for local use.

The bring-up SHALL be idempotent and non-destructive to existing state: it SHALL NOT overwrite an existing `apps/api/.env` (a real local env is reused as-is), the generated env SHALL remain gitignored (never committed, secrets never written to a tracked file), and re-running the command SHALL NOT recreate or wipe the Postgres `pgdata` / `workspaces` volumes. A matching teardown command SHALL stop the stack, and dropping the persistent volumes SHALL require an explicit opt-in flag rather than being the default. The committed example env and the production deploy path SHALL remain OAuth-first / fail-closed — the generated legacy-token env is for local dev only and is not committed.

#### Scenario: Fresh macOS clone starts with BoxLite by default

- **WHEN** a contributor on macOS with no `apps/api/.env` runs the one-command local bring-up
- **THEN** the command generates `apps/api/.env` from the example with random secrets and the legacy operator-token path enabled
- **AND** it configures and verifies the BoxLite sandbox provider as the default eligible provider before reporting success

#### Scenario: Fresh Linux clone starts with AIO by default

- **WHEN** a contributor on Linux with no `apps/api/.env` runs the one-command local bring-up
- **THEN** the command generates `apps/api/.env` from the example with random secrets and the legacy operator-token path enabled
- **AND** it runs the existing AIO full-stack bring-up, including the AIO sandbox image build/staging path

#### Scenario: Existing local env is never overwritten

- **WHEN** the one-command bring-up runs and `apps/api/.env` already exists
- **THEN** it reuses the existing env unchanged and does not regenerate or overwrite it
- **AND** if the existing env pins a provider, the script reports that the existing provider config is being honored

#### Scenario: Re-running is idempotent and preserves data

- **WHEN** the one-command bring-up is run again on an already-initialized checkout
- **THEN** it does not overwrite `apps/api/.env` and does not recreate or wipe the `pgdata`/`workspaces` volumes, so existing local data survives

#### Scenario: Generated secrets are never committed

- **WHEN** the bring-up generates `apps/api/.env`
- **THEN** the generated file is gitignored and no secret value is written into any tracked/committed file

#### Scenario: Teardown requires an explicit flag to drop volumes

- **WHEN** the teardown command is run without the volume-drop opt-in flag
- **THEN** it stops the stack while preserving the `pgdata`/`workspaces` volumes

### Requirement: Local startup exposes api and web on all host interfaces by default

The docker-compose self-host startup path SHALL make api and web host binding explicit and default those user-facing services to `0.0.0.0`. Operators SHALL be able to override the bind address to loopback or another interface through env without editing compose files. Health probes MAY use loopback locally, but output and docs SHALL distinguish local probe URLs from the actual host bind behavior. Security-sensitive observability services that are intentionally loopback-only SHALL remain loopback-only unless their own specification is changed.

#### Scenario: Compose renders all-interface api binding by default

- **WHEN** the local compose config is rendered without host-bind overrides
- **THEN** the api host port is bound on `0.0.0.0`

#### Scenario: Compose renders all-interface web binding by default

- **WHEN** the optional web profile is enabled without host-bind overrides
- **THEN** the web host port is bound on `0.0.0.0`

#### Scenario: Operator can force loopback binding

- **WHEN** the operator sets the documented api or web host-bind env to `127.0.0.1`
- **THEN** compose renders that service as loopback-bound without code changes

#### Scenario: Public networking remains operator-owned

- **WHEN** local startup prints its completion summary
- **THEN** it states that DNS, TLS, reverse proxy, OAuth callback URL, cookie scope, and firewall/public exposure are not configured by the startup script

