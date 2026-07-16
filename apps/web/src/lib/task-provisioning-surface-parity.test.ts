import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const surfaces = [
  new URL("../routes/_app/tasks/$taskId.tsx", import.meta.url),
  new URL("../routes/_app/tasks/$taskId_.transcript.tsx", import.meta.url),
];

describe("task provisioning surface parity", () => {
  for (const surface of surfaces) {
    it(`${surface.pathname} renders canonical progress and branch`, () => {
      const source = readFileSync(surface, "utf8");

      expect(source).toContain("<TaskProvisioningStatus");
      expect(source).toContain("taskDisplayBranch(task)");
      expect(source).not.toMatch(/task\?\.branch\s*\?\?.*main/);
      expect(source).not.toMatch(/context\?\.branch\s*\?\?.*main/);
    });
  }

  it("real task context never restores a mock branch for null caller intent", () => {
    const source = readFileSync(
      new URL("api/queries.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'task.provisioning?.resolvedBranch ?? task.branch ?? "待解析"',
    );
    expect(source).not.toContain("branch: task.branch ?? ctx.branch");
  });

  it("the missing-ref recovery destination keeps null repo branches unresolved", () => {
    const repositorySources = [
      new URL("../routes/_app/repositories.tsx", import.meta.url),
      new URL(
        "../components/repositories/imported-repos-panel.tsx",
        import.meta.url,
      ),
    ].map((surface) => readFileSync(surface, "utf8"));

    for (const source of repositorySources) {
      expect(source).not.toMatch(/defaultBranch\s*\?\?\s*["']main["']/);
    }
    expect(repositorySources.join("\n")).toContain("待解析");
    expect(repositorySources.join("\n")).toContain("默认分支尚未解析");
  });
});
