import {
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
  type CodexDeviceLoginSessionId,
  type CodexDeviceLoginStartResponse,
  type CodexDeviceLoginStatus,
} from "@cap/contracts";

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

export async function startCodexDeviceLogin(): Promise<CodexDeviceLoginStartResponse> {
  return CodexDeviceLoginStartResponseSchema.parse(
    await request("/settings/codex/device-login", { method: "POST" }),
  );
}

export async function pollCodexDeviceLogin(
  sessionId: CodexDeviceLoginSessionId,
  signal?: AbortSignal,
): Promise<CodexDeviceLoginStatus> {
  const status = CodexDeviceLoginStatusSchema.parse(
    await request(
      `/settings/codex/device-login/${encodeURIComponent(sessionId)}`,
      { signal },
    ),
  );
  if (status.sessionId !== sessionId) {
    throw new Error("设备登录会话响应不匹配，请重试。");
  }
  return status;
}

export async function cancelCodexDeviceLogin(
  sessionId: CodexDeviceLoginSessionId,
): Promise<void> {
  await request(
    `/settings/codex/device-login/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}
