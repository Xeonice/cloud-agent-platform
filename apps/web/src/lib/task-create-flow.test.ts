import { describe, expect, it } from "vitest";

import {
  canResetTaskCreateSubmission,
  claimTaskCreateSubmission,
  releaseRejectedTaskCreate,
  resetTaskCreateSubmission,
} from "./task-create-flow";

describe("task-create synchronous submission fence", () => {
  it("admits one create in the same render tick and stays closed after acceptance", () => {
    const fence = { current: false };

    expect(claimTaskCreateSubmission(fence)).toBe(true);
    expect(claimTaskCreateSubmission(fence)).toBe(false);
    expect(fence.current).toBe(true);
  });

  it("releases a rejected create and resets for a fresh modal flow", () => {
    const fence = { current: true };

    releaseRejectedTaskCreate(fence);
    expect(claimTaskCreateSubmission(fence)).toBe(true);
    expect(claimTaskCreateSubmission(fence)).toBe(false);

    resetTaskCreateSubmission(fence);
    expect(claimTaskCreateSubmission(fence)).toBe(true);
  });

  it("does not reset a pending create when the modal closes and reopens", () => {
    const pending = { current: true };
    expect(canResetTaskCreateSubmission(pending, null)).toBe(false);

    const rejected = { current: false };
    expect(canResetTaskCreateSubmission(rejected, null)).toBe(true);

    const accepted = { current: true };
    expect(canResetTaskCreateSubmission(accepted, "accepted-task-id")).toBe(true);
  });
});
