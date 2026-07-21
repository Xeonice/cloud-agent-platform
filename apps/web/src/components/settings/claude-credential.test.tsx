import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ClaudeCredentialRejectedErrorSchema,
  ClaudeCredentialSchema,
} from "@cap/contracts";
import { ClaudeCredentialNoticeAlert } from "./claude-credential";
import {
  ApiError,
  claudeCredentialRejectionFromApiError,
} from "@/lib/api/real";

/**
 * fix-claude-onboarding-and-token-verify Track 4 — the three save outcomes the
 * console must distinguish: verified (dialog closes, nothing special), probe
 * rejection (descriptive error, credential stays disconnected), and
 * network-indeterminate (saved-but-unverified warning).
 */

function dialogMarkup(
  notice: React.ComponentProps<typeof ClaudeCredentialNoticeAlert>["notice"],
): string {
  return renderToStaticMarkup(<ClaudeCredentialNoticeAlert notice={notice} />);
}

describe("ClaudeCredentialDialog save-outcome notice", () => {
  it("renders a probe rejection as an alert with the API's descriptive message", () => {
    const html = dialogMarkup({
      kind: "error",
      text: "Anthropic rejected this setup-token (authentication_error).",
    });
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("Anthropic rejected this setup-token");
  });

  it("renders the indeterminate outcome as a saved-but-unverified warning", () => {
    const html = dialogMarkup({
      kind: "warn",
      text: "凭据已保存，但无法连接 Anthropic 完成验证",
    });
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("凭据已保存，但无法连接 Anthropic 完成验证");
  });

  it("renders no alert when there is no notice (verified path)", () => {
    expect(dialogMarkup(null)).not.toContain("role=\"alert\"");
  });
});

describe("extended contracts for save-time verification", () => {
  it("accepts the save response verification marker and keeps it optional", () => {
    const base = {
      mode: "subscription",
      state: "connected",
      hasSetupToken: true,
      hasApiKey: false,
    };
    expect(ClaudeCredentialSchema.parse(base).verification).toBeUndefined();
    expect(
      ClaudeCredentialSchema.parse({ ...base, verification: "verified" })
        .verification,
    ).toBe("verified");
    expect(
      ClaudeCredentialSchema.parse({ ...base, verification: "indeterminate" })
        .verification,
    ).toBe("indeterminate");
    expect(() =>
      ClaudeCredentialSchema.parse({ ...base, verification: "nope" }),
    ).toThrow();
  });

  it("parses only the canonical rejection body from an ApiError", () => {
    const rejected = new ApiError(400, "Bad Request", {
      error: "claude_credential_rejected",
      message: "Anthropic rejected this setup-token (authentication_error).",
    });
    expect(claudeCredentialRejectionFromApiError(rejected)).toEqual(
      ClaudeCredentialRejectedErrorSchema.parse({
        error: "claude_credential_rejected",
        message: "Anthropic rejected this setup-token (authentication_error).",
      }),
    );
    // Other error bodies and non-ApiError values do not parse.
    expect(
      claudeCredentialRejectionFromApiError(
        new ApiError(400, "Bad Request", { error: "validation_failed" }),
      ),
    ).toBeNull();
    expect(claudeCredentialRejectionFromApiError(new Error("boom"))).toBeNull();
  });
});
