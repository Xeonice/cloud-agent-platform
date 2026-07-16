import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_TASK_STATUSES,
  type TaskProvisioningStage,
  type TaskProvisioningState,
  type TaskResponse,
  type TaskStatus,
} from "@cap/contracts";

import {
  TASK_DETAIL_POLL_INTERVAL_MS,
  taskDetailPollingInterval,
} from "./task-provisioning";

function taskSnapshot(
  status: TaskStatus,
  state: TaskProvisioningState,
  stage: TaskProvisioningStage,
  attempt: number,
): TaskResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    repoId: "00000000-0000-4000-8000-000000000002",
    prompt: "prepare the verified master branch",
    status,
    createdAt: new Date("2026-07-16T08:00:00.000Z"),
    branch: null,
    failure: null,
    provisioning: {
      state,
      stage,
      attempt,
      resolvedBranch: stage === "accepted" ? null : "master",
      updatedAt: new Date(`2026-07-16T08:00:0${attempt}.000Z`),
    },
  };
}

describe("task detail provisioning polling", () => {
  it("keeps polling through accepted, queued, transfer, retry, and active execution", () => {
    const progression = [
      taskSnapshot("pending", "accepted", "accepted", 0),
      taskSnapshot("queued", "queued", "accepted", 0),
      taskSnapshot("pending", "running", "remote_ref_resolution", 1),
      taskSnapshot("pending", "running", "workspace_transfer", 1),
      taskSnapshot("pending", "retrying", "workspace_transfer", 2),
      taskSnapshot("running", "succeeded", "complete", 2),
      taskSnapshot("awaiting_input", "succeeded", "complete", 2),
    ];

    expect(progression.map(taskDetailPollingInterval)).toEqual(
      progression.map(() => TASK_DETAIL_POLL_INTERVAL_MS),
    );
    expect(taskDetailPollingInterval(undefined)).toBe(
      TASK_DETAIL_POLL_INTERVAL_MS,
    );
  });

  it("stops polling for every canonical terminal task state", () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(
        taskDetailPollingInterval(
          taskSnapshot(
            status,
            status === "cancelled" ? "cancelled" : "failed",
            "workspace_transfer",
            2,
          ),
        ),
      ).toBe(false);
    }
  });

  it("wires the live task route to the shared tested policy", () => {
    const source = readFileSync(
      new URL("../routes/_app/tasks/$taskId.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "taskDetailPollingInterval(query.state.data)",
    );
    expect(source).not.toMatch(/refetchInterval:[\s\S]{0,120}\? false\s*:\s*4000/);
  });
});
