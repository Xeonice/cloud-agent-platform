import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LOCAL_REPO_IMPORT_ROOT_ENV, type Repo } from "@cap/contracts";

import { ImportedReposPanel } from "./imported-repos-panel";

function repo(patch: Partial<Repo> = {}): Repo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "repo",
    gitSource: "https://github.com/team/repo.git",
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    forge: "github",
    defaultBranch: "main",
    ...patch,
  };
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("ImportedReposPanel — content-copy state (add-repo-content-store)", () => {
  it("renders no copy badge or refresh action for an api that reports no copy state", () => {
    const html = render(
      <ImportedReposPanel
        repos={[repo()]}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
        onRefreshCopy={() => undefined}
      />,
    );

    expect(html).not.toContain("data-repo-copy-status");
    expect(html).not.toContain("data-refresh-copy-repo-id");
    // The pre-existing default-branch refresh is untouched.
    expect(html).toContain("刷新分支");
  });

  it("badges each reported status with its last-good copy time and offers refresh", () => {
    const html = render(
      <ImportedReposPanel
        repos={[
          repo({ id: "11111111-1111-4111-8111-111111111111", copyStatus: "ready", copyUpdatedAt: new Date(2026, 6, 3, 9, 5) }),
          repo({ id: "22222222-2222-4222-8222-222222222222", copyStatus: "missing", copyUpdatedAt: null }),
          repo({ id: "33333333-3333-4333-8333-333333333333", copyStatus: "failed", copyUpdatedAt: new Date(2026, 0, 2, 3, 4) }),
        ]}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
        onRefreshCopy={() => undefined}
      />,
    );

    expect(html).toContain("副本就绪");
    expect(html).toContain("副本待建立");
    expect(html).toContain("副本失败");
    expect(html).toContain("副本更新于 2026-07-03 09:05");
    expect(html).toContain("副本尚未建立");
    // A failed REFRESH keeps its previous copy on disk — its time stays visible.
    expect(html).toContain("副本更新于 2026-01-02 03:04");
    expect(html.match(/data-refresh-copy-repo-id=/g)).toHaveLength(3);
  });

  it("shows the in-flight copy state and fences every other copy action", () => {
    const repos = [
      repo({ id: "11111111-1111-4111-8111-111111111111", copyStatus: "missing" }),
      repo({ id: "22222222-2222-4222-8222-222222222222", copyStatus: "ready" }),
    ];
    const html = render(
      <ImportedReposPanel
        repos={repos}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
        onRefreshCopy={() => undefined}
        refreshingCopyRepoId={repos[0]!.id}
      />,
    );

    expect(html).toContain("副本刷新中…");
    // Both rows' copy buttons are disabled while one acquisition is in flight.
    expect(html.match(/副本刷新中…|刷新副本/g)).toHaveLength(2);
  });

  it("does not offer forge PR/MR delivery for a locally imported repo", () => {
    const html = render(
      <ImportedReposPanel
        repos={[repo({ gitSource: "/srv/repos/local-repo", forge: null, copyStatus: "ready" })]}
        onSetDefault={() => undefined}
        onRefreshDefaultBranch={() => undefined}
        onRefreshCopy={() => undefined}
      />,
    );

    expect(html).toContain("本地路径");
    expect(html).toContain("不提供 PR / MR 回写");
    expect(html).not.toContain("GitHub PAT");
  });
});

describe("import dialog — local-path mode (local-repo-import)", () => {
  const source = readFileSync(
    new URL("./import-dialog.tsx", import.meta.url),
    "utf8",
  );

  it("probes availability and never fabricates an allowlist root", () => {
    expect(source).toContain("localRepoImportAvailabilityQuery()");
    expect(source).toContain("localAvailability.data?.enabled === true");
    expect(source).toContain("localAvailability.data?.root ?? null");
  });

  it("offers the mode only when enabled, and names the enabling config otherwise", () => {
    expect(source).toContain("localAvailability.isSuccess ?");
    expect(source).toContain("disabled={!localEnabled}");
    expect(source).toContain("data-local-import-disabled");
    expect(source).toContain("LOCAL_REPO_IMPORT_ROOT_ENV");
  });

  it("classifies local-import failures from their stable code, not raw prose", () => {
    const handler = source.slice(
      source.indexOf("function handleImportLocal()"),
      source.indexOf("// Distinguish the failure modes"),
    );
    expect(handler).toContain("repoImportFailurePresentation(error)");
    expect(handler).not.toContain("error.message");
    expect(source).toContain("data-repo-import-failure={localFailure.code}");
  });

  it("renders an explicit pending state that admits the clone can take minutes", () => {
    expect(source).toContain("正在导入");
    expect(source).toContain("大仓库可能需要数分钟");
  });

  it("names the env var the api itself reports (no console-side string drift)", () => {
    expect(LOCAL_REPO_IMPORT_ROOT_ENV).toBe("CAP_LOCAL_IMPORT_ROOT");
  });
});

describe("both task-create surfaces gate on copy readiness", () => {
  const surfaces = [
    new URL("../dashboard/new-task-dialog.tsx", import.meta.url),
    new URL("../../routes/_app/tasks/new.tsx", import.meta.url),
  ];

  for (const surface of surfaces) {
    it(`${surface.pathname} blocks submit and points at the refresh action`, () => {
      const source = readFileSync(surface, "utf8");

      expect(source).toContain("repoCopyBlockingStatus(selectedRepo)");
      expect(source).toContain("if (copyBlocksImmediateRun) return;");
      expect(source).toContain("copyBlocksImmediateRun\n");
      expect(source).toContain("data-repo-copy-blocked");
      expect(source).toContain("前往仓库范围刷新副本");
      // The 409 the api answers when the create raced the copy state.
      expect(source).toContain("taskRepoCopyNotReadyFromApiError(mutation.error)");
      // A schedule is NOT gated on today's copy state — it dispatches later.
      expect(source).toContain('mode === "once"');
    });
  }
});
