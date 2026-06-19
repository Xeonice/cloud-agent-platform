<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a track run serially. -->
<!--
  Partition corrected against the codebase (2026-06-19). Parallel tracks touch
  DISJOINT files; no file is written by >1 parallel track, so there is NO
  integration track.
  Track file maps:
    1 request-runner   → apps/web/src/lib/api/real.ts; apps/web/src/lib/api/capabilities.ts; apps/web/src/lib/api/queries.ts (or a thin real-only hook)
    2 catalog-and-panels → apps/web/src/components/api/catalog.ts; api-rail.tsx; api-request-panel.tsx; api-response-panel.tsx (all NEW)
    3 page-and-stream   → apps/web/src/routes/_app/api.tsx (NEW); apps/web/src/components/api/api-stream-panel.tsx (NEW SSE view); apps/web/src/components/api/api.test.tsx (NEW). routeTree.gen.ts is gitignored + auto-regenerated (not a source file).
    4 navigation        → apps/web/src/components/shell/app-sidebar.tsx (4.1: extends the NavKey union + activeNavKey helper); apps/web/src/components/shell/mobile-nav.tsx (4.2: consumes 4.1's extended NavKey — intra-track serial coupling)
    5 pixel-baseline    → apps/web/e2e/visual/manifest.ts (the /api row already exists; tune maxDiffPixelRatio); apps/web/e2e/visual/pixel.spec.ts iterates PAGES generically; design baseline screens/api.html already present
-->

## 1. Track: request-runner (depends: none) — files: apps/web/src/lib/api/real.ts, apps/web/src/lib/api/capabilities.ts, apps/web/src/lib/api/queries.ts

- [x] 1.1 Add a generic `sendApiRequest({ method, path, query?, headers?, body? })` to `apps/web/src/lib/api/real.ts` that does a raw authed fetch reusing the SAME base URL + `credentials: "include"` + operator-bearer attachment the existing `request()` helper uses, builds the query string, JSON-encodes the body for writes, measures elapsed time client-side, and returns `{ status, statusText, ok, durationMs, sizeBytes, headers: Record<string,string>, body: string, json?: unknown }` (parsing `json` only when the response content-type is JSON). A network failure resolves to a structured error result (NOT a throw the page can't render).
- [x] 1.2 Expose it through the capability seam (`capabilities.ts` + the queries/mutations or a thin hook): the runner is REAL-only (no mock branch) — in mock/backend-less mode a send returns a clear "needs the running api" result rather than fabricating a response.

## 2. Track: catalog-and-panels (depends: none) — files: apps/web/src/components/api/catalog.ts, apps/web/src/components/api/api-rail.tsx, apps/web/src/components/api/api-request-panel.tsx, apps/web/src/components/api/api-response-panel.tsx (all NEW)

- [x] 2.1 Add the curated `/v1` endpoint catalog (`apps/web/src/components/api/catalog.ts`): a typed list grouped by domain — 任务 (`POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/tasks/:id/transcript`), 仓库 (`GET /v1/repos`, `GET /v1/repos/:id`), 文档 (`GET /v1/openapi.json`), and the SSE `GET /v1/tasks/:id/events` flagged `streaming: true`. Each entry declares its method, path template, path params, default query params, a sample body (for writes), and whether it is destructive.
- [x] 2.2 Add the endpoint **rail** component (`api-rail.tsx`): a searchable, domain-grouped list; selecting an endpoint raises a callback. Faithful to `screens/api.html`.
- [x] 2.3 Add the **request panel** (`api-request-panel.tsx`): method + resolved path (with `:id`/param inputs), Body tab (JSON editor + 格式化), Params tab (query params), Headers tab (read-only auto-injected `Authorization` masked + `Content-Type`), and a 发送 action; a lightweight confirm before a destructive send (`POST /v1/tasks`, stop).
- [x] 2.4 Add the **response panel** (`api-response-panel.tsx`): a status pill + elapsed-time/size meta + Body / Headers tabs (body pretty-printed when JSON); explicit empty / pending / error states.

## 3. Track: page-and-stream (depends: request-runner, catalog-and-panels) — files: apps/web/src/routes/_app/api.tsx (NEW), apps/web/src/components/api/api-stream-panel.tsx (NEW), apps/web/src/components/api/api.test.tsx (NEW)

- [x] 3.1 Add the `/api` route (`apps/web/src/routes/_app/api.tsx`) composing the rail + request + response panels inside the `_app` shell `<Outlet/>` (NOT rebuilding the shell), wiring selection → request editor → `sendApiRequest` → response panel. Default-select a deterministic first endpoint with a sample body + empty response (for a stable mock-mode render).
- [x] 3.2 Add the SSE streaming view for the `streaming` catalog entry (`GET /v1/tasks/:id/events`): on send, open a live tail (append each `text/event-stream` event) with a stop control, via `EventSource` with `withCredentials` (the session cookie carries auth — document that the events view relies on the cookie-session). Visually distinct from the request/response panels.
- [x] 3.3 Tests: selecting an endpoint populates the request editor; a path param substitutes into the path; a (mocked) `sendApiRequest` result renders status/timing/body; a failed send renders an error, not a crash; there is NO free-form URL field (only catalog paths reachable).

## 4. Track: navigation (depends: none) — files: apps/web/src/components/shell/app-sidebar.tsx, apps/web/src/components/shell/mobile-nav.tsx

- [x] 4.1 Add an "API 调试" entry to the app sidebar (`apps/web/src/components/shell/app-sidebar.tsx`) routing to `/api`, in the established nav style/position; mark active on `/api`.
- [x] 4.2 Add the same "API 调试" entry to the mobile nav (`apps/web/src/components/shell/mobile-nav.tsx`).

## 5. Track: pixel-baseline (depends: page-and-stream, navigation) — files: apps/web/e2e/visual/manifest.ts, apps/web/e2e/visual/pixel.spec.ts

- [x] 5.1 Add the `/api` design baseline (from `screens/api.html`) under the visual harness + register it in the visual manifest (desktop + the ≤820px mobile breakpoint), masking dynamic/timing regions.
- [x] 5.2 DONE — clean full-sweep run is GREEN: all 20 baselines captured + `api @ desktop` and `api @ mobile` both pass at the recorded 0.06 threshold (22 passed). `VV_MEASURE` recorded `api @ desktop` = ratio 0.03 (the documented empty-vs-filled response-card delta), well under 0.06. The earlier "flakiness" was self-inflicted (killing the Playwright-owned design server mid-run / leftover processes from back-to-back runs racing the ports) — NOT a harness defect; a thorough teardown (kill all playwright/vite/chromium + confirm ports free + wait) before a single run is clean. Manifest comment updated to record the measured ratio.
