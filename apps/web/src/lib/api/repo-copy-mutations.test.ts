import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListReposResponse, RepoResponse } from "@cap/contracts";

const mocks = vi.hoisted(() => ({
  refreshRepoCopy: vi.fn(),
  importLocalRepo: vi.fn(),
}));

vi.mock("./real", () => ({
  refreshRepoCopy: mocks.refreshRepoCopy,
  importLocalRepo: mocks.importLocalRepo,
  runtimeModelErrorFromApiError: () => null,
}));

import {
  importLocalRepoMutation,
  markRepoCopyRefreshing,
  refreshRepoCopyMutation,
} from "./mutations";
import { queryKeys } from "./queries";

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function repo(patch: Partial<RepoResponse> = {}): RepoResponse {
  return {
    id: REPO_ID,
    name: "repo",
    gitSource: "https://github.com/team/repo.git",
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    defaultBranch: "main",
    ...patch,
  };
}

describe("refreshRepoCopyMutation", () => {
  beforeEach(() => {
    mocks.refreshRepoCopy.mockReset();
    mocks.importLocalRepo.mockReset();
  });

  it("shows `refreshing` while in flight and publishes only the server result", async () => {
    let release!: (value: RepoResponse) => void;
    mocks.refreshRepoCopy.mockImplementationOnce(
      () =>
        new Promise<RepoResponse>((resolve) => {
          release = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const prior = repo({ copyStatus: "missing", copyUpdatedAt: null });
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [prior]);
    const observer = new MutationObserver(
      queryClient,
      refreshRepoCopyMutation(queryClient),
    );

    const pending = observer.mutate(REPO_ID);
    await vi.waitFor(() =>
      expect(mocks.refreshRepoCopy).toHaveBeenCalledWith(REPO_ID),
    );
    // In flight: the badge reports the acquisition, and nothing else moved.
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([
      { ...prior, copyStatus: "refreshing" },
    ]);

    const acquired = repo({
      copyStatus: "ready",
      copyUpdatedAt: new Date("2026-07-20T10:00:00.000Z"),
    });
    release(acquired);
    await expect(pending).resolves.toEqual(acquired);
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([acquired]);
    queryClient.clear();
  });

  it("restores the prior state on failure so no phantom refresh is left running", async () => {
    mocks.refreshRepoCopy.mockRejectedValueOnce(new Error("safe copy failure"));
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const prior = repo({
      copyStatus: "failed",
      copyUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [prior]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      refreshRepoCopyMutation(queryClient),
    );

    await expect(observer.mutate(REPO_ID)).rejects.toThrow("safe copy failure");
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([prior]);
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("never fabricates a repository row for an id the cache does not hold", () => {
    const other = repo({ id: OTHER_ID, copyStatus: "ready" });
    expect(markRepoCopyRefreshing([other], REPO_ID)).toEqual([other]);
    expect(markRepoCopyRefreshing(undefined, REPO_ID)).toBeUndefined();
  });
});

describe("importLocalRepoMutation", () => {
  it("forwards the operator input verbatim and publishes the canonical Repo", async () => {
    const imported = repo({
      id: OTHER_ID,
      name: "local-repo",
      gitSource: "/srv/repos/local-repo",
      copyStatus: "ready",
      copyUpdatedAt: new Date("2026-07-20T10:00:00.000Z"),
    });
    mocks.importLocalRepo.mockResolvedValueOnce(imported);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const existing = repo({ copyStatus: "ready" });
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [existing]);
    const observer = new MutationObserver(
      queryClient,
      importLocalRepoMutation(queryClient),
    );

    await expect(
      observer.mutate({ path: "local-repo", name: "local-repo" }),
    ).resolves.toEqual(imported);

    expect(mocks.importLocalRepo).toHaveBeenCalledWith({
      path: "local-repo",
      name: "local-repo",
    });
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([
      imported,
      existing,
    ]);
    queryClient.clear();
  });
});
