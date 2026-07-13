import * as React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexDeviceLoginStartResponse,
  CodexDeviceLoginStatus,
} from "@cap/contracts";
import {
  adoptStartedDeviceLoginSession,
  CodexDeviceLoginAttemptTracker,
  CodexDeviceLoginStatusContent,
  copyDeviceCode,
  pollCodexDeviceLoginSession,
} from "./codex-direct-dialog";

const SESSION_ID = "00000000-0000-4000-8000-000000000501";
const NEXT_SESSION_ID = "00000000-0000-4000-8000-000000000502";
const EXPIRES_AT = "2026-07-13T09:30:00.000Z";

const PREPARING: CodexDeviceLoginStatus = {
  sessionId: SESSION_ID,
  status: "preparing",
  expiresAt: EXPIRES_AT,
};

const AWAITING: CodexDeviceLoginStatus = {
  sessionId: SESSION_ID,
  status: "awaiting_authorization",
  expiresAt: EXPIRES_AT,
  verificationUri: "https://auth.openai.com/codex/device",
  userCode: "ABCD-1234",
};

function renderStatus(
  options: {
    startPending?: boolean;
    status?: CodexDeviceLoginStatus | null;
    localError?: string;
    copied?: boolean;
    manualCopy?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <CodexDeviceLoginStatusContent
      startPending={options.startPending ?? false}
      status={options.status ?? null}
      localError={options.localError ?? ""}
      copied={options.copied ?? false}
      manualCopy={options.manualCopy ?? false}
      codeRef={React.createRef<HTMLElement>()}
      onCopy={() => undefined}
    />,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Codex device-login status UI", () => {
  it("renders preparation locally before and after the POST response", () => {
    expect(renderStatus({ startPending: true })).toContain("正在准备设备码");
    const preparing = renderStatus({ status: PREPARING });
    expect(preparing).toContain("正在准备设备码");
    expect(preparing).toContain("此阶段无需打开新页面");
    expect(preparing).not.toContain("复制设备码");
  });

  it("renders the exact code and an opener-safe, no-referrer authorization link", () => {
    const html = renderStatus({ status: AWAITING });

    expect(html).toContain("ABCD-1234");
    expect(html).toContain("https://auth.openai.com/codex/device");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("前往 OpenAI 授权");
    expect(html).toContain("复制设备码");
  });

  it.each<[CodexDeviceLoginStatus, string]>([
    [
      {
        sessionId: SESSION_ID,
        status: "finalizing",
        expiresAt: EXPIRES_AT,
      },
      "正在验证并加密保存登录态",
    ],
    [
      {
        sessionId: SESSION_ID,
        status: "connected",
        expiresAt: EXPIRES_AT,
      },
      "已连接官方账号",
    ],
    [
      {
        sessionId: SESSION_ID,
        status: "cancelled",
        expiresAt: EXPIRES_AT,
      },
      "本次登录已取消",
    ],
    [
      {
        sessionId: SESSION_ID,
        status: "expired",
        expiresAt: EXPIRES_AT,
        message: "CAP 登录会话已过期。",
      },
      "CAP 登录会话已过期",
    ],
    [
      {
        sessionId: SESSION_ID,
        status: "error",
        expiresAt: EXPIRES_AT,
        message: "登录进程暂不可用。",
      },
      "登录进程暂不可用",
    ],
  ])("renders the %s server state", (status, copy) => {
    expect(renderStatus({ status })).toContain(copy);
  });

  it("shows copied confirmation and explicit manual-copy guidance", () => {
    expect(renderStatus({ status: AWAITING, copied: true })).toContain(
      "已复制",
    );
    const manual = renderStatus({ status: AWAITING, manualCopy: true });
    expect(manual).toContain("设备码已选中");
    expect(manual).toContain("Ctrl+C / Command+C");
  });

  it("renders local start errors as retryable visible failures", () => {
    expect(renderStatus({ localError: "无法连接到 CAP API。" })).toContain(
      "无法连接到 CAP API",
    );
  });

  it("contains no eager popup or about:blank production path", () => {
    const source = readFileSync(
      new URL("./codex-direct-dialog.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("window.open");
    expect(source).not.toContain("about:blank");
  });
});

describe("Codex device-login attempt guard", () => {
  it("returns the exact known session on close and rejects all later updates", () => {
    const tracker = new CodexDeviceLoginAttemptTracker();
    const generation = tracker.begin();
    expect(tracker.adopt(generation, SESSION_ID)).toBe(true);
    expect(tracker.isCurrent(generation, SESSION_ID)).toBe(true);

    expect(tracker.invalidate()).toBe(SESSION_ID);
    expect(tracker.isCurrent(generation, SESSION_ID)).toBe(false);
  });

  it("cancels the exact session when POST resolves after close-during-start", () => {
    const tracker = new CodexDeviceLoginAttemptTracker();
    const generation = tracker.begin();
    tracker.invalidate();
    const cancel = vi.fn<(sessionId: string) => void>();
    const started: CodexDeviceLoginStartResponse = {
      sessionId: SESSION_ID,
      status: "preparing",
      expiresAt: EXPIRES_AT,
    };

    expect(
      adoptStartedDeviceLoginSession(
        tracker,
        generation,
        started,
        cancel,
      ),
    ).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });

  it("lets a retry own a new generation while rejecting the previous session", () => {
    const tracker = new CodexDeviceLoginAttemptTracker();
    const first = tracker.begin();
    tracker.adopt(first, SESSION_ID);
    tracker.finish(first, SESSION_ID);

    const retry = tracker.begin();
    expect(tracker.adopt(retry, NEXT_SESSION_ID)).toBe(true);
    expect(tracker.isCurrent(first, SESSION_ID)).toBe(false);
    expect(tracker.isCurrent(retry, NEXT_SESSION_ID)).toBe(true);
  });
});

describe("serialized Codex device-login polling", () => {
  it("never overlaps GETs and stops after a terminal response", async () => {
    const firstResponse = deferred<CodexDeviceLoginStatus>();
    const secondResponse = deferred<CodexDeviceLoginStatus>();
    const delay = deferred<void>();
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let call = 0;
    const poll = vi.fn(async () => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      const pending = call++ === 0 ? firstResponse.promise : secondResponse.promise;
      const result = await pending;
      activeRequests -= 1;
      return result;
    });
    const wait = vi.fn(() => delay.promise);
    const statuses: string[] = [];
    const controller = new AbortController();

    const polling = pollCodexDeviceLoginSession({
      sessionId: SESSION_ID,
      signal: controller.signal,
      poll,
      wait,
      onStatus: (status) => statuses.push(status.status),
    });
    await flushPromises();
    expect(poll).toHaveBeenCalledTimes(1);

    firstResponse.resolve(PREPARING);
    await flushPromises();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);

    delay.resolve();
    await flushPromises();
    expect(poll).toHaveBeenCalledTimes(2);

    secondResponse.resolve({
      sessionId: SESSION_ID,
      status: "connected",
      expiresAt: EXPIRES_AT,
    });
    await polling;

    expect(maximumActiveRequests).toBe(1);
    expect(statuses).toEqual(["preparing", "connected"]);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight GET without publishing a stale status", async () => {
    const controller = new AbortController();
    const onStatus = vi.fn();
    const poll = vi.fn(
      (_sessionId: string, signal: AbortSignal) =>
        new Promise<CodexDeviceLoginStatus>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );

    const polling = pollCodexDeviceLoginSession({
      sessionId: SESSION_ID,
      signal: controller.signal,
      poll,
      onStatus,
    });
    await flushPromises();
    controller.abort();
    await polling;

    expect(poll).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it.each<CodexDeviceLoginStatus>([
    {
      sessionId: SESSION_ID,
      status: "connected",
      expiresAt: EXPIRES_AT,
    },
    {
      sessionId: SESSION_ID,
      status: "cancelled",
      expiresAt: EXPIRES_AT,
    },
    {
      sessionId: SESSION_ID,
      status: "expired",
      expiresAt: EXPIRES_AT,
      message: "expired",
    },
    {
      sessionId: SESSION_ID,
      status: "error",
      expiresAt: EXPIRES_AT,
      message: "error",
    },
  ])("does not schedule another GET after terminal status %s", async (status) => {
    const poll = vi.fn(async () => status);
    const wait = vi.fn(async () => undefined);

    await pollCodexDeviceLoginSession({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      poll,
      wait,
      onStatus: () => undefined,
    });

    expect(poll).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("device-code copy integration", () => {
  it.each(["clipboard", "compatibility"] as const)(
    "treats a positive %s result as copied",
    async (method) => {
      await expect(
        copyDeviceCode("ABCD-1234", null, async () => ({ ok: true, method })),
      ).resolves.toBe("copied");
    },
  );

  it("focuses and selects the visible code after total programmatic failure", async () => {
    const focus = vi.fn();
    const selectNodeContents = vi.fn();
    const removeAllRanges = vi.fn();
    const addRange = vi.fn();
    const range = { selectNodeContents };
    const element = {
      focus,
      ownerDocument: {
        createRange: vi.fn(() => range),
        defaultView: {
          getSelection: vi.fn(() => ({ removeAllRanges, addRange })),
        },
      },
    } as unknown as HTMLElement;

    await expect(
      copyDeviceCode("ABCD-1234", element, async () => ({
        ok: false,
        reason: "copy_failed",
      })),
    ).resolves.toBe("manual");

    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(selectNodeContents).toHaveBeenCalledExactlyOnceWith(element);
    expect(removeAllRanges).toHaveBeenCalledOnce();
    expect(addRange).toHaveBeenCalledExactlyOnceWith(range);
  });
});
