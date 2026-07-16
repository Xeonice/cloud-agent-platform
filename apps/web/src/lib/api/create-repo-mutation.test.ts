import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateRepoRequest,
  ListReposResponse,
  VerifiedRepoImportResponse,
} from "@cap/contracts";

const mocks = vi.hoisted(() => ({
  createRepo: vi.fn(),
}));

vi.mock("./real", () => ({
  createRepo: mocks.createRepo,
  runtimeModelErrorFromApiError: () => null,
}));

import { createRepoMutation, upsertVerifiedRepo } from "./mutations";
import { queryKeys } from "./queries";

const REQUEST: CreateRepoRequest = {
  name: "team/private-app",
  gitSource: "https://gitee.com/team/private-app.git",
  forge: "gitee",
  importSource: "url",
};

function imported(
  id = "11111111-1111-4111-8111-111111111111",
): VerifiedRepoImportResponse {
  return {
    id,
    name: REQUEST.name,
    gitSource: REQUEST.gitSource,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
    forge: "gitee",
    defaultBranch: "master",
  };
}

describe("createRepoMutation verified import handoff", () => {
  beforeEach(() => {
    mocks.createRepo.mockReset();
  });

  it("keeps the mutation pending and the picker cache unchanged until verification resolves", async () => {
    let release!: (repo: VerifiedRepoImportResponse) => void;
    mocks.createRepo.mockImplementationOnce(
      () =>
        new Promise<VerifiedRepoImportResponse>((resolve) => {
          release = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const existing = imported("22222222-2222-4222-8222-222222222222");
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [existing]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      createRepoMutation(queryClient),
    );
    const states: string[] = [];
    const unsubscribe = observer.subscribe((result) => {
      states.push(result.status);
    });

    const pending = observer.mutate(REQUEST);
    await vi.waitFor(() => expect(mocks.createRepo).toHaveBeenCalledOnce());

    expect(observer.getCurrentResult().status).toBe("pending");
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([existing]);
    expect(invalidate).not.toHaveBeenCalled();

    const verified = imported();
    release(verified);
    await expect(pending).resolves.toEqual(verified);

    expect(observer.getCurrentResult().status).toBe("success");
    expect(states).toContain("pending");
    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([
      verified,
      existing,
    ]);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.repos,
      exact: true,
    });
    unsubscribe();
    queryClient.clear();
  });

  it("does not update or invalidate the picker cache on a verification failure", async () => {
    mocks.createRepo.mockRejectedValueOnce(new Error("verification failed"));
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const existing = imported("22222222-2222-4222-8222-222222222222");
    queryClient.setQueryData<ListReposResponse>(queryKeys.repos, [existing]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(
      queryClient,
      createRepoMutation(queryClient),
    );

    await expect(observer.mutate(REQUEST)).rejects.toThrow("verification failed");

    expect(queryClient.getQueryData(queryKeys.repos)).toEqual([existing]);
    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("upserts a verified retry idempotently without fabricating an unloaded list", () => {
    const prior = { ...imported(), name: "stale name" };
    const verified = imported();
    const other = imported("22222222-2222-4222-8222-222222222222");

    expect(upsertVerifiedRepo([other, prior], verified)).toEqual([
      verified,
      other,
    ]);
    expect(upsertVerifiedRepo(undefined, verified)).toBeUndefined();
  });
});
