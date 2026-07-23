import { describe, expect, it } from "vitest";

import { RepoSchema, type Repo } from "@cap/contracts";

import {
  REPO_COPY_STATUS_PRESENTATION,
  formatRepoCopyUpdatedAt,
  repoCopyBlockedGuidance,
  repoCopyBlockingStatus,
  repoCopyBlocksTaskCreate,
  repoCopyStatus,
  repoCopyUpdatedCaption,
} from "./repo-copy-status";

function repo(patch: Partial<Repo> = {}): Repo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "repo",
    gitSource: "https://github.com/team/repo.git",
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    ...patch,
  };
}

describe("repoCopyStatus — absent is not `missing`", () => {
  it("reports null for a payload produced before the content store existed", () => {
    // The contract keeps copyStatus optional so an older api payload still parses.
    const legacy = RepoSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "repo",
      gitSource: "https://github.com/team/repo.git",
      createdAt: "2026-07-16T00:00:00.000Z",
    });

    expect(legacy.copyStatus).toBeUndefined();
    expect(repoCopyStatus(legacy)).toBeNull();
    // An api with no copy gate must never have its task creation blocked by us.
    expect(repoCopyBlocksTaskCreate(legacy)).toBe(false);
    expect(repoCopyBlockingStatus(legacy)).toBeNull();
  });

  it("reports the reported status verbatim once the api sends one", () => {
    expect(repoCopyStatus(repo({ copyStatus: "missing" }))).toBe("missing");
    expect(repoCopyStatus(repo({ copyStatus: "ready" }))).toBe("ready");
  });
});

describe("copy readiness gates task creation", () => {
  it("lets only `ready` through", () => {
    expect(repoCopyBlocksTaskCreate(repo({ copyStatus: "ready" }))).toBe(false);
    expect(repoCopyBlockingStatus(repo({ copyStatus: "ready" }))).toBeNull();

    for (const status of ["missing", "refreshing", "failed"] as const) {
      expect(repoCopyBlocksTaskCreate(repo({ copyStatus: status }))).toBe(true);
      expect(repoCopyBlockingStatus(repo({ copyStatus: status }))).toBe(status);
    }
  });

  it("points every blocked state at the one console action that unblocks it", () => {
    for (const status of ["missing", "failed", "unknown"] as const) {
      expect(repoCopyBlockedGuidance(status)).toContain("刷新副本");
    }
    // `refreshing` is already the remedy running — it asks the operator to wait
    // rather than to press the button again.
    expect(repoCopyBlockedGuidance("refreshing")).toContain("正在刷新");
    expect(repoCopyBlockedGuidance("refreshing")).not.toContain("点击「刷新副本」");
  });

  it("has a distinct badge for every contract status", () => {
    const labels = Object.values(REPO_COPY_STATUS_PRESENTATION).map(
      (p) => p.label,
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(REPO_COPY_STATUS_PRESENTATION).sort()).toEqual([
      "failed",
      "missing",
      "ready",
      "refreshing",
    ]);
  });
});

describe("copy timestamp copy", () => {
  it("never fabricates a time when no copy has completed", () => {
    expect(formatRepoCopyUpdatedAt(null)).toBeNull();
    expect(formatRepoCopyUpdatedAt(undefined)).toBeNull();
    expect(formatRepoCopyUpdatedAt(new Date("not-a-date"))).toBeNull();
    expect(repoCopyUpdatedCaption(repo({ copyStatus: "missing" }))).toBe(
      "副本尚未建立",
    );
  });

  it("formats a completed copy time as a fixed, zero-padded local string", () => {
    const at = new Date(2026, 6, 3, 9, 5);
    expect(formatRepoCopyUpdatedAt(at)).toBe("2026-07-03 09:05");
    expect(
      repoCopyUpdatedCaption(repo({ copyStatus: "ready", copyUpdatedAt: at })),
    ).toBe("副本更新于 2026-07-03 09:05");
  });

  it("keeps the last-good timestamp visible for a FAILED refresh", () => {
    const lastGood = new Date(2026, 0, 2, 3, 4);
    expect(
      repoCopyUpdatedCaption(
        repo({ copyStatus: "failed", copyUpdatedAt: lastGood }),
      ),
    ).toBe("副本更新于 2026-01-02 03:04");
  });
});
