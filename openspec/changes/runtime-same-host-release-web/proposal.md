## Why

The release `cap-web` image must be reusable across localhost, LAN, Tailscale,
and custom same-host installs. A build-time `localhost` API URL makes the image
work only on the maintainer's or operator's local browser and breaks as soon as
the console is opened through another hostname.

The web console therefore needs to derive API and WebSocket endpoints from the
browser location at runtime unless an operator explicitly configures public
endpoints. The API must mirror that runtime same-host model in its credentialed
CORS and session-cookie handling, otherwise login can appear to succeed while
the browser drops or withholds the session cookie.

## What Changes

- Resolve web API/WS endpoints through a single config module with this order:
  build-time `VITE_*`, runtime `CAP_PUBLIC_*`, browser same-host fallback from
  `window.location.hostname`, then server-side internal fallback for SSR.
- Inject runtime public endpoint config before hydration in the compose
  Node-server web image.
- Keep REST, SSE, and terminal WebSocket clients using the same endpoint
  resolver.
- Let the API opt into same-host web-origin CORS by comparing the request
  `Origin` with the API request `Host` and a configured web port.
- Build login session cookies with the same effective same-host decision so
  HTTP same-host installs keep `SameSite=Lax` instead of being forced to
  `SameSite=None; Secure`.
- Wire quick-deploy and compose examples to write the public API port and
  same-host CORS controls.
- Update self-hosting docs and env examples for same-host and split-domain
  topologies.

## Capabilities

### Modified Capabilities

- `frontend-console`: endpoint resolution now supports runtime public config
  and browser same-host discovery in addition to explicit Vite build-time
  endpoints.
- `self-hostable-deployment`: release-image compose/quick-deploy installs can
  serve the prebuilt web image on the current host while preserving explicit
  split-domain configuration.

## Impact

- `apps/web/src/lib/config.ts`
- `apps/web/src/routes/__root.tsx`
- `apps/web/Dockerfile`
- `apps/web/.env.example`
- `apps/api/src/auth/auth-config.ts`
- `apps/api/src/auth/session-cookie.ts`
- `apps/api/src/main.ts`
- `docker-compose.prod.yml`
- `docker-compose.prod.env.example`
- `.env.example`
- `apps/api/.env.example`
- `scripts/quick-deploy.sh`
- `docs/self-hosting.md`
- Endpoint/CORS/session-cookie tests
