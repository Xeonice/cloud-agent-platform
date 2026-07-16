import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCES = [
  new URL("api/real.ts", import.meta.url),
  new URL("api/mutations.ts", import.meta.url),
  new URL("../components/repositories/import-dialog.tsx", import.meta.url),
  new URL(
    "../components/repositories/imported-repos-panel.tsx",
    import.meta.url,
  ),
  new URL("../routes/_app/repositories.tsx", import.meta.url),
  new URL("../routes/_app/dashboard.tsx", import.meta.url),
  new URL("../components/dashboard/new-task-dialog.tsx", import.meta.url),
  new URL("../routes/_app/tasks/new.tsx", import.meta.url),
] as const;

describe("Console verified repository default-branch policy", () => {
  it("keeps repository refresh and both task-create surfaces on the shared repos cache", () => {
    const mutation = readFileSync(SOURCES[1], "utf8");
    const dashboard = readFileSync(SOURCES[5], "utf8");
    const fullPage = readFileSync(SOURCES[7], "utf8");

    expect(mutation).toContain("replaceRefreshedRepo(current, repo)");
    expect(mutation).toContain("queryKey: queryKeys.repos");
    expect(dashboard).toContain("useQuery(reposQuery())");
    expect(dashboard).toContain("repos={repoList}");
    expect(fullPage).toContain("useQuery(reposQuery())");
    expect(fullPage).toContain(
      "taskBranchFormValue(selectedRepo?.defaultBranch)",
    );
  });

  it("contains no client-side main/master fallback in refresh or task branch planning", () => {
    const conventionalFallback =
      /(?:defaultBranch|branch)\s*(?:\?\?|\|\|)\s*["'](?:main|master)["']/;

    for (const sourceUrl of SOURCES) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source, sourceUrl.pathname).not.toMatch(conventionalFallback);
    }
  });
});
