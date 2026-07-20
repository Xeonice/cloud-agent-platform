import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TASK_PROVISIONING_STAGES, type TaskResponse } from "@cap/contracts";

import { TaskProvisioningTimeline } from "./task-provisioning-timeline";
import {
  formatTransferBytes,
  provisioningTimelineEntries,
  taskTransferProgress,
  transferPercentLabel,
  transferProgressDetail,
} from "@/lib/task-provisioning";

type Provisioning = NonNullable<TaskResponse["provisioning"]>;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function provisioning(overrides: Partial<Provisioning> = {}): Provisioning {
  return {
    state: "running",
    stage: "workspace_transfer",
    attempt: 1,
    resolvedBranch: "main",
    updatedAt: new Date("2026-07-16T08:03:04.000Z"),
    ...overrides,
  };
}

/**
 * The additive nullable `progress` object lands contracts-first in a parallel
 * track; this surface reads it defensively, so fixtures attach it structurally.
 */
function withProgress(
  base: Provisioning,
  progress: Record<string, unknown> | null,
): Provisioning {
  return { ...base, progress } as unknown as Provisioning;
}

function task(overrides: Partial<TaskResponse> = {}): TaskResponse {
  return {
    id: uuid(1),
    repoId: uuid(2),
    prompt: "clone a large repository",
    status: "pending",
    createdAt: new Date("2026-07-16T08:00:00.000Z"),
    branch: null,
    failure: null,
    provisioning: null,
    ...overrides,
  };
}

describe("provisioningTimelineEntries", () => {
  it("derives the checklist from TASK_PROVISIONING_STAGES order vs the current stage", () => {
    const entries = provisioningTimelineEntries(
      provisioning({ stage: "workspace_transfer" }),
    );

    expect(entries.map((entry) => entry.stage)).toEqual([
      ...TASK_PROVISIONING_STAGES,
    ]);
    const currentIndex = TASK_PROVISIONING_STAGES.indexOf("workspace_transfer");
    for (const [index, entry] of entries.entries()) {
      expect(entry.status).toBe(
        index < currentIndex
          ? "completed"
          : index === currentIndex
            ? "current"
            : "pending",
      );
    }
  });

  it("marks the first stage current with nothing completed", () => {
    const entries = provisioningTimelineEntries(
      provisioning({ state: "queued", stage: "accepted" }),
    );
    expect(entries[0]).toMatchObject({ stage: "accepted", status: "current" });
    expect(
      entries.slice(1).every((entry) => entry.status === "pending"),
    ).toBe(true);
  });

  it("marks every stage completed once the summary succeeded", () => {
    const entries = provisioningTimelineEntries(
      provisioning({ state: "succeeded", stage: "complete" }),
    );
    expect(entries.every((entry) => entry.status === "completed")).toBe(true);
  });
});

describe("taskTransferProgress", () => {
  it("reads the numeric-only progress object", () => {
    expect(
      taskTransferProgress(
        withProgress(provisioning(), {
          percent: 47,
          receivedObjects: 1200,
          totalObjects: 2400,
          receivedBytes: 10485760,
          throughput: 1048576,
        }),
      ),
    ).toEqual({
      percent: 47,
      receivedObjects: 1200,
      totalObjects: 2400,
      receivedBytes: 10485760,
      throughput: 1048576,
    });
  });

  it("treats an omitted field (old backend), null, or malformed value as no progress", () => {
    // A summary from an old backend simply has no `progress` key at all.
    expect(taskTransferProgress(provisioning())).toBeNull();
    expect(taskTransferProgress(withProgress(provisioning(), null))).toBeNull();
    expect(
      taskTransferProgress(
        withProgress(provisioning(), "45%" as unknown as Record<string, unknown>),
      ),
    ).toBeNull();
    expect(taskTransferProgress(null)).toBeNull();
    expect(taskTransferProgress(undefined)).toBeNull();
  });

  it("rejects non-numeric and negative field values instead of coercing them", () => {
    const progress = taskTransferProgress(
      withProgress(provisioning(), {
        percent: "47",
        receivedObjects: -3,
        totalObjects: Number.NaN,
        receivedBytes: Number.POSITIVE_INFINITY,
      }),
    );
    expect(progress).toEqual({
      percent: null,
      receivedObjects: null,
      totalObjects: null,
      receivedBytes: null,
      throughput: null,
    });
  });

  it("clamps a percent above 100", () => {
    expect(
      taskTransferProgress(withProgress(provisioning(), { percent: 120 }))
        ?.percent,
    ).toBe(100);
  });
});

