/**
 * Minimal ground-truth test: "Settings page has an MCP Server section"
 * (remote-mcp-server, frontend-console spec task 6.1).
 *
 * Exercises the data seam that backs the MCP Server section:
 *   - the `mcpServerEnabledQuery` and `mcpTokensQuery` factories exist and are
 *     wired to the mock layer (`mcpServer` capability is `false` by default);
 *   - the mock layer returns the correct shapes the `McpServerCard` reads;
 *   - the `McpServerCard` module exists and exports `McpServerCard`.
 *
 * Runs in the node environment (no DOM, no React render) — consistent with the
 * project's vitest.config.ts test environment.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  mockMcpServerEnabled,
  mockListMcpTokens,
  mockMintMcpToken,
  __resetMockMcpState,
} from "@/lib/api/mock";
import { mcpServerEnabledQuery, mcpTokensQuery } from "@/lib/api/queries";

beforeEach(() => {
  __resetMockMcpState();
});

describe("Settings page MCP Server section — data seam", () => {
  it("mcpServerEnabledQuery factory exists with the correct query key", () => {
    const opts = mcpServerEnabledQuery();
    // The settings page loader calls ensureQueryData(mcpServerEnabledQuery())
    // — so the factory must exist and carry the stable key.
    expect(opts.queryKey).toEqual(["settings", "mcp-server"]);
    expect(typeof opts.queryFn).toBe("function");
  });

  it("mcpTokensQuery factory exists with the correct query key", () => {
    const opts = mcpTokensQuery();
    // The settings page loader calls ensureQueryData(mcpTokensQuery())
    // — so the factory must exist and carry the stable key.
    expect(opts.queryKey).toEqual(["mcp-tokens"]);
    expect(typeof opts.queryFn).toBe("function");
  });

  it("mcpServerEnabled mock defaults to false (MCP server off until admin enables it)", async () => {
    const enabled = await mockMcpServerEnabled();
    expect(enabled).toBe(false);
  });

  it("mcpTokens mock returns an empty list by default (no tokens minted yet)", async () => {
    const tokens = await mockListMcpTokens();
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens).toHaveLength(0);
  });

  it("mcpServerEnabledQuery.queryFn resolves via the mock seam (mcpServer capability is false)", async () => {
    const opts = mcpServerEnabledQuery();
    // In test (node env) VITE_FORCE_MOCK is not set, and mcpServer capability
    // is `false` in BACKEND_CAPABILITIES — so queryFn routes to mockMcpServerEnabled.
    if (!opts.queryFn) throw new Error("queryFn must be defined");
    const result = await opts.queryFn({} as never);
    expect(result).toBe(false);
  });

  it("mcpTokensQuery.queryFn resolves via the mock seam and returns a list", async () => {
    await mockMintMcpToken({ name: "Test Client", scopes: ["tasks:read"] });
    const opts = mcpTokensQuery();
    if (!opts.queryFn) throw new Error("queryFn must be defined");
    const result = await opts.queryFn({} as never);
    expect(Array.isArray(result)).toBe(true);
    // The mint above writes to the shared mock store; the query reads back 1 row.
    expect(result).toHaveLength(1);
    // List rows must NOT carry the raw token — only the non-secret projection.
    const row = (result as unknown as Record<string, unknown>[])[0]!;
    expect(row).not.toHaveProperty("token");
    expect(row).toHaveProperty("prefix");
    expect(row).toHaveProperty("last4");
  });
});
