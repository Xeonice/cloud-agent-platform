import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ScheduleRunResponse } from "@cap/contracts";

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    createFileRoute: () => (config: unknown) => config,
    Link: ({
      to,
      params,
      children,
    }: {
      to: string;
      params?: Record<string, string>;
      children: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "a",
        {
          href: params?.taskId
            ? to.replace("$taskId", encodeURIComponent(params.taskId))
            : to,
        },
        children,
      ),
  };
});

import {
  buildSchedulePayload,
  RunList,
  type ScheduleFormState,
} from "./schedules";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function baseForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    id: null,
    name: " Workday review ",
    cronExpression: " 30 8 * * 1-5 ",
    timezone: " Asia/Shanghai ",
    overlapPolicy: "enqueue",
    repoId: uuid(1),
    runtime: "claude-code",
    sandboxEnvironmentId: uuid(2),
    deliver: "pr",
    branch: " main ",
    strategy: " open a PR ",
    skills: ["browser", "git"],
    idleTimeoutMs: 900_000,
    deadlineMs: 3_600_000,
    prompt: "  check nightly drift  ",
    ...overrides,
  };
}

function runFixture(
  id: string,
  overrides: Partial<ScheduleRunResponse> = {},
): ScheduleRunResponse {
  return {
    id,
    scheduleId: uuid(10),
    scheduledFor: new Date("2026-07-10T00:30:00.000Z"),
    status: "created",
    taskId: uuid(20),
    error: null,
    createdAt: new Date("2026-07-10T00:30:00.000Z"),
    updatedAt: new Date("2026-07-10T00:30:01.000Z"),
    ...overrides,
  };
}

describe("schedule page payload", () => {
  it("submits cron, policy, delivery, guardrails, skills, and task-template fields", () => {
    const payload = buildSchedulePayload(baseForm());

    expect(payload).toEqual({
      name: "Workday review",
      cronExpression: "30 8 * * 1-5",
      timezone: "Asia/Shanghai",
      overlapPolicy: "enqueue",
      misfirePolicy: "fire-once",
      taskTemplate: {
        repoId: uuid(1),
        prompt: "check nightly drift",
        runtime: "claude-code",
        sandboxEnvironmentId: uuid(2),
        deliver: "pr",
        branch: "main",
        strategy: "open a PR",
        skills: ["browser", "git"],
        idleTimeoutMs: 900_000,
        deadlineMs: 3_600_000,
      },
    });
  });

  it("omits default-only fields and sends null when the server default environment is chosen", () => {
    const payload = buildSchedulePayload(
      baseForm({
        name: "  ",
        timezone: "  ",
        runtime: "codex",
        sandboxEnvironmentId: "__server_default__",
        deliver: "none",
        branch: "  ",
        strategy: "  ",
        skills: [],
        idleTimeoutMs: null,
        deadlineMs: null,
      }),
    );

    expect(payload.name).toBeNull();
    expect(payload.timezone).toBe("UTC");
    expect(payload.taskTemplate).toEqual({
      repoId: uuid(1),
      prompt: "check nightly drift",
      sandboxEnvironmentId: null,
    });
  });
});

describe("schedule run history rendering", () => {
  it("links successful fires to the ordinary task route", () => {
    const taskId = uuid(20);
    const html = renderToStaticMarkup(
      React.createElement(RunList, {
        runs: [runFixture(uuid(30), { taskId, status: "created" })],
      }),
    );

    expect(html).toContain("已创建");
    expect(html).toContain(`href="/tasks/${taskId}"`);
    expect(html).toContain("任务");
  });

  it("shows skipped and failed outcomes with reasons but without fabricated task links", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunList, {
        runs: [
          runFixture(uuid(31), {
            status: "skipped",
            taskId: null,
            error: "overlap: previous scheduled task is still active",
          }),
          runFixture(uuid(32), {
            status: "failed",
            taskId: null,
            error: "runtime is not ready",
          }),
        ],
      }),
    );

    expect(html).toContain("已跳过");
    expect(html).toContain("overlap: previous scheduled task is still active");
    expect(html).toContain("失败");
    expect(html).toContain("runtime is not ready");
    expect(html).not.toContain('href="/tasks/');
  });
});
