/**
 * Client-side open-redirect guard test (auth-redirects-and-landing). Mirrors the
 * backend guard's contract so a tampered `?redirect=` can never bounce the
 * operator off-origin on the client either. Pure, node-env.
 */
import { describe, it, expect } from "vitest";

import { safeRelativePath } from "./safe-redirect";

describe("safeRelativePath", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeRelativePath("/dashboard")).toBe("/dashboard");
    expect(safeRelativePath("/tasks/abc")).toBe("/tasks/abc");
    expect(safeRelativePath("/tasks/abc?tab=logs")).toBe("/tasks/abc?tab=logs");
    expect(safeRelativePath("  /settings  ")).toBe("/settings");
  });

  it("rejects off-origin / unsafe values → null", () => {
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "http://x",
      "javascript:alert(1)",
      "/\\evil",
      "\\\\evil",
      "/a\\b",
      "/next?u=http://evil",
      "dashboard",
      "",
      "   ",
      undefined,
      null,
    ]) {
      expect(safeRelativePath(bad as string | undefined | null)).toBeNull();
    }
  });

  it("rejects an over-length path", () => {
    expect(safeRelativePath("/" + "x".repeat(600))).toBeNull();
  });
});
