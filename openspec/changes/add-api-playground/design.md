## Context

An in-console API Playground at `/api` (epic Track B), built against the applied public `/v1` surface (`public-v1-api`). Faithful to the OpenDesign "OpenSpec Agent System" `screens/api.html` revision: a left endpoint rail + a right request/response column. It is a frontend-only change consuming the existing `/v1` endpoints; authentication is the operator's CONSOLE SESSION (the page is behind the `_app` gate and the web's authed transport already carries the session), so there is no token to paste — distinct from the MCP-token / api-key surfaces, which are for OUT-of-console programmatic use.

## Goals / Non-Goals

**Goals:**
- A logged-in operator can pick a `/v1` endpoint, edit the request, send it FOR REAL, and inspect the response — in-console, session-signed.
- Faithful to the `screens/api.html` design; a per-page pixel baseline.

**Non-Goals:**
- An arbitrary/free-form URL box (no SSRF-style open fetch — the catalog is the curated `/v1` surface). Saved collections/history. An OpenAPI-driven dynamic catalog (curated ships first). Any backend change.

## Decisions

### D1 — Session-authed, in-console, no token paste
The page is behind the `_app` auth gate; requests ride the operator's session via the existing authed transport (`credentials: "include"` + the bearer the web attaches). No token field.
- **Why**: it is the IN-console explorer for the operator who is already logged in; the api-key / MCP-token surfaces cover out-of-console programmatic auth. Matches the design's "会话已签名 · OAuth 自动注入".

### D2 — Curated `/v1` catalog, not a free-form URL box
The catalog is a fixed list of the REAL applied `/v1` endpoints (tasks lifecycle + transcript + repos read + openapi.json + the SSE events stream). No arbitrary URL field.
- **Why**: a free-form fetch box behind the operator's session would be an SSRF / arbitrary-request tool; constraining to the curated `/v1` paths keeps it a tester, not a proxy. Path params (`:id`) get dedicated inputs substituted into the path.
- **Alternative considered**: drive the catalog from `/v1/openapi.json` (auto-sync). Deferred — the curated catalog ships first; the openapi-driven catalog is a clean follow-up against the same page.

### D3 — A generic `sendApiRequest` runner in the web api layer (real-only)
Add `sendApiRequest({ method, path, query, headers?, body? })` to `lib/api/real.ts` that does a raw authed fetch (reusing the same `credentials: "include"` + bearer the existing `request()` helper uses) and returns `{ status, statusText, durationMs, sizeBytes, headers, body }` — measuring timing client-side and capturing the raw body (JSON-parsed when the content-type is JSON). It is REAL-only (no mock branch): the playground tests the running api; in mock/backend-less mode the catalog + editor render and a send surfaces a clear "needs the running api" state.
- **Why**: the existing `request()` helpers are endpoint-specific; the playground needs ONE generic runner. Real-only is honest — a playground that "sent" against a mock would be misleading.

### D4 — Request editor + response viewer (tabs)
Request: method + path (with param inputs), a Body tab (JSON editor + 格式化), a Params tab (query params like `limit`/`cursor`), a Headers tab (read-only auto-injected `Authorization` masked + `Content-Type`). Response: a status pill + timing/size meta + Body / Headers tabs (body pretty-printed when JSON). Pending + error states are explicit.

### D5 — The SSE events endpoint is a streaming view
`GET /v1/tasks/:id/events` opens a live tail (append each `text/event-stream` event) with a stop control — distinct from the single request/response endpoints.
- **Why**: SSE is a stream, not a single response; forcing it into the request/response model would misrepresent it. (The browser `EventSource` doesn't carry custom auth headers, but the session COOKIE rides cross-origin with `withCredentials`, so the events stream is reachable session-signed.)

### D6 — Per-page pixel baseline, deterministic in mock mode
Render the page deterministically under `VITE_FORCE_MOCK` (a fixed selected endpoint + a sample request body + an empty/placeholder response) and add an `/api` baseline (desktop + mobile) vs `screens/api.html`, with dynamic/timing regions masked.

## Risks / Trade-offs

- **A free-form URL box would be an SSRF/arbitrary-request tool** behind the operator session. → Mitigation: D2 curated catalog only; no arbitrary URL field.
- **Destructive writes (`POST /v1/tasks` create, stop) run as the operator** under the shared pool. → Mitigation: documented; consider a confirm affordance on destructive sends (open question).
- **Real-only send in mock/backend-less mode** → a "send" can't work. → Mitigation: the catalog + editor still render (for the pixel baseline + offline exploration); a send shows a clear needs-the-api state.
- **Pixel baseline alignment**: the app's empty-response render vs the design's filled-response sample. → Mitigation: a deterministic mock-mode render + masked dynamic regions + a recorded threshold (the landing-pixel pattern).
- **EventSource auth**: `EventSource` can't set an `Authorization` header. → Mitigation: rely on the session cookie (`withCredentials`) for the SSE stream; document that the events view needs the cookie-session (not a bearer).

## Migration Plan

1. Add `sendApiRequest` (+ the capability seam) → the catalog + rail/request/response components → the `/api` route composing them + the SSE streaming view → the sidebar + mobile-nav entry → the `/api` pixel baseline.
2. **Rollback**: additive frontend; removing the `/api` route + the nav entry + the baseline reverts it. No backend/data impact.

## Open Questions

- A confirm affordance before destructive sends (`POST /v1/tasks` create, stop)? Recommend a lightweight confirm on the write endpoints.
- Drive the catalog from `/v1/openapi.json` later (auto-sync) vs the curated list (ships now)? Recommend curated now, openapi-driven as a follow-up.
- The depth of the SSE streaming view (just a raw tail vs a parsed lifecycle timeline) — start with a raw tail.
