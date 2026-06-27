## Context

The web app has two deployment modes:

- web-only or split-domain deployments, where operators intentionally point the
  browser at a distinct API origin;
- release-image self-host deployments, where the same prebuilt web image should
  work when opened through `localhost`, a LAN IP, a Tailscale IP, or a hostname
  chosen after the image was built.

The first mode needs explicit, stable endpoint configuration. The second mode
cannot bake a host into the client bundle, so endpoint discovery must happen at
runtime from the browser URL.

## Goals / Non-Goals

**Goals:**

- Keep explicit API/WS endpoint configuration for Vercel and split-domain
  deployments.
- Make the release web image derive browser-facing API/WS endpoints from the
  host the operator actually opened.
- Keep SSR/server-side web fetches using an internal compose URL.
- Keep credentialed CORS, REST/SSE fetches, terminal WebSocket auth, and
  session-cookie attributes aligned for the same-host topology.
- Document the supported topology choices and env variables.

**Non-Goals:**

- Do not make arbitrary browser-provided hosts trusted endpoints when explicit
  public endpoints are configured.
- Do not remove the Vercel/web-only deployment path.
- Do not change the terminal WebSocket frame protocol or task execution
  topology.

## Decisions

### D1 - Endpoint resolution has one ordered source of truth

`apps/web/src/lib/config.ts` remains the single resolver. The browser resolution
order is:

1. build-time `VITE_API_BASE_URL` / `VITE_WS_URL`;
2. runtime public `CAP_PUBLIC_API_BASE_URL` / `CAP_PUBLIC_WS_URL`;
3. runtime public host/protocol/port overrides;
4. fallback to `window.location.hostname` plus `CAP_PUBLIC_API_PORT` or the
   default API port.

Server-side rendering uses `CAP_SERVER_API_BASE_URL` so the web container can
reach the API through the compose service name rather than a host-published
port.

### D2 - Runtime public config is injected before hydration

The Node-server web image emits an inline `window.__CAP_RUNTIME_CONFIG__` script
from runtime environment variables before React hydration. This keeps public
routing values configurable without rebuilding the release image and avoids
placing secrets into the client bundle.

### D3 - API same-host CORS is opt-in and host-matched

The API continues to allow explicit `WEB_ORIGIN` entries. A release-image
same-host install can additionally set `WEB_ORIGIN_AUTO_SAME_HOST=true` plus a
web port. When enabled, the API allows an origin only when the request `Origin`
hostname equals the API request `Host` hostname and the origin port equals the
configured web port.

### D4 - Cookie mode follows the same effective web origin

Login cookies must not be forced into `SameSite=None; Secure` for plain HTTP
same-host installs such as `http://100.101.167.99:3000` -> API
`http://100.101.167.99:8080`. Cookie construction therefore prefers the actual
request `Origin` when it is either explicitly allowlisted or accepted by the
auto same-host rule, then falls back to the configured primary `WEB_ORIGIN`.

### D5 - quick-deploy writes the minimal same-host contract

`scripts/quick-deploy.sh` writes `CAP_PUBLIC_API_PORT`,
`CAP_SERVER_API_BASE_URL`, `WEB_ORIGIN`, `WEB_ORIGIN_AUTO_SAME_HOST`, and
`WEB_ORIGIN_AUTO_SAME_HOST_PORT`. The explicit localhost origin keeps localhost
trial access working; the auto same-host rule covers LAN/Tailscale access
without hardcoding the discovered host.

## Risks / Trade-offs

- Runtime discovery only works when web and API are reachable through the same
  hostname and a known API port. Split-domain deployments must still set
  explicit endpoint URLs.
- `window.location.hostname` intentionally excludes the web port; the API port
  remains controlled by runtime config.
- CORS and cookie handling must remain aligned. Tests cover the LAN same-host
  case so future changes do not regress login persistence.

## Migration Plan

Ship the updated release web image, compose files, quick-deploy script, and
docs. Existing split-domain operators keep using explicit `VITE_*` or
`CAP_PUBLIC_*` endpoint values. Same-host operators can remove hardcoded API
base URLs and rely on the runtime port-based fallback.

Rollback is restoring explicit endpoint variables for the deployment. No
database migration is involved.

## Open Questions

- None.
