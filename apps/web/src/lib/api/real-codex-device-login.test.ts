import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import {
  cancelCodexDeviceLogin,
  pollCodexDeviceLogin,
  startCodexDeviceLogin,
} from "./real";

const SESSION_ID = "00000000-0000-4000-8000-000000000401";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000402";
const EXPIRES_AT = "2026-07-13T09:30:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubJson(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Codex device-login REST client", () => {
  it("starts the asynchronous session and validates the preparing response", async () => {
    const body = {
      sessionId: SESSION_ID,
      status: "preparing",
      expiresAt: EXPIRES_AT,
    };
    const fetchMock = stubJson(body, 202);

    await expect(startCodexDeviceLogin()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/settings/codex/device-login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("polls the exact session path and forwards the AbortSignal", async () => {
    const body = {
      sessionId: SESSION_ID,
      status: "awaiting_authorization",
      expiresAt: EXPIRES_AT,
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    };
    const fetchMock = stubJson(body);
    const controller = new AbortController();

    await expect(
      pollCodexDeviceLogin(SESSION_ID, controller.signal),
    ).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/settings/codex/device-login/${SESSION_ID}`,
      expect.objectContaining({
        signal: controller.signal,
        credentials: "include",
      }),
    );
  });

  it("rejects a valid status body that belongs to another session", async () => {
    stubJson({
      sessionId: OTHER_SESSION_ID,
      status: "preparing",
      expiresAt: EXPIRES_AT,
    });

    await expect(pollCodexDeviceLogin(SESSION_ID)).rejects.toThrow(
      "设备登录会话响应不匹配",
    );
  });

  it("cancels the exact session path with DELETE", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelCodexDeviceLogin(SESSION_ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/settings/codex/device-login/${SESSION_ID}`,
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
      }),
    );
  });
});
