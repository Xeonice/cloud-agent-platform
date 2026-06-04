## MODIFIED Requirements

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

### Requirement: Persistent volume for session.log survives restart
The api deployment SHALL mount a persistent volume backing `workspaces/<id>/session.log` so that the file survives an orchestrator process restart, configured as a Fly volume mount on Fly.io and as a named volume in docker-compose. Under the connect-in AIO model the orchestrator bridge (not an in-sandbox runner) writes `workspaces/<id>/session.log`, so the mounted volume SHALL back the path written by the orchestrator.

#### Scenario: Deploy configs declare a persistent volume
- **WHEN** the `fly.toml` and `docker-compose.yml` are inspected
- **THEN** each declares a persistent volume mounted at the `workspaces` path that holds `session.log`

#### Scenario: session.log survives an orchestrator restart
- **WHEN** the orchestrator process restarts while a task's `session.log` exists on the mounted volume
- **THEN** the previously written `session.log` content is still present after restart
