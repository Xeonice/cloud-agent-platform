/**
 * `/api` — the in-console API Playground (add-api-playground Track 3, task 3.1;
 * epic Track B). Faithful to the OpenDesign `screens/api.html` revision: a
 * `screen-header` then a two-column `api-console` — the searchable endpoint RAIL
 * (left) + a stacked request / response column (right).
 *
 * This route is the PAGE-AND-STREAM glue: it owns the selection + send state and
 * COMPOSES the catalog (Track 2 `catalog.ts`), the rail / request / response
 * panels (Track 2), and the generic runner (`runApiRequest`, Track 1's seam over
 * `real.sendApiRequest`). It does NOT rebuild the shell — it renders inside the
 * `_app` `<Outlet/>` like dashboard / repositories / history / settings (the
 * sidebar / topbar / mobile-nav already exist).
 *
 * Wiring (api-playground spec):
 *  - The rail raises `onSelect(endpoint)` → the page selects it → the request
 *    panel re-seeds its editor for that endpoint ("Selecting an endpoint loads
 *    it into the request editor").
 *  - The request panel resolves the curated path (with `:id`-style params
 *    substituted, design D2 — there is NO free-form URL field) and raises
 *    `onSend(request)`; the page runs it through `runApiRequest` (the operator's
 *    SESSION-signed transport, no token to paste, D1) and feeds the mapped result
 *    to the response panel.
 *  - A `streaming: true` entry (`GET /v1/tasks/:id/events`) is routed to the live
 *    SSE tail (`ApiStreamPanel`, task 3.2) instead of the single request/response
 *    runner (design D5).
 *
 * Deterministic mock-mode render (design D6): the page DEFAULT-selects a fixed
 * catalog endpoint (`DEFAULT_ENDPOINT_ID` = `POST /v1/tasks`) with its sample
 * body and an EMPTY response, so the SSR / mock-mode render is stable for the
 * pixel baseline. In mock / backend-less mode `runApiRequest` resolves to a clear
 * "needs the running api" error result (Track 1) rather than a fabricated 200, so
 * the page renders honestly without a backend.
 *
 * SSR-safe: the route is deterministic off the catalog default; selection / send
 * state is plain `useState`. The runner + the SSE stream are only reached on an
 * explicit 发送 (a client event), never during render — no window/clock/random at
 * module scope or in the render path.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { runApiRequest } from "@/lib/api/queries";
import type { SendApiResult } from "@/lib/api/real";
import {
  DEFAULT_ENDPOINT_ID,
  findEndpoint,
  API_CATALOG,
  type ApiEndpoint,
  type ApiSendResult,
} from "@/components/api/catalog";
import { ApiRail } from "@/components/api/api-rail";
import {
  ApiRequestPanel,
  type ApiResolvedRequest,
} from "@/components/api/api-request-panel";
import { ApiResponsePanel } from "@/components/api/api-response-panel";
import { ApiStreamPanel } from "@/components/api/api-stream-panel";

export const Route = createFileRoute("/_app/api")({
  component: ApiPlaygroundPage,
});

/**
 * The deterministic initial selection (design D6). Resolves the catalog's
 * default endpoint id to its entry; falls back to the first catalog entry if the
 * id ever drifts, so the page ALWAYS opens on a real, send-able endpoint (never
 * an undefined editor). Exported for the page test.
 */
export function initialSelectedEndpoint(): ApiEndpoint {
  return findEndpoint(DEFAULT_ENDPOINT_ID) ?? API_CATALOG[0]!;
}

/**
 * Map the runner's discriminated `SendApiResult` (Track 1) into the FLAT
 * `ApiSendResult` shape the response panel renders (Track 2). This is the page's
 * glue: the runner distinguishes a real HTTP round-trip (`kind: "response"`,
 * any status) from a transport failure (`kind: "error"`, no HTTP status); the
 * panel renders a single shape where a transport failure is `status: 0`
 * (api-playground spec "A failed send surfaces an error, not a crash" — the page
 * NEVER throws; it always hands the panel an honest, render-able result).
 *
 * Exported for the page test (the mocked-result rendering + failed-send paths).
 */
export function mapSendResult(result: SendApiResult): ApiSendResult {
  if (result.kind === "error") {
    // A transport failure never reached the api: no HTTP status (0), the
    // message becomes the body so the response panel's error state shows it.
    return {
      status: 0,
      statusText: result.message,
      ok: false,
      durationMs: result.durationMs,
      sizeBytes: 0,
      headers: {},
      body: result.message,
    };
  }
  return {
    status: result.status,
    statusText: result.statusText,
    ok: result.ok,
    durationMs: result.durationMs,
    sizeBytes: result.sizeBytes,
    headers: result.headers,
    body: result.body,
    json: result.json,
  };
}

function ApiPlaygroundPage() {
  const [endpoint, setEndpoint] = React.useState<ApiEndpoint>(
    initialSelectedEndpoint,
  );
  const [result, setResult] = React.useState<ApiSendResult | null>(null);
  const [pending, setPending] = React.useState(false);
  // A monotonically-incrementing id discarded stale sends: if the operator
  // switches endpoints / re-sends before an in-flight send resolves, only the
  // LATEST send's result is applied (no out-of-order overwrite).
  const sendSeq = React.useRef(0);

  function handleSelect(next: ApiEndpoint) {
    if (next.id === endpoint.id) return;
    setEndpoint(next);
    // A fresh endpoint starts with a clean response surface (no stale result
    // bleeding across endpoints) — the editor re-seed is the request panel's job.
    setResult(null);
    setPending(false);
  }

  async function handleSend(request: ApiResolvedRequest) {
    const seq = ++sendSeq.current;
    setPending(true);
    setResult(null);
    const outcome = await runApiRequest({
      method: request.method,
      path: request.path,
      query: request.query,
      headers: request.headers,
      body: request.body,
    });
    // Drop a stale resolution (the operator moved on before this resolved).
    if (seq !== sendSeq.current) return;
    setResult(mapSendResult(outcome));
    setPending(false);
  }

  return (
    <>
      {/* Screen header (prototype `.screen-header`). */}
      <section className="mb-[18px] grid items-end gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            开发者
          </div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            API 调试
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            用当前操作者会话直接调用平台 API，验证请求与响应；凭据由会话自动签名，无需手动填 Token。
          </p>
        </div>
      </section>

      {/* `.api-console`: rail (left) + request/response column (right). The rail
          drops below the column ≤820px (single column) per the design. */}
      <section className="grid items-start gap-4 min-[821px]:grid-cols-[260px_minmax(0,1fr)]">
        <ApiRail selectedId={endpoint.id} onSelect={handleSelect} />

        <div className="grid min-w-0 gap-4">
          {endpoint.streaming ? (
            // The SSE events endpoint is a live tail, not a single request/response
            // (design D5) — visually + behaviorally distinct.
            <ApiStreamPanel endpoint={endpoint} />
          ) : (
            <>
              <ApiRequestPanel
                endpoint={endpoint}
                pending={pending}
                onSend={handleSend}
              />
              <ApiResponsePanel result={result} pending={pending} />
            </>
          )}
        </div>
      </section>
    </>
  );
}
