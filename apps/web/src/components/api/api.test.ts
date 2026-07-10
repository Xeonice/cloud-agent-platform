/**
 * API Playground page-and-stream tests (add-api-playground Track 3, task 3.3).
 *
 * The console's verification suite runs in vitest's `node` environment with NO
 * DOM and NO `@testing-library/react` (vitest.config.ts: `environment: "node"`,
 * `include: ["src/**\/*.test.ts"]`) — the established repo convention is
 * PURE-LOGIC tests, not React-DOM renders (see `lib/api/*.test.ts`). So rather
 * than mount the page, this proves the page-and-stream track's BEHAVIORS through
 * the page's exported pure glue (`initialSelectedEndpoint`, `mapSendResult`) +
 * the curated catalog + the panels' shared `resolvePath` — the same invariants a
 * DOM test would assert, expressed against the seams the page actually composes.
 *
 * Covers task 3.3 verbatim:
 *  - selecting an endpoint populates the request editor,
 *  - a path param substitutes into the path,
 *  - a (mocked) `sendApiRequest` result renders status/timing/body,
 *  - a failed send renders an error, not a crash,
 *  - there is NO free-form URL field (only catalog paths reachable).
 */
import { describe, it, expect } from "vitest";

import {
  initialSelectedEndpoint,
  mapSendResult,
} from "@/routes/_app/api";
import type { SendApiResult } from "@/lib/api/real";
import {
  API_CATALOG,
  DEFAULT_ENDPOINT_ID,
  findEndpoint,
  resolvePath,
  type ApiEndpoint,
} from "@/components/api/catalog";
import { validateApiRequestDraft } from "@/components/api/api-request-panel";

/** The request panel seeds its editor from an endpoint; mirror that derivation. */
function seededEditor(endpoint: ApiEndpoint) {
  return {
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    body: endpoint.sampleBody ?? "",
    queryKeys: endpoint.queryParams.map((q) => q.name),
    headerKeys: endpoint.headerParams.map((header) => header.name),
    pathParamNames: endpoint.pathParams.map((p) => p.name),
  };
}

describe("API Playground — selection loads the request editor", () => {
  it("default-selects a deterministic, send-able catalog endpoint", () => {
    const endpoint = initialSelectedEndpoint();
    // Must be a REAL catalog entry (never an undefined editor) and the declared
    // default (design D6 — stable mock-mode render).
    expect(API_CATALOG.some((e) => e.id === endpoint.id)).toBe(true);
    expect(endpoint.id).toBe(DEFAULT_ENDPOINT_ID);
  });

  it("selecting any catalog endpoint resolves to a seedable editor", () => {
    // The rail raises onSelect(endpoint); the page selects it; the request panel
    // seeds method + path + body + params for THAT endpoint.
    for (const entry of API_CATALOG) {
      const selected = findEndpoint(entry.id);
      expect(selected).toBeDefined();
      const editor = seededEditor(selected!);
      expect(editor.method).toBe(entry.method);
      expect(editor.pathTemplate).toBe(entry.pathTemplate);
      // A write endpoint seeds a JSON body; a read seeds an empty body.
      if (entry.sampleBody !== null) {
        expect(editor.body.length).toBeGreaterThan(0);
        expect(() => JSON.parse(editor.body)).not.toThrow();
      } else {
        expect(editor.body).toBe("");
      }
    }
  });
});

describe("API Playground — a path param substitutes into the path", () => {
  it("substitutes a supplied :id into the curated path", () => {
    const getTask = findEndpoint("tasks.get")!;
    expect(getTask.pathTemplate).toBe("/v1/tasks/:id");
    const resolved = resolvePath(getTask, { id: "task_f8a2" });
    expect(resolved).toBe("/v1/tasks/task_f8a2");
    expect(resolved).not.toContain(":id");
  });

  it("URL-encodes the id so it can never inject extra path/query segments", () => {
    const getTask = findEndpoint("tasks.get")!;
    const resolved = resolvePath(getTask, { id: "a/b?c=d" });
    // The slash/query chars are encoded — the curated path stays one segment.
    expect(resolved).toBe(`/v1/tasks/${encodeURIComponent("a/b?c=d")}`);
    expect(resolved.startsWith("/v1/tasks/")).toBe(true);
  });

  it("leaves the :id placeholder visible when no value is supplied", () => {
    const getTask = findEndpoint("tasks.get")!;
    expect(resolvePath(getTask, {})).toBe("/v1/tasks/:id");
  });
});

describe("API Playground — invalid drafts cannot be sent", () => {
  it("rejects a request until every path parameter is filled", () => {
    const endpoint = findEndpoint("tasks.get")!;
    expect(validateApiRequestDraft(endpoint, {}, "")).toEqual({
      ok: false,
      message: "请填写任务 ID。",
    });
  });

  it("rejects malformed JSON instead of converting it to a JSON string", () => {
    const endpoint = findEndpoint("tasks.create")!;
    expect(validateApiRequestDraft(endpoint, {}, "{")).toEqual({
      ok: false,
      message: "请求体必须是合法 JSON。",
    });
  });

  it("returns the parsed JSON value for a valid body-bearing request", () => {
    const endpoint = findEndpoint("tasks.create")!;
    const validation = validateApiRequestDraft(
      endpoint,
      {},
      '{"repoId":"00000000-0000-4000-a000-000000000101","prompt":"check"}',
    );
    expect(validation).toEqual({
      ok: true,
      body: {
        repoId: "00000000-0000-4000-a000-000000000101",
        prompt: "check",
      },
    });
  });
});

