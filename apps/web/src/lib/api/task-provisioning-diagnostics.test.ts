import { QueryClient } from "@tanstack/react-query";
import {
  TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES,
  type TaskProvisioningDiagnosticsResponse,
} from "@cap/contracts";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "cap_session=signed-session",
}));

import {
  getTaskProvisioningDiagnostics,
  TaskProvisioningDiagnosticsClientError,
} from "./real";
import {
  queryKeys,
  taskProvisioningDiagnosticsInfiniteQuery,
} from "./queries";

const TASK_ID = "00000000-0000-4000-8000-000000000102";
const CANARY = "diagnostic-secret-canary-never-cache:+/@?=%";
const CANARY_VARIANTS = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY, "utf8").toString("base64"),
  Buffer.from(CANARY, "utf8").toString("base64url"),
] as const;
const RAW_PROVIDER_ID_CANARY = "boxlite-private-provider-id-never-cache";

function forbiddenResponsePayload(): Record<string, unknown> {
  return {
    message: CANARY_VARIANTS[0],
    command: CANARY_VARIANTS[1],
    stdout: CANARY_VARIANTS[2],
    stderr: CANARY_VARIANTS[3],
    body: Buffer.from(CANARY, "utf8"),
    tokenUrl: `https://provider.test/?token=${CANARY_VARIANTS[1]}`,
    headers: { authorization: CANARY_VARIANTS[2] },
    providerSandboxId: RAW_PROVIDER_ID_CANARY,
  };
}

function expectCanaryAbsent(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const variant of CANARY_VARIANTS) {
    expect(serialized).not.toContain(variant);
  }
  expect(serialized).not.toContain(RAW_PROVIDER_ID_CANARY);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [
    String(error),
    error.stack ?? "",
    JSON.stringify(
      Object.fromEntries(
        Object.getOwnPropertyNames(error).map((key) => [
          key,
          (error as unknown as Record<string, unknown>)[key],
        ]),
      ),
    ),
  ].join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("task provisioning diagnostics Console client", () => {
  it("sends bounded limit/cursor values and strictly coerces canonical dates", async () => {
    const fetchMock = vi.fn(async () =>
      response(
        TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES
          .partialPrimaryAndCleanup.value,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cursor = "page/2+stable";
    const options = taskProvisioningDiagnosticsInfiniteQuery(TASK_ID, 25);
    const queryFn = options.queryFn as (context: {
      pageParam: string | undefined;
    }) => Promise<TaskProvisioningDiagnosticsResponse>;

    const parsed = await queryFn({ pageParam: cursor });

    expect(parsed.attempts[0]?.startedAt).toBeInstanceOf(Date);
    expect(parsed.events[0]?.observedAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/tasks/${TASK_ID}/provisioning-diagnostics?limit=25&cursor=${encodeURIComponent(cursor)}`,
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          Cookie: "cap_session=signed-session",
        }),
      }),
    );
    const nextPage = options.getNextPageParam as (
      page: TaskProvisioningDiagnosticsResponse,
    ) => string | undefined;
    expect(nextPage(parsed)).toBe(parsed.nextCursor ?? undefined);
  });

  it.each([
    [403, "denied"],
    [404, "not_found"],
    [503, "unavailable"],
    [500, "request_failed"],
  ] as const)(
    "reduces HTTP %s payloads to the fixed %s error",
    async (status, reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(forbiddenResponsePayload(), status)),
      );

      let caught: unknown;
      try {
        await getTaskProvisioningDiagnostics(TASK_ID, { limit: 50 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TaskProvisioningDiagnosticsClientError);
      expect(caught).toMatchObject({ reason, status });
      expectCanaryAbsent(errorSurface(caught));
    },
  );

  it("keeps raw error bodies out of the TanStack Query error cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(forbiddenResponsePayload(), 403)),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = taskProvisioningDiagnosticsInfiniteQuery(TASK_ID, 17);

    await expect(client.fetchInfiniteQuery(options)).rejects.toMatchObject({
      reason: "denied",
      status: 403,
    });

    const cachedError = client.getQueryState(options.queryKey)?.error;
    expect(cachedError).toBeInstanceOf(TaskProvisioningDiagnosticsClientError);
    expectCanaryAbsent(errorSurface(cachedError));
  });

  it("rejects an unknown-field 200 response without retaining parser input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ...TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES.notStarted.value,
          providerError: forbiddenResponsePayload(),
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = taskProvisioningDiagnosticsInfiniteQuery(TASK_ID);

    await expect(client.fetchInfiniteQuery(options)).rejects.toMatchObject({
      reason: "invalid_response",
      status: null,
    });

    const cachedError = client.getQueryState(options.queryKey)?.error;
    expectCanaryAbsent(errorSurface(cachedError));
  });

  it("rejects out-of-bound page sizes before issuing a request", () => {
    expect(() => taskProvisioningDiagnosticsInfiniteQuery(TASK_ID, 0)).toThrow();
    expect(() => taskProvisioningDiagnosticsInfiniteQuery(TASK_ID, 201)).toThrow();
  });
});

describe("task provisioning diagnostics cache identity", () => {
  it("uses a dedicated root that task/session/schedule invalidation cannot match", async () => {
    const client = new QueryClient();
    const diagnosticKey = queryKeys.taskProvisioningDiagnostics(TASK_ID, 50);
    client.setQueryData(queryKeys.task(TASK_ID), { status: "running" });
    client.setQueryData(diagnosticKey, { pages: [], pageParams: [] });

    await client.invalidateQueries({
      queryKey: queryKeys.task(TASK_ID),
      refetchType: "none",
    });

    expect(diagnosticKey[0]).toBe("task-provisioning-diagnostics");
    expect(diagnosticKey[0]).not.toBe(queryKeys.tasks[0]);
    expect(client.getQueryState(queryKeys.task(TASK_ID))?.isInvalidated).toBe(true);
    expect(client.getQueryState(diagnosticKey)?.isInvalidated).toBe(false);
    expect(queryKeys.taskContext(TASK_ID)[0]).toBe("tasks");
    expect(queryKeys.sessionHistory(TASK_ID)[0]).toBe("tasks");
    expect(queryKeys.scheduleRuns(TASK_ID)[0]).toBe("schedules");
  });
});
