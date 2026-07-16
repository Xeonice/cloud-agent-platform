import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Repo } from "@cap/contracts";

import { ImportedReposPanel } from "./imported-repos-panel";

function repo(
  id: string,
  forge: "github" | "gitlab" | "gitee",
  defaultBranch: string,
  isDefault = false,
): Repo {
  return {
    id,
    name: `${forge}-repo`,
    gitSource: `https://${forge}.example/team/${forge}-repo.git`,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    forge,
    defaultBranch,
    isDefault,
  };
}

describe("ImportedReposPanel branch refresh controls", () => {
  const repos = [
    repo("11111111-1111-4111-8111-111111111111", "github", "trunk", true),
    repo("22222222-2222-4222-8222-222222222222", "gitlab", "develop"),
    repo("33333333-3333-4333-8333-333333333333", "gitee", "master"),
  ];

  it("offers refresh for every imported provider and preserves their verified labels", () => {
    const html = renderToStaticMarkup(
      <ImportedReposPanel
        repos={repos}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
      />,
    );

    expect(html.match(/data-refresh-repo-id=/g)).toHaveLength(3);
    expect(html.match(/刷新分支/g)).toHaveLength(3);
    expect(html).toContain("trunk");
    expect(html).toContain("develop");
    expect(html).toContain("master");
  });

  it("disables every refresh affordance while one exact Repo is pending", () => {
    const html = renderToStaticMarkup(
      <ImportedReposPanel
        repos={repos}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
        refreshingRepoId={repos[1]!.id}
      />,
    );

    expect(html).toContain("刷新中…");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
