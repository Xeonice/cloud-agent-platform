## MODIFIED Requirements

### Requirement: Configurable cross-origin API and WebSocket endpoints
`apps/web` SHALL resolve the API base URL and WebSocket URL from a single
configuration module used by REST, SSE, and terminal WebSocket clients. Explicit
build-time Vite configuration (`VITE_API_BASE_URL` / `VITE_WS_URL`) SHALL take
precedence for web-only and split-domain deploys. When those values are absent,
the compose Node-server web image SHALL inject public runtime configuration
(`CAP_PUBLIC_API_BASE_URL`, `CAP_PUBLIC_WS_URL`, `CAP_PUBLIC_API_HOST`,
`CAP_PUBLIC_API_PORT`, `CAP_PUBLIC_API_PROTOCOL`) before hydration. When no
explicit public endpoint is configured in the browser, the console SHALL derive
the API/WS host from the current `window.location.hostname`, preserving the
browser protocol and using the configured API port (default `8080`). Server-side
web rendering SHALL use `CAP_SERVER_API_BASE_URL` for internal API calls so the
web container can dial the compose service name.

#### Scenario: Explicit Vite endpoints win

- **WHEN** `VITE_API_BASE_URL` and `VITE_WS_URL` are set at build time
- **THEN** the browser sends REST/SSE calls and terminal WebSocket connections to
  those configured endpoints
- **AND** runtime public config and browser same-host fallback do not override
  them

#### Scenario: Runtime public endpoints win over same-host fallback

- **WHEN** the Node-server web image injects `CAP_PUBLIC_API_BASE_URL` and/or
  `CAP_PUBLIC_WS_URL`
- **THEN** the browser uses those public endpoints without rebuilding the web
  image
- **AND** those values are treated as public routing data only, never secrets

#### Scenario: Browser derives same-host API endpoints from the opened host

- **WHEN** the operator opens the release web image at
  `http://100.101.167.99:3000` with no explicit public API base URL
- **AND** runtime config sets `CAP_PUBLIC_API_PORT=18080`
- **THEN** REST/SSE requests target `http://100.101.167.99:18080`
- **AND** terminal WebSocket connections target `ws://100.101.167.99:18080`

#### Scenario: HTTPS browser origin derives WSS terminal endpoint

- **WHEN** the operator opens the console over `https://cap.example.com`
- **AND** no explicit WebSocket URL is configured
- **THEN** the derived terminal endpoint uses `wss://` with the configured API
  host/port

#### Scenario: SSR uses the internal API base

- **WHEN** the web route renders on the Node server
- **THEN** server-side API calls use `CAP_SERVER_API_BASE_URL` or the documented
  localhost fallback
- **AND** they do not use the browser-facing host-published API port
