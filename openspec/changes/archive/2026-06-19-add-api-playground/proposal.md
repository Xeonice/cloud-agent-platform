## Why

The platform now ships a stable, versioned public `/v1` REST surface (the applied `public-v1-api` change), but a logged-in operator has no in-console way to explore or test it — they'd have to drop to `curl` or the raw OpenAPI doc. This change adds an **in-console API Playground** (a Postman-style tester) at `/api`, faithfully to the OpenDesign "OpenSpec Agent System" `screens/api.html` revision: an operator picks a `/v1` endpoint, edits the request, sends it for REAL against the running api, and inspects the response. Authentication is the operator's existing CONSOLE SESSION (auto-injected, no token to paste) — the page is behind the `_app` auth gate, and the web's request transport already carries the session. This is the in-console companion to the external `/v1` API (and to the MCP server); the MCP-token/api-key surfaces are for OUT-of-console programmatic use, the playground for IN-console exploration. It targets the versioned `/v1` (per the operator's decision to build T0 first), so the catalog is the stable external contract, not console-internal paths.

## What Changes

- **New `/api` route** (`routes/_app/api.tsx`) under the authed `_app` shell, faithful to the `screens/api.html` design: a left **endpoint rail** (a searchable, grouped catalog) + a right **request/response** column.
- **Curated `/v1` endpoint catalog** matching the REAL applied surface: 任务 (`POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/tasks/:id/transcript`), 仓库 (`GET /v1/repos`, `GET /v1/repos/:id`), 文档 (`GET /v1/openapi.json`). The SSE `GET /v1/tasks/:id/events` is shown as a STREAMING entry (a live tail panel), distinct from the request/response endpoints.
- **A real, session-authed request runner**: a generic `sendApiRequest({ method, path, query, headers, body })` in the web api layer that fires the request through the existing authed transport (`credentials: "include"` + the operator bearer the web already attaches) and returns `{ status, statusText, durationMs, sizeBytes, headers, body }`. It is REAL-only (the playground tests the running api; in mock/backend-less mode it renders the static layout and a "send needs the api" state).
- **Request editor**: method + path (with `:id`/param fields filled in), a Body tab (JSON editor with a 格式化 action), a Params tab (query params), and a Headers tab (showing the auto-injected `Authorization` + `Content-Type`, read-only). A **发送** action fires the request.
- **Response viewer**: a status pill (e.g. `201 Created`) + timing/size meta, and Body / Headers tabs rendering the real response.
- **Session-signed, read-only auth display**: a "会话已签名 · OAuth 自动注入" affordance — the playground never asks for a token; it rides the operator's session. Destructive `/v1` writes (`POST /v1/tasks` create, `POST /v1/tasks/:id/stop`) run as the operator under the shared-pool model (documented).
- **Navigation**: an "API 调试" entry added to the app sidebar (`app-sidebar.tsx`) and the mobile nav.
- **Pixel baseline**: an `/api` baseline under the visual harness, comparing the deterministic (mock-mode) render of the page against the `screens/api.html` design.
- Out of scope: editing arbitrary/unknown URLs (the catalog is the curated `/v1` surface — not an open SSRF-style fetch box); saving request history/collections; the OpenAPI-driven dynamic catalog (the curated catalog ships first; driving it from `/v1/openapi.json` is a future option).

## Capabilities

### New Capabilities
- `api-playground`: the in-console API testing page — a curated `/v1` endpoint catalog, a real session-authed request runner, the request editor (method/path/params/headers/body) and the response viewer (status/timing/body/headers), with a streaming view for the SSE events endpoint.

### Modified Capabilities
- `frontend-console`: add the `/api` route to the route tree (an eleventh page under `_app`), add the "API 调试" entry to the app sidebar + mobile nav, and add the `/api` per-page pixel comparison against the design baseline.

## Impact

- **Code**: new `apps/web/src/routes/_app/api.tsx` + `apps/web/src/components/api/*` (endpoint rail, request panel, response panel, the endpoint catalog), a generic `sendApiRequest` in `apps/web/src/lib/api/real.ts` (+ the capability seam), `app-sidebar.tsx` + `mobile-nav.tsx` (the nav entry). No backend change — it consumes the existing `/v1` surface.
- **Auth**: the page is behind the `_app` gate (session-only); requests ride the operator's session (no new credential). It calls only the curated `/v1` paths, not arbitrary URLs.
- **Design baseline**: a new `/api` baseline under `apps/web/e2e/visual/` + its entry in the visual manifest.
- **No data / contracts change** (the catalog reflects the existing `/v1` contract; responses are rendered as-is).
