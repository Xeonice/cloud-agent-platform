/**
 * MCP-token mock-seam tests (remote-mcp-server, web-settings track 6.1).
 *
 * Proves the front-of-seam contract the settings MCP-server card relies on:
 *   - mint returns the raw `mcp_…` token EXACTLY ONCE (the server stand-in's
 *     one-time reply), and the subsequent LIST never carries the raw token or a
 *     hash — only the non-secret prefix + last4 projection;
 *   - revoke is idempotent and keeps the (now-revoked) row in the list with its
 *     `revokedAt` lifecycle marker rather than dropping it;
 *   - the `mcpServerEnabled` flag defaults false and round-trips through the
 *     toggle.
 *
 * These exercise the MOCK layer directly (independent of the `mcpServer`
 * capability flag, now activated to `true`): the mock seam is the
 * `VITE_FORCE_MOCK` visual-harness posture and the legitimate place the raw
 * token is fabricated; the card never client-fabricates it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  mockListMcpTokens,
  mockMintMcpToken,
  mockRevokeMcpToken,
  mockMcpServerEnabled,
  mockSetMcpServerEnabled,
  __resetMockMcpState,
} from "./mock";

beforeEach(() => {
  __resetMockMcpState();
});

describe("mock MCP tokens — show-once + non-leaking list", () => {
  it("mint returns the raw mcp_ token exactly once", async () => {
    const minted = await mockMintMcpToken({
      name: "Cursor",
      scopes: ["tasks:read"],
    });
    expect(minted.token).toMatch(/^mcp_/);
    expect(minted.last4).toBe(minted.token.slice(-4));
    expect(minted.prefix).toBe("mcp_");
    expect(minted.name).toBe("Cursor");
    expect(minted.scopes).toEqual(["tasks:read"]);
    expect(minted.revokedAt).toBeNull();
  });

  it("the list never leaks the raw token or a hash — prefix + last4 only", async () => {
    const minted = await mockMintMcpToken({
      name: "Claude Desktop",
      scopes: ["tasks:read", "repos:read"],
    });
    const list = await mockListMcpTokens();
    expect(list).toHaveLength(1);
    const row = list[0]!;
    // No raw-token / hash field on a list row.
    expect(row).not.toHaveProperty("token");
    expect(row).not.toHaveProperty("tokenHash");
    expect(row).not.toHaveProperty("hash");
    // Only the non-secret projection.
    expect(row.id).toBe(minted.id);
    expect(row.prefix).toBe("mcp_");
    expect(row.last4).toBe(minted.last4);
    // The raw body never appears in the serialized row.
    expect(JSON.stringify(row)).not.toContain(minted.token);
  });

  it("mints distinct tokens (no id/last4 collision across mints)", async () => {
    const a = await mockMintMcpToken({ name: "a", scopes: ["tasks:read"] });
    const b = await mockMintMcpToken({ name: "b", scopes: ["tasks:read"] });
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    const list = await mockListMcpTokens();
    expect(list).toHaveLength(2);
  });
});

describe("mock MCP tokens — idempotent revoke", () => {
  it("revoke sets revokedAt and keeps the row; repeat revoke is a no-op", async () => {
    const minted = await mockMintMcpToken({
      name: "to-revoke",
      scopes: ["tasks:write"],
    });
    await mockRevokeMcpToken(minted.id);
    let list = await mockListMcpTokens();
    expect(list).toHaveLength(1);
    const revokedAt = list[0]!.revokedAt;
    expect(revokedAt).not.toBeNull();

    // Idempotent: a second revoke does not throw and does not move revokedAt.
    await mockRevokeMcpToken(minted.id);
    list = await mockListMcpTokens();
    expect(list[0]!.revokedAt).toBe(revokedAt);
  });

  it("revoking an unknown id is a no-op", async () => {
    await mockMintMcpToken({ name: "keep", scopes: ["tasks:read"] });
    await mockRevokeMcpToken("does-not-exist");
    const list = await mockListMcpTokens();
    expect(list).toHaveLength(1);
    expect(list[0]!.revokedAt).toBeNull();
  });
});

describe("mock MCP server enable flag", () => {
  it("defaults false and round-trips through the toggle", async () => {
    expect(await mockMcpServerEnabled()).toBe(false);
    expect(await mockSetMcpServerEnabled(true)).toBe(true);
    expect(await mockMcpServerEnabled()).toBe(true);
    expect(await mockSetMcpServerEnabled(false)).toBe(false);
    expect(await mockMcpServerEnabled()).toBe(false);
  });
});
