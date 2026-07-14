import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import {
  ApiError,
  queryRuntimeModels,
  runtimeModelErrorFromApiError,
} from "./real";

const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000201";
const CATALOG = {
  runtime: "codex",
  effectiveEnvironment: {
    kind: "deployment-default",
    id: null,
    name: "Deployment default",
    provider: "aio",
    fingerprint: "environment-fingerprint",
  },
  cliVersion: "0.144.1",
  source: "codex-app-server",
  completeness: "complete",
  revision: "catalog-revision",
  defaultModel: "default.model-v1",
  models: [
    {
      id: "default.model-v1",
      displayName: "Default model",
      isDefault: true,
      availabilityEvidence: "account-discovered",
    },
  ],
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queryRuntimeModels", () => {
  it.each([
    ["account default", { runtime: "codex" }],
    ["deployment default", { runtime: "codex", sandboxEnvironmentId: null }],
    [
      "managed environment",
      { runtime: "codex", sandboxEnvironmentId: ENVIRONMENT_ID },
    ],
  ] as const)("preserves the %s environment intent on the wire", async (_name, body) => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryRuntimeModels(body)).resolves.toMatchObject(CATALOG);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/runtime-models/query",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  });

  it("rejects a response that is not the canonical catalog schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...CATALOG, leakedCredential: "secret" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(queryRuntimeModels({ runtime: "codex" })).rejects.toThrow();
  });

  it.each([
    [
      422,
      {
        code: "runtime_model_not_available",
        message: "The requested runtime model is not available.",
        retryable: false,
      },
    ],
    [
      503,
      {
        code: "runtime_model_catalog_unavailable",
        message: "Runtime model catalog is temporarily unavailable.",
        retryable: true,
        capacity: { scope: "owner", retryAfterMs: 1500 },
      },
    ],
  ] as const)("retains and parses the canonical %i error body", async (status, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    let caught: unknown;
    try {
      await queryRuntimeModels({ runtime: "codex" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(runtimeModelErrorFromApiError(caught)).toEqual(body);
  });
});
