## ADDED Requirements

### Requirement: Release web image supports same-host runtime endpoint discovery
The release `cap-web` image SHALL be reusable for same-host self-host installs
without baking a host-specific API URL into the client bundle. The compose web
service SHALL expose public runtime endpoint variables and SHALL leave
build-time `VITE_*` endpoint overrides blank by default. `quick-deploy.sh` SHALL
write the API host port into runtime config so opening the console through
`localhost`, a LAN IP, or a Tailscale IP derives API/WS endpoints from the host
the operator actually opened.

#### Scenario: quick-deploy configures same-host runtime discovery

- **WHEN** quick-deploy prepares the release-image `.env`
- **THEN** it writes `CAP_PUBLIC_API_PORT` from the effective API host port
- **AND** it writes `CAP_SERVER_API_BASE_URL=http://api:8080` for SSR/internal
  web requests

#### Scenario: Compose web exposes public routing config

- **WHEN** the `web` compose profile starts the release web image
- **THEN** the service passes `CAP_PUBLIC_API_BASE_URL`, `CAP_PUBLIC_WS_URL`,
  `CAP_PUBLIC_API_HOST`, `CAP_PUBLIC_API_PORT`, and
  `CAP_PUBLIC_API_PROTOCOL` into the web runtime
- **AND** no secret is required in those public values

#### Scenario: Split-domain deploys remain explicit

- **WHEN** an operator deploys web and API on distinct public domains
- **THEN** they can configure explicit public API/WS endpoints instead of using
  same-host discovery
- **AND** the browser uses the explicit endpoints

### Requirement: Same-host credentialed CORS and session cookies match the opened origin
The API SHALL support an opt-in same-host web-origin mode for release-image
installs. When `WEB_ORIGIN_AUTO_SAME_HOST=true`, the API SHALL credentialed-CORS
allow a browser origin only when the origin hostname equals the API request host
hostname and the origin port equals the configured web port. Login session-cookie
construction SHALL use the same effective same-host decision so HTTP same-host
installs keep a host-only `SameSite=Lax` cookie, while cross-host deploys keep
`SameSite=None; Secure`.

#### Scenario: API allows the actual same-host browser origin

- **WHEN** the browser sends `Origin: http://100.101.167.99:3000`
- **AND** the API request host is `100.101.167.99:18080`
- **AND** `WEB_ORIGIN_AUTO_SAME_HOST=true` with web port `3000`
- **THEN** the API responds with credentialed CORS for
  `http://100.101.167.99:3000`

#### Scenario: API rejects a different same-host web port

- **WHEN** the browser sends `Origin: http://100.101.167.99:5173`
- **AND** the configured same-host web port is `3000`
- **THEN** the auto same-host rule does not allow that origin

#### Scenario: LAN same-host login keeps an HTTP-compatible cookie

- **WHEN** login is requested from `Origin: http://100.101.167.99:3000`
- **AND** the API host is `100.101.167.99:18080`
- **AND** the origin is accepted by the auto same-host rule
- **THEN** the session cookie is host-only, `SameSite=Lax`, and not forced to
  `Secure`

#### Scenario: Cross-host login keeps cross-site cookie mode

- **WHEN** the configured web origin hostname differs from the API request host
- **THEN** the session cookie uses `SameSite=None; Secure`

## MODIFIED Requirements

### Requirement: A self-host setup guide documents the human configuration steps
The project SHALL provide an operator-facing self-host setup guide, discoverable
from the README, that documents the steps a self-hoster must perform by hand:
creating identity/login configuration, setting allowed operators, configuring
public domains and session cookie scope, generating required secrets, and
bringing up the compose stack. The guide SHALL make explicit the values most
likely to be misconfigured: browser-facing API/WS endpoint config, `WEB_ORIGIN`,
same-host auto-origin controls, and `SESSION_COOKIE_DOMAIN`.

#### Scenario: Guide covers same-host release-image endpoint discovery

- **WHEN** a self-hoster follows the same-host release-image path
- **THEN** the guide explains that the browser derives the API/WS host from the
  current opened hostname and `CAP_PUBLIC_API_PORT`
- **AND** it documents the matching `WEB_ORIGIN_AUTO_SAME_HOST` CORS controls

#### Scenario: Guide covers explicit split-domain endpoints

- **WHEN** a self-hoster chooses split-domain web/API deployment
- **THEN** the guide instructs them to configure explicit browser-facing API/WS
  endpoints and matching `WEB_ORIGIN`/cookie scope values
