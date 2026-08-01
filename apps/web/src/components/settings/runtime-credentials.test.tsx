import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_IDS,
  RUNTIME_METADATA,
  type AgentRuntimeId,
} from "@cap-console/contracts";
import {
  parseCredentialIssue,
  parseCredentialRuntime,
  RuntimeCredentialTabs,
  type RuntimeCredentialGroup,
} from "./runtime-credentials";

/**
 * Build the TOTAL per-runtime collection the component requires (one group per
 * contracts-declared runtime), with optional per-runtime overrides. Built by
 * mapping the declaration so a newly declared runtime is covered here with zero
 * test edits.
 */
function credentialGroups(
  overrides: Partial<Record<AgentRuntimeId, Partial<RuntimeCredentialGroup>>> = {},
): Record<AgentRuntimeId, RuntimeCredentialGroup> {
  return Object.fromEntries(
    AGENT_RUNTIME_IDS.map((id) => [
      id,
      {
        state: "connected",
        onConfigure: () => undefined,
        ...overrides[id],
      } satisfies RuntimeCredentialGroup,
    ]),
  ) as Record<AgentRuntimeId, RuntimeCredentialGroup>;
}

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
        runtimes={credentialGroups()}
        defaultRuntime="claude-code"
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
      <RuntimeCredentialTabs runtimes={credentialGroups()} />,
    );

    expect(html).toContain("官方 Codex 账号");
    expect(html).toContain("兼容模型提供方");
    expect(html).not.toContain("Claude 订阅（setup-token）");
  });

  it("does not present a deep-linked expired Claude credential as healthy", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs
        runtimes={credentialGroups()}
        defaultRuntime="claude-code"
        credentialIssue="runtime_auth_expired"
      />,
    );

    expect(html).toContain("需更新");
    expect(html).toContain("Claude Code 任务检测到凭据已过期");
    expect(html).toContain("重新保存对应凭据");
  });

  it("renders one tab per declared runtime, labeled from its metadata row", () => {
    // Collection-driven (unlock-extension-axes): the tab strip maps the
    // contracts declaration, so every declared runtime's metadata label must
    // appear — with zero edits here when a runtime is added.
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs runtimes={credentialGroups()} />,
    );
    for (const id of AGENT_RUNTIME_IDS) {
      expect(html).toContain(RUNTIME_METADATA[id].label);
    }
    const tabCount = (html.match(/role="tab"/g) ?? []).length;
    expect(tabCount).toBe(AGENT_RUNTIME_IDS.length);
  });

  it("shows each runtime's own connection state from its collection entry", () => {
    const html = renderToStaticMarkup(
      <RuntimeCredentialTabs
        runtimes={credentialGroups({
          codex: { state: "not_connected" },
        })}
      />,
    );

    // codex not connected, the rest connected — both states visible at once.
    expect(html).toContain("未连接");
    expect(html).toContain("已连接");
  });
});
