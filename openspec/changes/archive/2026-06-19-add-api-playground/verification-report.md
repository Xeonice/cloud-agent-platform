# Verification report — add-api-playground

Adversarial spec verification with three-way routing. Each requirement from
both spec files was re-traced end-to-end against the actual implementation
(NOT rubber-stamped from the skeptic). The raw-unmet list handed to this pass
was empty `[]`; every requirement below re-traces as **MET**, so no
verify-reopened code tasks and no new spec-defects were produced this pass.

## Three-way routing tally

- **Reopened (UNMET → code task):** 0
- **Spec-defect (→ design.md Open Questions):** 0
- **Reclassified MET (folded here):** 7 (all requirements)

## MET requirements (re-traced end-to-end)

### api-playground/spec.md

1. **The API Playground page renders a catalog + request/response columns** —
   MET. `routes/_app/api.tsx` composes the rail (`ApiRail`) left + a stacked
   request (`ApiRequestPanel`) / response (`ApiResponsePanel`) column right
   inside the `_app` `<Outlet/>` (it does NOT rebuild the shell). Selecting a
   rail row raises `onSelect` → `handleSelect` re-selects the endpoint and the
   request panel re-seeds its editor (the `useEffect` keyed on the endpoint).
   Covered by `catalog-and-columns.test.ts` + `api.test.ts`.

2. **The catalog is the curated, real /v1 surface** — MET.
   `components/api/catalog.ts` enumerates EXACTLY the spec's `/v1` paths
   (`POST/GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`,
   `GET /v1/tasks/:id/transcript`, `GET /v1/repos`, `GET /v1/repos/:id`,
   `GET /v1/openapi.json`) plus the SSE `GET /v1/tasks/:id/events` flagged
   `streaming: true`. There is NO free-form URL field — confirmed: every
   `<input>` in the `api/` components is a constrained control (rail search,
   `:id` path-param input, query-param input), never a URL box. `resolvePath`
   URL-encodes the `:id` so it can never inject extra path/query segments.
   The "no free-form URL" + path-param-substitution scenarios are asserted in
   `api.test.ts` ("no free-form URL field" + "a path param substitutes").

3. **Requests execute for real, signed by the operator session** — MET.
   `real.sendApiRequest` does a raw `fetch` reusing the SAME transport as
   `request()`: cross-origin `apiBaseUrl()` + `credentials: "include"` +
   operator-bearer (`authHeaders`) + SSR cookie-forwarding. No token field;
   the request panel shows "会话已签名 · OAuth 自动注入" with no paste affordance
   (design D1). Status/statusText/durationMs/sizeBytes/headers/body are all
   captured and surfaced.

4. **Request editor with Body / Params / Headers and response viewer** — MET.
   `ApiRequestPanel` has a Body tab (JSON `<textarea>` + 格式化 via
   `formatBody`), a 参数 tab (query params), a Headers tab (read-only masked
   `Authorization` + `Content-Type`). `ApiResponsePanel` renders four explicit
   states (EMPTY / PENDING / ERROR(status 0) / RESULT), a status pill, a
   timing+size meta line, and Body/Headers tabs (body pretty-printed from the
   parsed `json`). A failed send maps to `status: 0` and renders the error
   instead of crashing (asserted in both test files).

5. **The SSE events endpoint has a streaming view** — MET. `ApiStreamPanel`
   opens an `EventSource(url, { withCredentials: true })`, appends each event
   to a live tail, and exposes a 停止 control + phase pill. It is visually and
   behaviorally distinct (STREAM · SSE head, cookie-session auth note) and is
   routed only when `endpoint.streaming` is true (design D5).

### frontend-console/spec.md

6. **The API Playground page is in the route tree and navigation** — MET.
   Route at `routes/_app/api.tsx` (behind the `_app` auth gate). Sidebar entry
   added in `app-sidebar.tsx` (`NavKey` extended with `"api"`, `activeNavKey`
   matches `/api`, nav item `{ key: "api", to: "/api", label: "API 调试" }`).
   Mobile nav entry added in `mobile-nav.tsx`.

