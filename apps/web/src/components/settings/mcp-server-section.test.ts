/**
 * Minimal ground-truth test: "Settings page has an MCP Server section"
 * (remote-mcp-server, frontend-console spec task 6.1).
 *
 * Exercises the data seam that backs the MCP Server section:
 *   - the `mcpServerEnabledQuery` and `mcpTokensQuery` factories exist and carry
 *     the stable query keys the settings loader prefetches;
 *   - the `mcpServer` capability is now `true` (activated), so each `queryFn`
 *     routes to the REAL api seam — verified here against a stubbed `fetch` so
 *     the routing is proven without a live backend;
 *   - the MOCK layer still returns the correct shapes the `McpServerCard` reads
 *     (the `VITE_FORCE_MOCK` visual-harness posture still exercises it).
 *
 * Runs in the node environment (no DOM, no React render) — consistent with the
 * project's vitest.config.ts test environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mockMcpServerEnabled,
  mockListMcpTokens,
  __resetMockMcpState,
} from "@/lib/api/mock";
import { mcpServerEnabledQuery, mcpTokensQuery } from "@/lib/api/queries";

beforeEach(() => {
  __resetMockMcpState();
});

afterEach(() => {
  // Restore any `fetch` stub a real-seam test installed.
  vi.unstubAllGlobals();
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

  it("mcpServerEnabledQuery.queryFn routes to the real seam (mcpServer capability is true)", async () => {
    // `mcpServer` is `true` in BACKEND_CAPABILITIES (activated), so the queryFn
    // routes to the REAL api. Stub `fetch` with the `/settings/mcp-server` shape
    // so the seam resolves without a live backend, and assert it hit the real
    // endpoint (not the mock).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mcpServerEnabled: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const opts = mcpServerEnabledQuery();
    if (!opts.queryFn) throw new Error("queryFn must be defined");
    const result = await opts.queryFn({} as never);
    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/settings/mcp-server");
  });

  it("mcpTokensQuery.queryFn routes to the real seam and returns the parsed list", async () => {
    // Stub the `/mcp-tokens` response with a single non-secret row (the shape
    // the real api returns — never a raw token).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "mcp-1",
          name: "Cursor",
          scopes: [
            "tasks:read",
            "tasks:diagnostics",
            "admin:all",
            "tasks:diagnostics",
          ],
          prefix: "mcp_",
          last4: "ab12",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const opts = mcpTokensQuery();
    if (!opts.queryFn) throw new Error("queryFn must be defined");
    const result = await opts.queryFn({} as never);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/mcp-tokens");
    // List rows carry only the non-secret projection — never the raw token.
    const row = (result as unknown as Record<string, unknown>[])[0]!;
    expect(row).not.toHaveProperty("token");
    expect(row).toHaveProperty("prefix");
    expect(row).toHaveProperty("last4");
    expect(row.scopes).toEqual(["tasks:read", "tasks:diagnostics"]);
    expect(JSON.stringify(row)).not.toContain("admin:all");
  });
});
