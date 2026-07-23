/**
 * add-repo-content-store (verify V.1) — the console half of "copy lifecycle
 * follows the Repo": `DELETE /repos/:repoId` retires the Repo AND its
 * repo-store content copy in one operator action.
 *
 * These pin the mutation's cache contract: destructive, NOT optimistic (the
 * server legitimately refuses with 409 `repo_has_tasks`), and it never
 * fabricates or re-orders repository rows client-side.
 */
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListReposResponse, RepoResponse } from "@cap/contracts";

const mocks = vi.hoisted(() => ({
  deleteRepo: vi.fn(),
}));

vi.mock("./real", () => ({
  deleteRepo: mocks.deleteRepo,
  runtimeModelErrorFromApiError: () => null,
}));

import { deleteRepoMutation, removeDeletedRepo } from "./mutations";
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
    copyStatus: "ready",
    ...patch,
  };
}

describe("deleteRepoMutation", () => {
  beforeEach(() => {
    mocks.deleteRepo.mockReset();
  });

  it("drops the repo from the list only after the server confirms", async () => {
    let release!: () => void;
    mocks.deleteRepo.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const doomed = repo();
    const kept = repo({ id: OTHER_ID, name: "other" });
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [doomed, kept]);
    const observer = new MutationObserver(
      queryClient,
      deleteRepoMutation(queryClient),
    );

    const pending = observer.mutate(REPO_ID);
    await vi.waitFor(() => expect(mocks.deleteRepo).toHaveBeenCalledWith(REPO_ID));
    // In flight: nothing has been removed yet — the server can still refuse.
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([doomed, kept]);

    release();
    await pending;
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([kept]);
    queryClient.clear();
  });

  it("leaves the list untouched when the server refuses (repo_has_tasks)", async () => {
    mocks.deleteRepo.mockRejectedValueOnce(new Error("repo_has_tasks"));
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const prior = [repo(), repo({ id: OTHER_ID, name: "other" })];
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, prior);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      deleteRepoMutation(queryClient),
    );

    await expect(observer.mutate(REPO_ID)).rejects.toThrow("repo_has_tasks");

    expect(queryClient.getQueryData(queryKeys.repos)).toEqual(prior);
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("re-reads the default repo so a deleted default cannot linger", async () => {
    mocks.deleteRepo.mockResolvedValueOnce(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [
      repo({ isDefault: true }),
    ]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      deleteRepoMutation(queryClient),
    );

    await observer.mutate(REPO_ID);

    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([]);
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(queryKeys.repos);
    expect(keys).toContainEqual(queryKeys.defaultRepo);
    queryClient.clear();
  });

  it("never fabricates rows for an unloaded or unrelated cache", () => {
    const other = repo({ id: OTHER_ID });
    expect(removeDeletedRepo([other], REPO_ID)).toEqual([other]);
    expect(removeDeletedRepo(undefined, REPO_ID)).toBeUndefined();
    expect(removeDeletedRepo([], REPO_ID)).toEqual([]);
  });
});
