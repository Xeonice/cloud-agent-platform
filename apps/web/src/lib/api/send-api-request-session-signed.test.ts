/**
 * Requirement: "Requests execute for real, signed by the operator session"
 * (add-api-playground spec, requirement 3 / scenario "A sent request is signed
 * by the session and rendered").
 *
 * The spec mandates:
 *   1. The send executes against the running api via `credentials: "include"` so
 *      the session cookie rides cross-origin automatically (no pasted token).
 *   2. The optional configured legacy operator bearer is auto-injected via the
 *      Authorization header; normal browser sessions authenticate by cookie.
 *   3. The result carries status + timing + headers + body for inspection (NOT a
 *      fabricated 200 and NOT an exception on a non-2xx — the playground surfaces
 *      whatever the api returned).
 *   4. There is NO free-form URL field: the runner targets the api base URL only
 *      (SSRF-safety). The catalog constrains the surface; the runner itself is
 *      path-agnostic but always prepends `apiBaseUrl()`.
 *   5. A transport failure resolves to a `kind: "error"` result (the page never
 *      throws / never crashes) — "a failed send surfaces an error, not a crash".
 *   6. SSE uses the same credentials and can send `Last-Event-ID`, while parsing
 *      framed events even when a frame is split across network chunks.
 *
 * Pure node-env unit test: `fetch`, `../config`, and `../server-cookie` are
 * stubbed so `sendApiRequest` runs its REAL code path (not a tautology — a
 * regression that dropped `credentials`, stripped the Authorization header, or
 * threw on a non-2xx would fail these assertions).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => "tok-operator-session",
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import { sendApiRequest, streamApiEvents } from "./real";

/** Capture the fetch call and return a synthetic Response. */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Scenario: A sent request is signed by the session and rendered
// ---------------------------------------------------------------------------

describe("sendApiRequest — session-signed transport", () => {
  it("attaches credentials:include on every send (session cookie rides cross-origin)", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await sendApiRequest({ method: "GET", path: "/v1/tasks" });

    expect(spy).toHaveBeenCalledOnce();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("auto-injects the operator bearer token (no token pasting needed)", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await sendApiRequest({ method: "GET", path: "/v1/tasks" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-operator-session");
  });

  it("preserves an operation-specific Idempotency-Key header", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ id: "t1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    await sendApiRequest({
      method: "POST",
      path: "/v1/tasks",
      headers: { "Idempotency-Key": "retry-1" },
      body: {
        repoId: "00000000-0000-4000-a000-000000000101",
        prompt: "check",
      },
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-operator-session",
      "Idempotency-Key": "retry-1",
    });
  });

  it("executes the manifest-driven runtime-model catalog request and preserves its structured failure", async () => {
    const body = {
      code: "runtime_model_catalog_unavailable",
      message: "Runtime model catalog is temporarily unavailable.",
      retryable: true,
      capacity: { scope: "owner", retryAfterMs: 1500 },
    };
    const spy = stubFetch(
      new Response(JSON.stringify(body), {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await sendApiRequest({
      method: "POST",
      path: "/v1/runtime-models/query",
      body: { runtime: "codex", sandboxEnvironmentId: null },
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/runtime-models/query");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ runtime: "codex", sandboxEnvironmentId: null }),
    });
    expect(result).toMatchObject({
      kind: "response",
      status: 503,
      ok: false,
      json: body,
    });
  });

  it("targets the api base URL (not an arbitrary host — no open SSRF box)", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await sendApiRequest({ method: "GET", path: "/v1/tasks/abc" });

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^http:\/\/api\.test\//);
    expect(url).toBe("http://api.test/v1/tasks/abc");
  });

  it("captures status + statusText + durationMs + sizeBytes + headers + body on a 2xx", async () => {
    stubFetch(
      new Response(JSON.stringify({ id: "t1", status: "running" }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await sendApiRequest({ method: "GET", path: "/v1/tasks/t1" });

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.headers).toMatchObject({ "content-type": "application/json" });
    expect(result.body).toContain('"id"');
    expect(result.json).toMatchObject({ id: "t1", status: "running" });
  });

  it("resolves a non-2xx to kind:response (not a throw) — renders honestly, not a crash", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      }),
    );

    // A playground must surface whatever the api returned, incl. 4xx/5xx.
    const result = await sendApiRequest({
      method: "GET",
      path: "/v1/tasks/missing",
    });

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    // The body is still captured and returned (not swallowed).
    expect(result.body).toContain("not found");
  });

  it("resolves a transport failure to kind:error (never throws — page stays usable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const result = await sendApiRequest({ method: "GET", path: "/v1/tasks" });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toMatch(/Failed to fetch/i);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("streamApiEvents — public SSE transport", () => {
  it("sends Last-Event-ID and parses framed events across chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: event-2\ndata: {\"status\":\"run"));
        controller.enqueue(encoder.encode("ning\"}\n\n: heartbeat\n\n"));
        controller.close();
      },
    });
    const spy = stubFetch(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );
    const events: Array<{ id?: string; data: string }> = [];
    const onOpen = vi.fn();

    await streamApiEvents({
      path: "/v1/tasks/00000000-0000-4000-a000-000000000101/events",
      lastEventId: " event-1 ",
      onOpen,
      onEvent: (event) => events.push(event),
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-operator-session",
      "Last-Event-ID": "event-1",
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { id: "event-2", event: undefined, data: '{"status":"running"}' },
    ]);
  });

  it("rejects a non-SSE response instead of parsing it as events", async () => {
    stubFetch(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      streamApiEvents({
        path: "/v1/tasks/00000000-0000-4000-a000-000000000101/events",
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/Expected text\/event-stream/);
  });
});
