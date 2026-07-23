/**
 * add-repo-content-store (verify V.1) — the operator-reachable delete surface.
 *
 * The repo-store's `remove()` was previously unreachable from any console
 * affordance, so the spec scenario "Repo deletion removes the copy" could never
 * fire. These pin the console entry point that closes it: the row action, its
 * fencing, and the page wiring (confirmation + stable-code classification).
 *
 * The suite runs without a DOM, so the row is asserted through static SSR markup
 * and the page's handler wiring through its source — the same convention the
 * sibling repo surfaces already use.
 */
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Repo } from "@cap/contracts";

import { ImportedReposPanel } from "./imported-repos-panel";

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function repo(patch: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
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

function panel(props: Partial<React.ComponentProps<typeof ImportedReposPanel>> = {}) {
  return render(
    <ImportedReposPanel
      repos={[repo()]}
      onSetDefault={() => undefined}
      onRefreshDefaultBranch={() => undefined}
      {...props}
    />,
  );
}

describe("ImportedReposPanel — repo deletion (add-repo-content-store)", () => {
  it("renders no delete affordance when the page does not offer one", () => {
    const html = panel();

    expect(html).not.toContain("data-delete-repo-id");
    expect(html).not.toContain("删除仓库");
  });

  it("offers one delete action per repository, including the default one", () => {
    const html = panel({
      repos: [repo({ isDefault: true }), repo({ id: OTHER_ID, name: "other" })],
      onDelete: () => undefined,
    });

    expect(html).toContain(`data-delete-repo-id="${REPO_ID}"`);
    expect(html).toContain(`data-delete-repo-id="${OTHER_ID}"`);
    expect(html.match(/data-delete-repo-id=/g)).toHaveLength(2);
    // The pre-existing row actions are untouched.
    expect(html).toContain("刷新分支");
  });

  it("shows the in-flight state and fences every other delete", () => {
    const html = panel({
      repos: [repo(), repo({ id: OTHER_ID, name: "other" })],
      onDelete: () => undefined,
      deletingRepoId: REPO_ID,
    });

    expect(html).toContain("删除中…");
    expect(html.match(/删除中…|删除仓库/g)).toHaveLength(2);
    // Both delete buttons are disabled while one deletion is in flight.
    expect(html.match(/data-delete-repo-id="[^"]+" disabled=""/g)).toHaveLength(2);
  });

  it("fences deletion while a copy acquisition is running on any row", () => {
    const html = panel({
      repos: [repo({ copyStatus: "missing" })],
      onDelete: () => undefined,
      onRefreshCopy: () => undefined,
      refreshingCopyRepoId: REPO_ID,
    });

    expect(html).toContain(`data-delete-repo-id="${REPO_ID}" disabled=""`);
  });
});

describe("/repositories wires deletion to a confirmed, code-classified action", () => {
  const source = readFileSync(
    new URL("../../routes/_app/repositories.tsx", import.meta.url),
    "utf8",
  );

  it("uses the shared delete mutation rather than a bespoke request", () => {
    expect(source).toContain("deleteRepoMutation(queryClient)");
    expect(source).toContain("onDelete={handleDelete}");
    expect(source).toContain("deletingRepoId={deletingRepoId}");
  });

  it("confirms before the destructive call and names the copy it removes", () => {
    expect(source).toContain("window.confirm(");
    expect(source).toContain("仓库内容副本");
    // The confirmation must gate the mutation, not follow it.
    const confirmAt = source.indexOf("window.confirm(");
    const mutateAt = source.indexOf("deleteRepo.mutate(");
    expect(confirmAt).toBeGreaterThan(-1);
    expect(mutateAt).toBeGreaterThan(confirmAt);
  });

  it("classifies a refusal from its stable code, never from raw error prose", () => {
    expect(source).toContain("repoImportFailurePresentation(error)");
    expect(source).toContain("claimRepoRefreshSubmission(deleteFence, repoId)");
  });
});
