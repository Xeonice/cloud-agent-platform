## 1. Track: web-runtime-endpoints (depends: none)

- [x] 1.1 Centralize browser and server API/WS endpoint resolution in `apps/web/src/lib/config.ts`.
- [x] 1.2 Support build-time `VITE_*` overrides, runtime `CAP_PUBLIC_*` public config, and same-host fallback from `window.location.hostname`.
- [x] 1.3 Inject runtime public endpoint config before hydration from the TanStack Start root document.
- [x] 1.4 Keep REST, SSE, and terminal WebSocket clients using the centralized endpoint resolver.
- [x] 1.5 Add focused web config tests for explicit endpoints, same-host fallback, HTTPS/WSS, runtime config injection, and SSR fallback.

## 2. Track: api-origin-cookie-alignment (depends: web-runtime-endpoints)

- [x] 2.1 Add opt-in same-host web-origin matching for credentialed API CORS.
- [x] 2.2 Keep `/mcp` bearer-only CORS isolated from console credentialed CORS.
- [x] 2.3 Align login session-cookie `SameSite`/`Secure` selection with the effective explicit or auto same-host web origin.
- [x] 2.4 Add API tests for same-host origin matching and session-cookie behavior.

## 3. Track: release-image-wiring-and-docs (depends: api-origin-cookie-alignment)

- [x] 3.1 Wire the compose `web` service with runtime public endpoint variables and internal SSR API base.
- [x] 3.2 Update quick-deploy to persist same-host endpoint/CORS/cookie config.
- [x] 3.3 Update `.env.example`, app env examples, compose env examples, Dockerfile comments, and self-hosting docs for same-host and split-domain topologies.

## 4. Track: verification (depends: release-image-wiring-and-docs)

- [x] 4.1 Run OpenSpec validation for `runtime-same-host-release-web`.
- [x] 4.2 Run targeted web config tests.
- [x] 4.3 Run targeted API auth config/session-cookie tests.
- [x] 4.4 Run `git diff --check`.
- [x] 4.5 Scan staged changes for `debugger` before commit.