7. **The /api page has a per-page pixel baseline** — MET. Registered in
   `e2e/visual/manifest.ts` (`id: "api"`, `appPath: "/api"`,
   `designPath: "/screens/api.html"`, both breakpoints, `maxDiffPixelRatio`
   0.06/0.06, `designMask: [".api-res-meta"]`, `readySelector` on the rail).
   Baselines `__screenshots__/api-desktop.png` + `api-mobile.png` exist;
   tasks.md 5.2 records a clean GREEN full-sweep (`api @ desktop` ratio 0.03,
   under the 0.06 threshold).

## Gap finding

A full requirements-to-implementation mapping was performed across both spec
files. **No gaps were found** — every requirement (5 in api-playground, 2 in
frontend-console) maps to concrete code or a confirmed test run:

- api-playground: catalog (`catalog.ts`) → rail (`api-rail.tsx`) → request
  (`api-request-panel.tsx`) → response (`api-response-panel.tsx`) → SSE
  (`api-stream-panel.tsx`) → page glue (`routes/_app/api.tsx`) → real runner
  (`real.ts` `sendApiRequest`) → capability seam (`queries.ts` `runApiRequest`
  + `capabilities.ts` `apiPlayground`).
- frontend-console: route + sidebar + mobile-nav + pixel manifest entry +
  recorded green baselines.

No requirement re-traces as unsatisfied. (No "met-as-written with a minor gap
that blocks the primary scenario" cases either.)

## Scope finding

Eight behaviors exist in the implementation beyond the literal spec text. Each
was assessed; ALL are in-scope (honest robustness / design-faithful detail or
an explicitly-deferred Open Question) — none is unauthorized scope creep, and
none contradicts a spec requirement, so none was routed to a task.

1. **Destructive-send inline confirm** (`api-request-panel.tsx:113,138,226-248`)
   — the design.md Open Questions + tasks.md 2.3 call for "a lightweight
   confirm before a destructive send". Authorized by the change's own design;
   recommended, now implemented. In-scope.

2. **Stale-send dedup via monotonic `sendSeq` ref** (`routes/_app/api.tsx:119-141`)
   — out-of-order in-flight sends are discarded so only the latest result
   applies. Robustness that protects the "response is rendered" scenario from a
   race; no spec conflict. In-scope.

3. **`safeParseBody` raw-string fallback** (`routes/_app/api.tsx:195-203`) — a
   malformed JSON body is passed through as raw text rather than blocking the
   send, so the api can report its own 400. Consistent with "requests execute
   for real" + "a failed send surfaces the error". In-scope.

4. **Rail search also matches `endpoint.title`** (`api-rail.tsx:58`) — the spec
   says the rail is "searchable" without prescribing fields; matching the
   human title in addition to method + path is a faithful superset. In-scope.

5. **SSE closes on error + requires explicit reconnect** (`api-stream-panel.tsx:131-137`)
   — the spec mandates a stop/close control and a live tail; closing on error
   (instead of the browser's silent auto-reconnect loop) and surfacing
   "连接中断" is honest tail behavior, not a contradiction. In-scope.

6. **Stream connect disabled until path params filled** (`api-stream-panel.tsx:86,204`)
   — a `ready` guard prevents opening a stream against an unresolved `:id`
   template. Mirrors "the id is substituted before sending". In-scope.

7. **开发者 monospace section label above the page title** (`routes/_app/api.tsx:153`)
   — page-header copy serving design fidelity (`screens/api.html`); the page
   passes its 0.06 pixel baseline. In-scope.

8. **`status: 0` sentinel for transport errors** (`catalog.ts` / `real.ts` /
   `api.tsx:84-97`) — an internal discriminator the response panel keys its
   ERROR state on. Implementation detail of "render the error rather than
   crashing"; not operator-visible as a number. In-scope.

## Conclusion

All requirements MET; 0 reopened, 0 spec-defects. The change is verification-
clean and eligible for archive on the spec dimension.
