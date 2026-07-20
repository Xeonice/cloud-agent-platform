import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  TASK_PROVISIONING_STAGES,
  TASK_PROVISIONING_STATES,
  type TaskResponse,
} from "@cap/contracts";

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({
      to,
      hash,
      children,
    }: {
      to: string;
      hash?: string;
      children: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "a",
        { href: `${to}${hash ? `#${hash}` : ""}` },
        children,
      ),
  };
});

import { TaskProvisioningStatus } from "./task-provisioning-status";
import {
  TASK_PROVISIONING_STAGE_LABELS,
  TASK_PROVISIONING_STATE_LABELS,
  isProvisioningTaskFailure,
  taskDisplayBranch,
} from "@/lib/task-provisioning";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function task(overrides: Partial<TaskResponse> = {}): TaskResponse {
  return {
    id: uuid(1),
    repoId: uuid(2),
    prompt: "prepare a large repository",
    status: "pending",
    createdAt: new Date("2026-07-16T08:00:00.000Z"),
    branch: null,
    failure: null,
    provisioning: null,
    ...overrides,
  };
}

const failures = [
  {
    code: "provisioning_capacity_exhausted",
    action: "increase_sandbox_capacity",
    title: "沙箱容量不足",
    actionLabel: "检查运行环境",
    href: "/images",
  },
  {
    code: "provisioning_workspace_timeout",
    action: "retry_task",
    title: "仓库准备超时",
    actionLabel: "重新创建任务",
    href: "/tasks/new",
  },
  {
    code: "provisioning_forge_auth_failed",
    action: "reconnect_forge",
    title: "代码托管凭据不可用",
    actionLabel: "检查代码托管凭据",
    href: "/settings#forges",
  },
  {
    code: "provisioning_tls_network_failed",
    action: "retry_task",
    title: "网络或 TLS 连接失败",
    actionLabel: "重新创建任务",
    href: "/tasks/new",
  },
  {
    code: "provisioning_ref_not_found",
    action: "verify_repository_ref",
    title: "未找到目标分支或引用",
    actionLabel: "检查仓库与分支",
    href: "/repositories",
  },
  {
    code: "provisioning_platform_dependency_unavailable",
    action: "repair_deployment",
    title: "部署依赖不可用",
    actionLabel: "检查部署与升级",
    href: "/settings",
  },
  {
    code: "provisioning_unknown",
    action: "retry_task",
    title: "仓库准备失败",
    actionLabel: "重新创建任务",
    href: "/tasks/new",
  },
] as const;

