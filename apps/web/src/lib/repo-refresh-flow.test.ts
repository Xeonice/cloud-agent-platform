import { describe, expect, it } from "vitest";

import {
  claimRepoRefreshSubmission,
  releaseRepoRefreshSubmission,
  type RepoRefreshSubmissionFence,
} from "./repo-refresh-flow";

describe("repository refresh submission fence", () => {
  it("rejects duplicate and competing clicks until the exact request settles", () => {
    const fence: RepoRefreshSubmissionFence = { current: null };

    expect(claimRepoRefreshSubmission(fence, "repo-1")).toBe(true);
    expect(claimRepoRefreshSubmission(fence, "repo-1")).toBe(false);
    expect(claimRepoRefreshSubmission(fence, "repo-2")).toBe(false);

    releaseRepoRefreshSubmission(fence, "repo-2");
    expect(fence.current).toBe("repo-1");
    releaseRepoRefreshSubmission(fence, "repo-1");
    expect(claimRepoRefreshSubmission(fence, "repo-2")).toBe(true);
  });
});
