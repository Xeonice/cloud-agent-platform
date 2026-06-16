## MODIFIED Requirements

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