describe("TaskProvisioningStatus", () => {
  it("keeps all contract states and stages exhaustively mapped", () => {
    expect(Object.keys(TASK_PROVISIONING_STATE_LABELS)).toEqual([
      ...TASK_PROVISIONING_STATES,
    ]);
    expect(Object.keys(TASK_PROVISIONING_STAGE_LABELS)).toEqual([
      ...TASK_PROVISIONING_STAGES,
    ]);
  });

  it("renders canonical retry state, stage, attempt, and resolved branch", () => {
    const html = renderToStaticMarkup(
      <TaskProvisioningStatus
        task={task({
          branch: "requested-branch",
          provisioning: {
            state: "retrying",
            stage: "workspace_transfer",
            attempt: 2,
            resolvedBranch: "master",
            updatedAt: new Date("2026-07-16T08:03:04.000Z"),
          },
        })}
        announce
      />,
    );

    expect(html).toContain('data-provisioning-state="retrying"');
    expect(html).toContain('data-provisioning-stage="workspace_transfer"');
    expect(html).toContain("自动重试中");
    expect(html).toContain("传输仓库工作区");
    expect(html).toContain("第 2 次处理尝试");
    expect(html).toContain("master");
    expect(html).not.toContain("requested-branch");
    expect(html).toContain('role="status"');
  });

  it("keeps a legacy null branch unresolved and renders no fabricated progress", () => {
    const legacy = task();

    expect(taskDisplayBranch(legacy)).toBe("待解析");
    expect(renderToStaticMarkup(<TaskProvisioningStatus task={legacy} />)).toBe(
      "",
    );
    expect(taskDisplayBranch(undefined)).toBe("待解析");
  });

  it("prefers the resolved checkout branch, then explicit caller intent", () => {
    expect(
      taskDisplayBranch(
        task({
          branch: "requested",
          provisioning: {
            state: "running",
            stage: "checkout",
            attempt: 1,
            resolvedBranch: "resolved",
            updatedAt: new Date("2026-07-16T08:00:00.000Z"),
          },
        }),
      ),
    ).toBe("resolved");
    expect(taskDisplayBranch(task({ branch: "requested" }))).toBe("requested");
  });

  for (const fixture of failures) {
    it(`renders ${fixture.code} from its structured code/action`, () => {
      const failure = {
        code: fixture.code,
        action: fixture.action,
        // Intentionally identical and misleading: classification must not parse it.
        message: "统一安全消息，不包含可用于分类的诊断文本。",
        occurredAt: new Date("2026-07-16T08:05:00.000Z"),
      } as NonNullable<TaskResponse["failure"]>;
      const html = renderToStaticMarkup(
        <TaskProvisioningStatus
          task={task({ status: "failed", failure })}
          announce
        />,
      );

      expect(isProvisioningTaskFailure(failure)).toBe(true);
      expect(html).toContain(`data-provisioning-failure="${fixture.code}"`);
      expect(html).toContain(fixture.title);
      expect(html).toContain(fixture.actionLabel);
      expect(html).toContain("统一安全消息");
      expect(html).toContain(`href="${fixture.href}"`);
      expect(html).toContain('role="alert"');
    });
  }

  it("shows the transfer percent alongside the stage label when the summary carries a known percent", () => {
    const provisioning = {
      state: "running",
      stage: "workspace_transfer",
      attempt: 1,
      resolvedBranch: "main",
      updatedAt: new Date("2026-07-16T08:03:04.000Z"),
      // Additive nullable progress object (lands contracts-first); this
      // surface reads it defensively, so the fixture attaches it structurally.
      progress: { percent: 47, receivedObjects: 1200, totalObjects: 2400 },
    } as unknown as NonNullable<TaskResponse["provisioning"]>;
    const html = renderToStaticMarkup(
      <TaskProvisioningStatus task={task({ provisioning })} />,
    );

    expect(html).toContain("传输仓库工作区 · 47%");
    // State pill and attempt presentation stay unchanged.
    expect(html).toContain(TASK_PROVISIONING_STATE_LABELS.running);
    expect(html).toContain("第 1 次处理尝试");
  });

  it("renders unchanged — never 0% — when progress is absent or its percent is unknown", () => {
    const base = {
      state: "running",
      stage: "workspace_transfer",
      attempt: 1,
      resolvedBranch: "main",
      updatedAt: new Date("2026-07-16T08:03:04.000Z"),
    } satisfies NonNullable<TaskResponse["provisioning"]>;

    // Old backend: no progress field at all.
    const withoutProgress = renderToStaticMarkup(
      <TaskProvisioningStatus task={task({ provisioning: base })} />,
    );
    expect(withoutProgress).toContain("传输仓库工作区");
    expect(withoutProgress).not.toContain("传输仓库工作区 ·");
    expect(withoutProgress).not.toContain("0%");

    // Progress present but percent unknown (pre-transfer phase).
    const unknownPercent = renderToStaticMarkup(
      <TaskProvisioningStatus
        task={task({
          provisioning: {
            ...base,
            progress: { percent: null, receivedObjects: 12 },
          } as unknown as NonNullable<TaskResponse["provisioning"]>,
        })}
      />,
    );
    expect(unknownPercent).not.toContain("传输仓库工作区 ·");
    expect(unknownPercent).not.toContain("0%");

    // Known percent outside the transfer stage never decorates other stages.
    const otherStage = renderToStaticMarkup(
      <TaskProvisioningStatus
        task={task({
          provisioning: {
            ...base,
            stage: "checkout",
            progress: { percent: 47 },
          } as unknown as NonNullable<TaskResponse["provisioning"]>,
        })}
      />,
    );
    expect(otherStage).not.toContain("47%");
  });

  it("does not misclassify runtime failures as provisioning failures", () => {
    const failure = {
      code: "runtime_auth_rejected",
      runtime: "codex",
      action: "reconnect_runtime",
      message: "runtime credential rejected",
      occurredAt: new Date("2026-07-16T08:05:00.000Z"),
      exitCode: 1,
    } as const satisfies NonNullable<TaskResponse["failure"]>;

    expect(isProvisioningTaskFailure(failure)).toBe(false);
    expect(
      renderToStaticMarkup(
        <TaskProvisioningStatus task={task({ status: "failed", failure })} />,
      ),
    ).toBe("");
  });
});