describe("transferPercentLabel", () => {
  it("labels a known percent, keeping a genuine 0% distinct from unknown", () => {
    expect(
      transferPercentLabel({
        percent: 46.6,
        receivedObjects: null,
        totalObjects: null,
        receivedBytes: null,
        throughput: null,
      }),
    ).toBe("47%");
    expect(
      transferPercentLabel({
        percent: 0,
        receivedObjects: null,
        totalObjects: null,
        receivedBytes: null,
        throughput: null,
      }),
    ).toBe("0%");
  });

  it("returns null for unknown percent — never a fabricated 0%", () => {
    expect(
      transferPercentLabel({
        percent: null,
        receivedObjects: 12,
        totalObjects: null,
        receivedBytes: 4096,
        throughput: null,
      }),
    ).toBeNull();
    expect(transferPercentLabel(null)).toBeNull();
  });
});

describe("transferProgressDetail / formatTransferBytes", () => {
  it("formats bytes across units", () => {
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(10485760)).toBe("10.0 MiB");
    expect(formatTransferBytes(1610612736)).toBe("1.5 GiB");
  });

  it("assembles only the facts the summary carries", () => {
    expect(
      transferProgressDetail({
        percent: 47,
        receivedObjects: 1200,
        totalObjects: 2400,
        receivedBytes: 10485760,
        throughput: 1048576,
      }),
    ).toBe("对象 1200/2400 · 已接收 10.0 MiB · 1.0 MiB/s");
    expect(
      transferProgressDetail({
        percent: null,
        receivedObjects: null,
        totalObjects: null,
        receivedBytes: null,
        throughput: null,
      }),
    ).toBeNull();
  });
});

describe("TaskProvisioningTimeline", () => {
  it("renders the full checklist with completed/current/pending markers over the poll payload", () => {
    const html = renderToStaticMarkup(
      <TaskProvisioningTimeline
        task={task({ provisioning: provisioning({ stage: "checkout" }) })}
      />,
    );

    for (const stage of TASK_PROVISIONING_STAGES) {
      expect(html).toContain(`data-stage="${stage}"`);
    }
    expect(html).toContain(
      'data-stage="workspace_transfer" data-stage-status="completed"',
    );
    expect(html).toContain('data-stage="checkout" data-stage-status="current"');
    expect(html).toContain(
      'data-stage="submodules" data-stage-status="pending"',
    );
  });

  it("renders a determinate transfer bar whose width tracks the polled percent", () => {
    const render = (percent: number) =>
      renderToStaticMarkup(
        <TaskProvisioningTimeline
          task={task({
            provisioning: withProgress(provisioning(), {
              percent,
              receivedObjects: 1200,
              totalObjects: 2400,
              receivedBytes: 10485760,
              throughput: 1048576,
            }),
          })}
        />,
      );

    const at30 = render(30);
    expect(at30).toContain('data-progress-mode="determinate"');
    expect(at30).toContain('aria-valuenow="30"');
    expect(at30).toContain("width:30%");
    expect(at30).toContain("30%");
    expect(at30).toContain("对象 1200/2400");

    const at55 = render(55);
    expect(at55).toContain('aria-valuenow="55"');
    expect(at55).toContain("width:55%");
  });

  it("renders indeterminate — and never 0% — for an unknown transfer phase", () => {
    const html = renderToStaticMarkup(
      <TaskProvisioningTimeline
        task={task({
          provisioning: withProgress(provisioning(), { percent: null }),
        })}
      />,
    );

    expect(html).toContain('data-progress-mode="indeterminate"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("0%");
    expect(html).toContain("正在传输仓库数据…");
  });

  it("fabricates no progress bar when the summary has no progress object (old backend)", () => {
    const html = renderToStaticMarkup(
      <TaskProvisioningTimeline
        task={task({ provisioning: provisioning() })}
      />,
    );

    expect(html).toContain(
      'data-stage="workspace_transfer" data-stage-status="current"',
    );
    expect(html).not.toContain("data-transfer-progress");
    expect(html).not.toContain('role="progressbar"');
  });

  it("shows the bar only on the workspace_transfer stage", () => {
    const html = renderToStaticMarkup(
      <TaskProvisioningTimeline
        task={task({
          provisioning: withProgress(provisioning({ stage: "checkout" }), {
            percent: 47,
          }),
        })}
      />,
    );
    expect(html).not.toContain('role="progressbar"');
  });

  it("renders nothing without a summary or after provisioning succeeded", () => {
    expect(renderToStaticMarkup(<TaskProvisioningTimeline task={task()} />)).toBe(
      "",
    );
    expect(
      renderToStaticMarkup(<TaskProvisioningTimeline task={undefined} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <TaskProvisioningTimeline
          task={task({
            provisioning: provisioning({
              state: "succeeded",
              stage: "complete",
            }),
          })}
        />,
      ),
    ).toBe("");
  });
});