describe("API Playground — public protocol headers", () => {
  it("exposes Idempotency-Key for task-create retries", () => {
    const endpoint = findEndpoint("tasks.create")!;
    expect(endpoint.headerParams.map((header) => header.name)).toEqual([
      "Idempotency-Key",
    ]);
  });

  it("exposes Last-Event-ID for SSE resume", () => {
    const endpoint = findEndpoint("tasks.events")!;
    expect(endpoint.headerParams.map((header) => header.name)).toEqual([
      "Last-Event-ID",
    ]);
  });
});

describe("API Playground — a mocked send result renders status/timing/body", () => {
  it("maps a real HTTP response into the panel's status/timing/body shape", () => {
    // A mocked `sendApiRequest` outcome (Track 1's discriminated union).
    const mocked: SendApiResult = {
      kind: "response",
      status: 201,
      statusText: "Created",
      ok: true,
      durationMs: 142,
      sizeBytes: 312,
      headers: { "content-type": "application/json" },
      body: '{"id":"task_f8a2","status":"pending"}',
      json: { id: "task_f8a2", status: "pending" },
    };
    const rendered = mapSendResult(mocked);
    // The response panel reads status + statusText, durationMs + sizeBytes (meta),
    // and body — assert the page hands it exactly those.
    expect(rendered.status).toBe(201);
    expect(rendered.statusText).toBe("Created");
    expect(rendered.ok).toBe(true);
    expect(rendered.durationMs).toBe(142);
    expect(rendered.sizeBytes).toBe(312);
    expect(rendered.body).toContain("task_f8a2");
    expect(rendered.json).toEqual({ id: "task_f8a2", status: "pending" });
  });

  it("preserves a non-2xx status as a normal (non-throwing) result", () => {
    const mocked: SendApiResult = {
      kind: "response",
      status: 404,
      statusText: "Not Found",
      ok: false,
      durationMs: 30,
      sizeBytes: 40,
      headers: {},
      body: '{"error":"task not found"}',
      json: { error: "task not found" },
    };
    const rendered = mapSendResult(mocked);
    expect(rendered.status).toBe(404);
    expect(rendered.ok).toBe(false);
    expect(rendered.body).toContain("task not found");
  });
});

describe("API Playground — a failed send renders an error, not a crash", () => {
  it("maps a transport failure to status 0 + the error message (never throws)", () => {
    const failed: SendApiResult = {
      kind: "error",
      message: "Failed to fetch",
      durationMs: 12,
    };
    // The mapping must NOT throw — the page always hands the panel a render-able
    // result (spec "A failed send surfaces an error, not a crash").
    const rendered = mapSendResult(failed);
    expect(rendered.status).toBe(0);
    expect(rendered.ok).toBe(false);
    // The response panel's ERROR state keys on `status === 0` and shows the body.
    expect(rendered.body).toBe("Failed to fetch");
    expect(rendered.statusText).toBe("Failed to fetch");
    expect(rendered.durationMs).toBe(12);
  });

  it("maps the mock/backend-less 'needs the running api' result honestly", () => {
    // Track 1's runner resolves a clear error in mock mode — the page renders it
    // as an honest error state, not a fabricated 200.
    const needsApi: SendApiResult = {
      kind: "error",
      message:
        "API 调试需要连接到正在运行的后端：当前为本地 mock 模式（VITE_FORCE_MOCK 或后端不可用），发送已被禁用。",
      durationMs: 0,
    };
    const rendered = mapSendResult(needsApi);
    expect(rendered.status).toBe(0);
    expect(rendered.body).toContain("mock 模式");
  });
});

describe("API Playground — no free-form URL field (only catalog paths)", () => {
  it("every reachable request targets a curated /v1 path template", () => {
    // The page only ever sends a path RESOLVED from a catalog template — there is
    // no operator-typed URL. Assert the curated surface is closed: every entry is
    // a fixed, relative `/v1` (or `/metrics`-style) path, never an absolute URL.
    for (const entry of API_CATALOG) {
      expect(entry.pathTemplate.startsWith("/")).toBe(true);
      // No scheme/host — a free-form box would allow `http(s)://other-host`.
      expect(entry.pathTemplate).not.toMatch(/^[a-z]+:\/\//i);
    }
  });

  it("the catalog endpoint model carries no free-form URL field", () => {
    // The shape the rail/request panel render against has a fixed `pathTemplate`
    // + dedicated path params — there is deliberately no `url`/`href`/`endpoint`
    // free-text key an operator could point at an arbitrary host.
    const sample = API_CATALOG[0]!;
    expect(sample).not.toHaveProperty("url");
    expect(sample).not.toHaveProperty("href");
    expect(Object.keys(sample)).toContain("pathTemplate");
  });

  it("resolving a path with an unknown param key cannot escape the template", () => {
    // Even a stray param map can only fill DECLARED `:name` slots; an undeclared
    // key is ignored, so the resolved path stays within the curated template.
    const listTasks = findEndpoint("tasks.list")!;
    const resolved = resolvePath(listTasks, { evil: "://attacker" });
    expect(resolved).toBe("/v1/tasks");
  });
});
