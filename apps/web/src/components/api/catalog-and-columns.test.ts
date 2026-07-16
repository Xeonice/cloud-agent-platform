/**
 * Minimal ground-truth test: "The API Playground page renders a catalog +
 * request/response columns" (add-api-playground requirement).
 *
 * The vitest environment is `node` (no DOM); a focused server render verifies
 * registry guidance while the remaining assertions exercise the pure-logic
 * seams the page composes:
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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PUBLIC_V1_OPERATIONS,
  type PublicV1OperationById,
  type PublicV1OperationId,
  type PublicV1OperationShape,
} from "@cap/contracts";
import { z } from "zod";

import {
  API_CATALOG,
  DATA_API_CATALOG,
  API_DOMAINS,
  DEFAULT_ENDPOINT_ID,
  findEndpoint,
  resolvePath,
} from "@/components/api/catalog";
import { ApiRequestPanel } from "@/components/api/api-request-panel";
import {
  initialSelectedEndpoint,
  mapSendResult,
} from "@/routes/_app/api";
import type { SendApiResult } from "@/lib/api/real";

function operationById<Id extends PublicV1OperationId>(
  id: Id,
): PublicV1OperationById<Id> {
  const operation = PUBLIC_V1_OPERATIONS.find((entry) => entry.id === id);
  if (!operation) throw new Error(`Missing public operation fixture: ${id}`);
  return operation as PublicV1OperationById<Id>;
}

const AFFECTED_PROJECTION_OPERATION_IDS = [
  "tasks.create",
  "tasks.list",
  "tasks.get",
  "tasks.stop",
  "repos.list",
  "repos.get",
] as const satisfies readonly PublicV1OperationId[];

const CANONICAL_TASK_SAMPLE = {
  id: "11111111-1111-4111-8111-111111111111",
  repoId: "22222222-2222-4222-8222-222222222222",
  prompt: "inspect the verified default branch",
  status: "pending",
  createdAt: "2026-07-15T01:00:00.000Z",
  provisioning: {
    state: "accepted",
    stage: "accepted",
    attempt: 0,
    resolvedBranch: null,
    updatedAt: "2026-07-15T01:00:01.000Z",
  },
};

const CANONICAL_FAILURE_SAMPLE = {
  ...CANONICAL_TASK_SAMPLE,
  status: "failed",
  provisioning: {
    ...CANONICAL_TASK_SAMPLE.provisioning,
    state: "failed",
    stage: "workspace_transfer",
  },
  failure: {
    code: "provisioning_ref_not_found",
    message: "Verify the repository ref and retry.",
    action: "verify_repository_ref",
    occurredAt: "2026-07-15T01:02:00.000Z",
  },
};

const CANONICAL_REPO_SAMPLE = {
  id: CANONICAL_TASK_SAMPLE.repoId,
  name: "zhiwen",
  gitSource: "https://code.example.test/group/zhiwen.git",
  createdAt: CANONICAL_TASK_SAMPLE.createdAt,
  defaultBranch: "master",
};

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
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.responseDescription.trim().length).toBeGreaterThan(0);
      // Domain drives the rail grouping header
      expect(API_DOMAINS).toContain(entry.domain);
    }
  });
});

// ── 2. Catalog domain groups (rail left-column sections) ──────────────────

describe("Catalog column — rail domain groups", () => {
  it("API_DOMAINS lists the displayed group headers in order", () => {
    expect(API_DOMAINS).toEqual(["任务", "仓库", "定时任务", "文档"]);
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

  it("renders immediate-create, asynchronous provisioning, and polling guidance", () => {
    const endpoint = findEndpoint("tasks.create")!;
    const html = renderToStaticMarkup(
      createElement(ApiRequestPanel, { endpoint, onSend: () => undefined }),
    );

    expect(html).toContain("data-api-operation-guidance");
    expect(html).toContain("return as soon as that acceptance is committed");
    expect(html).toContain("Provisioning continues asynchronously");
    expect(html).toContain("poll `tasks.get`");
    expect(html).toContain(endpoint.responseDescription);
  });

  it("resolvePath substitutes a path param for an endpoint that has one", () => {
    const getTask = findEndpoint("tasks.get")!;
    expect(getTask).toBeDefined();
    const resolved = resolvePath(getTask, { id: "task_abc" });
    expect(resolved).toBe("/v1/tasks/task_abc");
    expect(resolved).not.toContain(":id");
  });
});

describe("Catalog column — shared public /v1 manifest alignment", () => {
  it("contains exactly the public data operations from the shared manifest", () => {
    const catalogKeys = DATA_API_CATALOG.map((endpoint) =>
      `${endpoint.method} ${endpoint.pathTemplate.replace(/:([^/]+)/g, "{$1}")}`,
    ).sort();
    const manifestKeys = PUBLIC_V1_OPERATIONS.map(
      (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
    ).sort();

    expect(DATA_API_CATALOG).toHaveLength(PUBLIC_V1_OPERATIONS.length);
    expect(catalogKeys).toEqual(manifestKeys);
    expect(DATA_API_CATALOG.map((entry) => entry.operationId).sort()).toEqual(
      PUBLIC_V1_OPERATIONS.map((operation) => operation.id).sort(),
    );
  });

  it("projects exact scope, owner, error, and MCP decisions without changing rows", () => {
    for (const operation of PUBLIC_V1_OPERATIONS) {
      const endpoint = DATA_API_CATALOG.find(
        (candidate) => candidate.operationId === operation.id,
      );
      expect(endpoint, operation.id).toBeDefined();
      expect(endpoint!.requiredScope, operation.id).toBe(operation.scope);
      expect(endpoint!.ownerPolicy, operation.id).toBe(operation.ownerPolicy);
      expect(endpoint!.publicErrors, operation.id).toEqual(operation.errors);

      const expectedMcp =
        "tool" in operation.mcp
          ? {
              status: "mapped",
              tool: operation.mcp.tool,
              differences: operation.mcp.differences,
            }
          : {
              status: "excluded",
              reason: operation.mcp.excluded,
            };
      expect(endpoint!.mcpProjection, operation.id).toEqual(expectedMcp);
    }
  });

  it("projects exact descriptions for the six affected task/repo operations", () => {
    for (const id of AFFECTED_PROJECTION_OPERATION_IDS) {
      const operation = operationById(id);
      const endpoint = findEndpoint(id);
      expect(endpoint, id).toBeDefined();
      expect(endpoint!.description, id).toBe(operation.description);
      expect(endpoint!.responseDescription, id).toBe(
        operation.responseDescription,
      );
    }

    const create = findEndpoint("tasks.create")!;
    expect(create.description).toContain(
      "return as soon as that acceptance is committed",
    );
    expect(create.description).toContain("Provisioning continues asynchronously");
    expect(create.description).toContain("poll `tasks.get`");
  });

  it("retains explicit mapped differences and the reasoned SSE exclusion", () => {
    expect(findEndpoint("tasks.create")!.mcpProjection).toEqual({
      status: "mapped",
      tool: "create_task",
      differences: operationById("tasks.create").mcp.differences,
    });
    expect(
      operationById("tasks.create").mcp.differences.map(
        (difference) => difference.kind,
      ),
    ).toEqual([
      "rest-only-header",
      "mcp-compatibility-text",
      "mcp-description-projection",
      "rate-limit-policy",
    ]);
    expect(findEndpoint("runtimeModels.query")!.mcpProjection).toEqual({
      status: "mapped",
      tool: "list_runtime_models",
      differences: operationById("runtimeModels.query").mcp.differences,
    });
    expect(
      operationById("runtimeModels.query").mcp.differences.map(
        (difference) => difference.kind,
      ),
    ).toEqual(["rate-limit-policy"]);

    expect(findEndpoint("schedules.delete")!.mcpProjection).toEqual({
      status: "mapped",
      tool: "delete_schedule",
      differences: operationById("schedules.delete").mcp.differences,
    });
    expect(findEndpoint("tasks.events")!.mcpProjection).toEqual({
      status: "excluded",
      reason: operationById("tasks.events").mcp.excluded,
    });
    expect(operationById("tasks.events").mcp.excluded.trim()).not.toBe("");
  });

  it("offers the runtime catalog without hardcoding any model selector", () => {
    const endpoint = findEndpoint("runtimeModels.query");
    expect(endpoint).toMatchObject({
      method: "POST",
      pathTemplate: "/v1/runtime-models/query",
      destructive: false,
    });
    expect(JSON.parse(endpoint!.sampleBody!)).toEqual({ runtime: "codex" });
    expect(endpoint!.sampleBody).not.toContain("modelId");
  });

  it("inherits model-aware task, schedule, scope, and error contracts from the manifest", () => {
    const catalog = operationById("runtimeModels.query");
    expect(catalog.scope).toBe("tasks:write");
    expect(catalog.errors).toContain("runtime_model_catalog_unavailable");

    expect(
      operationById("tasks.create").input.body.parse.safeParse({
        repoId: "00000000-0000-4000-a000-000000000101",
        prompt: "check",
        runtime: "codex",
        model: "provider/model:v1",
      }).success,
    ).toBe(true);
    expect(
      operationById("schedules.create").input.body.parse.safeParse({
        recurrence: { kind: "daily", time: "10:30", timezone: "UTC" },
        taskTemplate: {
          repoId: "00000000-0000-4000-a000-000000000101",
          prompt: "scheduled check",
          runtime: "claude-code",
          model: "arn:vendor:model/family:v2",
        },
      }).success,
    ).toBe(true);
    expect(
      operationById("schedules.update").input.body.parse.safeParse({
        taskTemplate: {
          repoId: "00000000-0000-4000-a000-000000000101",
          prompt: "updated check",
          runtime: "codex",
          model: "bad\u0000selector",
        },
      }).success,
    ).toBe(false);
  });

  it.each([422, 429, 503])(
    "keeps a structured model error visible in the response column for HTTP %i",
    (status) => {
      const body = JSON.stringify({
        code:
          status === 422
            ? "runtime_model_not_available"
            : "runtime_model_catalog_unavailable",
        message: "Safe model error",
        retryable: status !== 422,
      });
      const rendered = mapSendResult({
        kind: "response",
        status,
        statusText: "Model Error",
        ok: false,
        durationMs: 12,
        sizeBytes: new TextEncoder().encode(body).byteLength,
        headers: { "content-type": "application/json" },
        body,
        json: JSON.parse(body),
      });

      expect(rendered.status).toBe(status);
      expect(rendered.ok).toBe(false);
      expect(rendered.body).toContain("runtime_model_");
      expect(rendered.json).toMatchObject({ message: "Safe model error" });
    },
  );

  it("keeps documentation endpoints outside the data-operation drift set", () => {
    const docs = API_CATALOG.filter((endpoint) => endpoint.kind === "documentation");
    expect(docs.map((endpoint) => endpoint.pathTemplate)).toEqual([
      "/v1/openapi.json",
      "/v1/docs",
    ]);
    expect(docs.every((endpoint) => endpoint.operationId === null)).toBe(true);
    expect(
      docs.every(
        (endpoint) =>
          endpoint.requiredScope === null &&
          endpoint.ownerPolicy === null &&
          endpoint.mcpProjection === null &&
          endpoint.publicErrors.length === 0,
      ),
    ).toBe(true);
  });

  it("never exposes the internal sandbox callback through the manifest or catalog", () => {
    const internalPath = "/internal/sandbox/approvals";
    expect(
      PUBLIC_V1_OPERATIONS.some(
        (operation) => (operation.path as string) === internalPath,
      ),
    ).toBe(false);
    expect(API_CATALOG.some((endpoint) => endpoint.pathTemplate === internalPath)).toBe(
      false,
    );
  });

  it("parses every sample body with the operation's shared request schema", () => {
    const byId = new Map<string, PublicV1OperationShape>(
      PUBLIC_V1_OPERATIONS.map((operation) => [operation.id, operation]),
    );

    for (const endpoint of DATA_API_CATALOG) {
      const operation = byId.get(endpoint.operationId!);
      expect(operation, endpoint.id).toBeDefined();
      const bodySchema = operation?.input.body?.parse;
      if (!bodySchema) {
        expect(endpoint.sampleBody, endpoint.id).toBeNull();
        continue;
      }

      expect(typeof endpoint.sampleBody, endpoint.id).toBe("string");
      const parsed = bodySchema.safeParse(JSON.parse(endpoint.sampleBody!));
      expect(parsed.success, endpoint.id).toBe(true);
    }
  });

  it("does not fabricate main when the create-task sample omits a branch", () => {
    const create = findEndpoint("tasks.create")!;
    const sample = JSON.parse(create.sampleBody!) as Record<string, unknown>;
    expect(sample).not.toHaveProperty("branch");
    expect(operationById("tasks.create").input.body.parse.safeParse(sample).success).toBe(
      true,
    );
  });

  it("parses canonical accepted/failure/repo samples and maps their exact bodies", () => {
    const { defaultBranch: _defaultBranch, ...repoWithoutDefaultBranch } =
      CANONICAL_REPO_SAMPLE;
    const cases: ReadonlyArray<
      readonly [string, PublicV1OperationId, unknown]
    > = [
      ["accepted task", "tasks.create", CANONICAL_TASK_SAMPLE],
      ["provisioning failure", "tasks.get", CANONICAL_FAILURE_SAMPLE],
      ["repo master", "repos.get", CANONICAL_REPO_SAMPLE],
      [
        "repo null",
        "repos.list",
        {
          items: [{ ...CANONICAL_REPO_SAMPLE, defaultBranch: null }],
          nextCursor: null,
        },
      ],
      ["repo absent", "repos.get", repoWithoutDefaultBranch],
    ];

    for (const [label, operationId, sample] of cases) {
      const operation: PublicV1OperationShape = operationById(operationId);
      expect(operation.responseSchema?.safeParse(sample).success, label).toBe(true);

      const body = JSON.stringify(sample);
      const rendered = mapSendResult({
        kind: "response",
        status: operation.successStatus,
        statusText: "Canonical fixture",
        ok: true,
        durationMs: 1,
        sizeBytes: new TextEncoder().encode(body).byteLength,
        headers: { "content-type": "application/json" },
        body,
        json: sample,
      });
      expect(rendered.body, label).toBe(body);
      expect(rendered.json, label).toEqual(sample);

      for (const forbidden of [
        "leaseOwner",
        "providerEndpoint",
        "nativeSandboxId",
        "credentialPath",
        "rawOutput",
        "authenticatedGitCommand",
        "secret-canary",
      ]) {
        expect(body, `${label} excludes ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("uses UUID examples for every id path parameter", () => {
    const uuid = z.string().uuid();
    for (const endpoint of DATA_API_CATALOG) {
      for (const param of endpoint.pathParams) {
        expect(uuid.safeParse(param.placeholder).success, endpoint.id).toBe(true);
      }
    }
  });

  it("does not fabricate a current-period identity in the debugger sample", () => {
    const dispatch = findEndpoint("schedules.dispatch")!;
    expect(JSON.parse(dispatch.sampleBody!)).toEqual({});
  });

  it("shows structured hourly and fixed-interval recurrence samples", () => {
    const create = JSON.parse(findEndpoint("schedules.create")!.sampleBody!);
    const update = JSON.parse(findEndpoint("schedules.update")!.sampleBody!);

    expect(create.recurrence).toEqual({
      kind: "hourly",
      minuteOfHour: 15,
      timezone: "Asia/Shanghai",
    });
    expect(update.recurrence).toEqual({
      kind: "minuteInterval",
      intervalMinutes: 15,
      timezone: "Asia/Shanghai",
    });
  });

  it("derives every path, query, and header field from the manifest", () => {
    for (const operation of PUBLIC_V1_OPERATIONS) {
      const shape: PublicV1OperationShape = operation;
      const endpoint = DATA_API_CATALOG.find(
        (candidate) => candidate.operationId === operation.id,
      )!;
      expect(
        endpoint.pathParams.map((param) => param.name),
        operation.id,
      ).toEqual(Object.keys(shape.input.params?.wire.shape ?? {}));
      expect(
        endpoint.queryParams.map((param) => param.name),
        operation.id,
      ).toEqual(Object.keys(shape.input.query?.wire.shape ?? {}));
      expect(
        endpoint.headerParams.map((header) => header.name),
        operation.id,
      ).toEqual(Object.keys(shape.input.headers?.wire.shape ?? {}));
    }
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
