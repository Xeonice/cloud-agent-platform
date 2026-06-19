/**
 * Minimal ground-truth test: "The API Playground page renders a catalog +
 * request/response columns" (add-api-playground requirement).
 *
 * The vitest environment is `node` (no DOM, no React render — established repo
 * convention). This test proves the structural requirement through the
 * pure-logic seams the page composes:
 *
 *  1. The CATALOG exists and is non-empty — the rail has something to render.
 *  2. The catalog is grouped into DOMAIN GROUPS that the rail turns into
 *     left-column sections (任务 / 仓库 / 文档 per the design).
 *  3. The default-selected endpoint exposes the REQUEST shape (method,
 *     pathTemplate, sampleBody, params) the REQUEST PANEL binds its editor to.
 *  4. The RESPONSE PANEL's result shape (`ApiSendResult`) is compatible: a
 *     real HTTP outcome maps into status + body + meta, covering the right
 *     request/response column.
 *  5. The catalog + rail + request + response panel modules can all be
 *     imported without a DOM / `window` (SSR-safety = they render in the
 *     `_app` shell server-side without crashing).
 */
import { describe, it, expect } from "vitest";

import {
  API_CATALOG,
  API_DOMAINS,
  DEFAULT_ENDPOINT_ID,
  findEndpoint,
  resolvePath,
} from "@/components/api/catalog";
import {
  initialSelectedEndpoint,
  mapSendResult,
} from "@/routes/_app/api";
import type { SendApiResult } from "@/lib/api/real";

// ── 1. Catalog is non-empty (the rail left column has rows to render) ──────

describe("Catalog column — catalog exists and is non-empty", () => {
  it("exports a non-empty API_CATALOG array", () => {
    expect(Array.isArray(API_CATALOG)).toBe(true);
    expect(API_CATALOG.length).toBeGreaterThan(0);
  });

  it("every catalog entry has the shape the rail row renders against", () => {
    for (const entry of API_CATALOG) {
      // Rail renders: method tag + pathTemplate label + active highlight key
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(["GET", "POST", "PATCH", "DELETE"]).toContain(entry.method);
      expect(entry.pathTemplate.startsWith("/")).toBe(true);
      expect(typeof entry.title).toBe("string");
      // Domain drives the rail grouping header
      expect(API_DOMAINS).toContain(entry.domain);
    }
  });
});

// ── 2. Catalog domain groups (rail left-column sections) ──────────────────

describe("Catalog column — rail domain groups", () => {
  it("API_DOMAINS lists the displayed group headers in order", () => {
    expect(API_DOMAINS).toEqual(["任务", "仓库", "文档"]);
  });

  it("every domain group has at least one catalog entry", () => {
    for (const domain of API_DOMAINS) {
      const rows = API_CATALOG.filter((e) => e.domain === domain);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("every catalog entry belongs to a declared domain (no orphaned rows)", () => {
    for (const entry of API_CATALOG) {
      expect(API_DOMAINS).toContain(entry.domain);
    }
  });
});

// ── 3. Request column — default selection seeds the request editor ────────

describe("Request column — default-selected endpoint seeds the request panel", () => {
  it("initialSelectedEndpoint() resolves to the declared DEFAULT_ENDPOINT_ID", () => {
    const endpoint = initialSelectedEndpoint();
    expect(endpoint.id).toBe(DEFAULT_ENDPOINT_ID);
  });

  it("default endpoint provides all fields the request panel needs", () => {
    const endpoint = initialSelectedEndpoint();
    // Method tag in the request bar
    expect(["GET", "POST", "PATCH", "DELETE"]).toContain(endpoint.method);
    // Path displayed in the request bar (the curated resolved path)
    expect(endpoint.pathTemplate.startsWith("/")).toBe(true);
    // Body tab: the default endpoint (POST /v1/tasks) must have a sample body
    expect(typeof endpoint.sampleBody).toBe("string");
    expect(endpoint.sampleBody!.length).toBeGreaterThan(0);
    // Params the request panel binds to inputs
    expect(Array.isArray(endpoint.pathParams)).toBe(true);
    expect(Array.isArray(endpoint.queryParams)).toBe(true);
  });

  it("resolvePath substitutes a path param for an endpoint that has one", () => {
    const getTask = findEndpoint("get-task")!;
    expect(getTask).toBeDefined();
    const resolved = resolvePath(getTask, { id: "task_abc" });
    expect(resolved).toBe("/v1/tasks/task_abc");
    expect(resolved).not.toContain(":id");
  });
});

// ── 4. Response column — mapSendResult populates the response panel ───────

describe("Response column — mapSendResult drives the response panel", () => {
  it("a 2xx HTTP result maps to the response panel's status/body/meta shape", () => {
    const httpOk: SendApiResult = {
      kind: "response",
      status: 200,
      statusText: "OK",
      ok: true,
      durationMs: 88,
      sizeBytes: 200,
      headers: { "content-type": "application/json" },
      body: '{"items":[]}',
      json: { items: [] },
    };
    const rendered = mapSendResult(httpOk);
    // Status pill in the response section header
    expect(rendered.status).toBe(200);
    expect(rendered.ok).toBe(true);
    // Meta line: "88 ms · 200 B"
    expect(rendered.durationMs).toBe(88);
    expect(rendered.sizeBytes).toBe(200);
    // Body tab content
    expect(rendered.body).toBe('{"items":[]}');
    expect(rendered.json).toEqual({ items: [] });
  });

  it("a transport failure maps to status 0 and surfaces the error message (no crash)", () => {
    const transportError: SendApiResult = {
      kind: "error",
      message: "Failed to fetch",
      durationMs: 5,
    };
    const rendered = mapSendResult(transportError);
    // Response panel's ERROR state keys on status === 0
    expect(rendered.status).toBe(0);
    expect(rendered.ok).toBe(false);
    expect(rendered.body).toBe("Failed to fetch");
    // Never throws — the page always hands the panel a render-able result
  });

  it("a non-2xx response renders honestly (not a crash)", () => {
    const notFound: SendApiResult = {
      kind: "response",
      status: 404,
      statusText: "Not Found",
      ok: false,
      durationMs: 20,
      sizeBytes: 30,
      headers: {},
      body: '{"error":"not found"}',
      json: { error: "not found" },
    };
    const rendered = mapSendResult(notFound);
    expect(rendered.status).toBe(404);
    expect(rendered.ok).toBe(false);
    expect(rendered.body).toContain("not found");
  });
});

// ── 5. SSR-safety: modules import without window / DOM ────────────────────

describe("SSR-safety — catalog + panel modules import in node environment", () => {
  it("catalog module has no window references at import time (already imported above without error)", () => {
    // If the imports at the top of this file succeeded (no thrown ReferenceError
    // for window/document), the catalog is SSR-safe. Confirm the export is alive.
    expect(API_CATALOG).toBeDefined();
    expect(API_DOMAINS).toBeDefined();
    expect(typeof findEndpoint).toBe("function");
    expect(typeof resolvePath).toBe("function");
  });

  it("page seams (initialSelectedEndpoint, mapSendResult) import without DOM", () => {
    expect(typeof initialSelectedEndpoint).toBe("function");
    expect(typeof mapSendResult).toBe("function");
  });
});
