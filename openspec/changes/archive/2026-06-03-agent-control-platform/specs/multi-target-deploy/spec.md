## ADDED Requirements

### Requirement: Web target is Vercel web-only
The `apps/web` target SHALL be deployable to Vercel with a `vercel.json`, and SHALL NOT host any WebSocket server, because Vercel serverless functions categorically cannot maintain WebSocket connections.

#### Scenario: Web ships a Vercel config and no WS server
- **WHEN** the deployment configuration for `apps/web` is inspected
- **THEN** a `vercel.json` exists for the web app
- **AND** the web app does not run or bundle a WebSocket server process

### Requirement: API target is Fly.io or docker-compose
The `apps/api` orchestrator SHALL be deployable as a stateful long-running process to Fly.io via a `fly.toml` and via `docker-compose` via a `docker-compose.yml`, both running the same NestJS WebSocket + PTY orchestrator.

#### Scenario: API ships both deploy configs
- **WHEN** the deployment configuration for `apps/api` is inspected
- **THEN** a `fly.toml` and a `docker-compose.yml` both exist that run the api orchestrator
- **AND** both target the same NestJS WebSocket + PTY orchestrator process

### Requirement: Web and API are independently deployable via env-configurable URLs
The web app SHALL reach the api exclusively through env-configurable `API_BASE_URL` and `WS_URL` values, which SHALL be allowed to point at a different origin than the web app, and the system SHALL NOT assume web and api share an origin.

#### Scenario: Web reads API location from environment
- **WHEN** the web app resolves where to send REST and WebSocket traffic
- **THEN** it reads `API_BASE_URL` and `WS_URL` from environment configuration rather than a hardcoded origin

#### Scenario: Cross-origin api is supported
- **WHEN** `API_BASE_URL` and `WS_URL` point to a host different from the web app's own origin
- **THEN** the web app functions correctly against that cross-origin api without requiring same-origin

### Requirement: Persistent volume for session.log survives restart
The api deployment SHALL mount a persistent volume backing `workspaces/<id>/session.log` so that the file survives an orchestrator process restart, configured as a Fly volume mount on Fly.io and as a named volume in docker-compose.

#### Scenario: Deploy configs declare a persistent volume
- **WHEN** the `fly.toml` and `docker-compose.yml` are inspected
- **THEN** each declares a persistent volume mounted at the `workspaces` path that holds `session.log`

#### Scenario: session.log survives an orchestrator restart
- **WHEN** the orchestrator process restarts while a task's `session.log` exists on the mounted volume
- **THEN** the previously written `session.log` content is still present after restart
