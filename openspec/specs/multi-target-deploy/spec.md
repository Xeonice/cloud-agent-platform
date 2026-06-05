# multi-target-deploy Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Web target is Vercel web-only
The `apps/web` target SHALL be deployable to Vercel with a `vercel.json`, and SHALL NOT host any WebSocket server, because Vercel serverless functions categorically cannot maintain WebSocket connections.

#### Scenario: Web ships a Vercel config and no WS server
- **WHEN** the deployment configuration for `apps/web` is inspected
- **THEN** a `vercel.json` exists for the web app
- **AND** the web app does not run or bundle a WebSocket server process

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
