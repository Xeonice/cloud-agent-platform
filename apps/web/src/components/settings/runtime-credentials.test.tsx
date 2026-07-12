import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClaudeCredential, CodexCredential } from "@cap/contracts";
import {
  parseCredentialIssue,
  parseCredentialRuntime,
  RuntimeCredentialTabs,
} from "./runtime-credentials";

const CODEX: CodexCredential = {
  mode: "official",
  state: "connected",
  hasApiKey: false,
};

const CLAUDE: ClaudeCredential = {
  mode: "subscription",
  state: "connected",
  hasSetupToken: true,
  hasApiKey: false,
};

describe("runtime credential settings deep link", () => {
  it("accepts only supported credentialRuntime search values", () => {
    expect(parseCredentialRuntime("codex")).toBe("codex");
    expect(parseCredentialRuntime("claude-code")).toBe("claude-code");
    expect(parseCredentialRuntime("other")).toBeUndefined();
    expect(parseCredentialRuntime(null)).toBeUndefined();
    expect(parseCredentialIssue("runtime_auth_expired")).toBe(
      "runtime_auth_expired",
    );
    expect(parseCredentialIssue("runtime_auth_rejected")).toBe(
      "runtime_auth_rejected",
    );
    expect(parseCredentialIssue("other")).toBeUndefined();
  });

  it("opens the Claude Code tab when selected by the settings deep link", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs
        codexCred={CODEX}
        claudeCred={CLAUDE}
        defaultRuntime="claude-code"
        onConfigureCodex={() => undefined}
        onConfigureClaude={() => undefined}
      />,
    );

    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Claude 订阅（setup-token）");
    expect(html).toContain("Anthropic API Key");
    expect(html).not.toContain("官方 Codex 账号");
  });

  it("keeps Codex as the default without a deep-link selection", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs
        codexCred={CODEX}
        claudeCred={CLAUDE}
        onConfigureCodex={() => undefined}
        onConfigureClaude={() => undefined}
      />,
    );

    expect(html).toContain("官方 Codex 账号");
    expect(html).toContain("兼容模型提供方");
    expect(html).not.toContain("Claude 订阅（setup-token）");
  });

  it("does not present a deep-linked expired Claude credential as healthy", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs
        codexCred={CODEX}
        claudeCred={CLAUDE}
        defaultRuntime="claude-code"
        credentialIssue="runtime_auth_expired"
        onConfigureCodex={() => undefined}
        onConfigureClaude={() => undefined}
      />,
    );

    expect(html).toContain("需更新");
    expect(html).toContain("Claude Code 任务检测到凭据已过期");
    expect(html).toContain("重新保存对应凭据");
  });
});
