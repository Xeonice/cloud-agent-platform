import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListReposResponse, RepoResponse } from "@cap/contracts";

const mocks = vi.hoisted(() => ({
  refreshRepoDefaultBranch: vi.fn(),
}));

vi.mock("./real", () => ({
  refreshRepoDefaultBranch: mocks.refreshRepoDefaultBranch,
  runtimeModelErrorFromApiError: () => null,
}));

import {
  refreshRepoDefaultBranchMutation,
  replaceRefreshedRepo,
} from "./mutations";
import { queryKeys } from "./queries";

function repo(
  id: string,
  forge: "github" | "gitlab" | "gitee",
  defaultBranch: string | null,
): RepoResponse {
  return {
    id,
    name: `${forge}-repo`,
    gitSource: `https://${forge}.example/team/repo.git`,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    forge,
    defaultBranch,
  };
}

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

describe("refreshRepoDefaultBranchMutation", () => {
  beforeEach(() => {
    mocks.refreshRepoDefaultBranch.mockReset();
  });

  it.each([
    ["github", "trunk"],
    ["gitlab", "develop"],
    ["gitee", "master"],
  ] as const)(
    "publishes the verified %s %s branch only after the server response and keeps the Repo id",
    async (forge, branch) => {
      let release!: (value: RepoResponse) => void;
      mocks.refreshRepoDefaultBranch.mockImplementationOnce(
        () =>
          new Promise<RepoResponse>((resolve) => {
            release = resolve;
          }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const prior = repo(REPO_ID, forge, "old-default");
      queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [prior]);
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const observer = new MutationObserver(
        queryClient,
        refreshRepoDefaultBranchMutation(queryClient),
      );

      const pending = observer.mutate(REPO_ID);
      await vi.waitFor(() =>
        expect(mocks.refreshRepoDefaultBranch).toHaveBeenCalledWith(REPO_ID),
      );
      expect(queryClient.getQueryData(queryKeys.repos)).toEqual([prior]);
      expect(invalidate).not.toHaveBeenCalled();

      const refreshed = repo(REPO_ID, forge, branch);
      release(refreshed);
      await expect(pending).resolves.toEqual(refreshed);

      expect(queryClient.getQueryData(queryKeys.repos)).toEqual([refreshed]);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.repos,
        exact: true,
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.defaultRepo,
        exact: true,
      });
      queryClient.clear();
    },
  );

  it("retains the previous verified branch and performs no invalidation on failure", async () => {
    mocks.refreshRepoDefaultBranch.mockRejectedValueOnce(
      new Error("safe refresh failure"),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const prior = repo(REPO_ID, "gitee", "master");
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [prior]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      refreshRepoDefaultBranchMutation(queryClient),
    );

    await expect(observer.mutate(REPO_ID)).rejects.toThrow(
      "safe refresh failure",
    );
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([prior]);
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("never inserts a server response into a cache that does not contain that Repo id", () => {
    const other = repo(OTHER_ID, "github", "trunk");
    const refreshed = repo(REPO_ID, "gitlab", "develop");

    expect(replaceRefreshedRepo([other], refreshed)).toEqual([other]);
    expect(replaceRefreshedRepo(undefined, refreshed)).toBeUndefined();
  });
});
