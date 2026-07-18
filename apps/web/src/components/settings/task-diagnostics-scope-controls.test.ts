import { ScopeSchema } from "@cap/contracts";
import { describe, expect, it } from "vitest";

import {
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES,
} from "./api-keys-card";
import {
  DEFAULT_MCP_TOKEN_SCOPES,
  MCP_TOKEN_SCOPE_OPTIONS,
} from "./mcp-server-card";

describe("tasks:diagnostics settings permission controls", () => {
  it("uses the shared grantable scope vocabulary", () => {
    expect(ScopeSchema.parse("tasks:diagnostics")).toBe("tasks:diagnostics");
  });

  it("offers API-key diagnostics as a separate warned opt-in", () => {
    const option = API_KEY_SCOPES.find(
      ({ value }) => value === "tasks:diagnostics",
    );

    expect(option?.warning).toMatch(/深入|受信任/);
    expect(DEFAULT_API_KEY_SCOPES).toEqual(["tasks:read"]);
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("tasks:diagnostics");
    expect(DEFAULT_API_KEY_SCOPES).not.toContain("tasks:write");
  });

  it("offers MCP diagnostics as a separate warned opt-in", () => {
    const option = MCP_TOKEN_SCOPE_OPTIONS.find(
      ({ scope }) => scope === "tasks:diagnostics",
    );

    expect(option?.warning).toMatch(/深入|受信任/);
    expect(DEFAULT_MCP_TOKEN_SCOPES).toEqual(["tasks:read", "repos:read"]);
    expect(DEFAULT_MCP_TOKEN_SCOPES).not.toContain("tasks:diagnostics");
    expect(DEFAULT_MCP_TOKEN_SCOPES).not.toContain("tasks:write");
  });

  it("does not derive diagnostics from ordinary read/write selections", () => {
    for (const ordinarySelection of [
      ["tasks:read"],
      ["tasks:write"],
      ["tasks:read", "tasks:write"],
    ] as const) {
      expect(ordinarySelection).not.toContain("tasks:diagnostics");
    }
  });
});
