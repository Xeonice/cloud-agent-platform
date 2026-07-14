import * as React from "react";
import type { TaskResponse } from "@cap/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({
      to,
      search,
      hash,
      children,
    }: {
      to: string;
      search?: Record<string, string | undefined>;
      hash?: string;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(
        Object.entries(search ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ).toString();
      const href = `${to}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
      return ReactModule.createElement("a", { href }, children);
    },
  };
});

import {
  RuntimeCredentialAlert,
  runtimeAuthFailurePresentation,
  type RuntimeAuthFailure,
} from "./runtime-credential-alert";

function failure(
  runtime: RuntimeAuthFailure["runtime"],
  code: RuntimeAuthFailure["code"],
): RuntimeAuthFailure {
  return {
    code,
    runtime,
    message: "The stored runtime credential can no longer be used.",
    action: "reconnect_runtime",
    occurredAt: new Date("2026-07-12T08:00:00.000Z"),
    exitCode: 1,
  };
}

describe("RuntimeCredentialAlert", () => {
  it("renders an explicit Codex expiry and links to the Codex credential tab", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialAlert
        failure={failure("codex", "runtime_auth_expired")}
        announce
      />,
    );

    expect(html).toContain("Codex 登录已过期");
    expect(html).toContain("更新 Codex 凭据");
    expect(html).toContain("官方账号");
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'href="/settings?credentialRuntime=codex&amp;credentialIssue=runtime_auth_expired#codex"',
    );
  });

  it("renders Claude Code rejection copy and selects its settings tab", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialAlert
        failure={failure("claude-code", "runtime_auth_rejected")}
      />,
    );

    expect(html).toContain("Claude Code 凭据已失效");
    expect(html).toContain("setup-token");
    expect(html).toContain("更新 Claude Code 凭据");
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(
      'href="/settings?credentialRuntime=claude-code&amp;credentialIssue=runtime_auth_rejected#codex"',
    );
  });

  it("keeps expired and rejected failures distinguishable for both runtimes", () => {
    expect(
      runtimeAuthFailurePresentation(
        failure("claude-code", "runtime_auth_expired"),
      ).title,
    ).toBe("Claude Code 凭据已过期");
    expect(
      runtimeAuthFailurePresentation(
        failure("codex", "runtime_auth_rejected"),
      ).title,
    ).toBe("Codex 登录凭据已失效");
  });

  it("renders nothing without a structured reconnect action", () => {
    expect(renderToStaticMarkup(<RuntimeCredentialAlert failure={null} />)).toBe(
      "",
    );
  });

  it("does not mislabel model setup or rejection failures as credential issues", () => {
    const failures = [
      {
        code: "runtime_model_setup_failed",
        runtime: "codex",
        message: "The selected model could not be prepared.",
        action: "retry_task",
        occurredAt: new Date("2026-07-12T08:00:00.000Z"),
        exitCode: 1,
      },
      {
        code: "runtime_model_rejected",
        runtime: "claude-code",
        message: "The selected model was rejected.",
        action: "choose_another_model",
        occurredAt: new Date("2026-07-12T08:00:00.000Z"),
        exitCode: 1,
      },
    ] satisfies Array<NonNullable<TaskResponse["failure"]>>;

    for (const modelFailure of failures) {
      const html = renderToStaticMarkup(
        <RuntimeCredentialAlert failure={modelFailure} />,
      );
      expect(html).toBe("");
      expect(html).not.toContain("/settings");
    }
  });
});
