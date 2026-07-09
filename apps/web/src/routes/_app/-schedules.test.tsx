import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ScheduleResponse, ScheduleRunResponse } from "@cap/contracts";

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    createFileRoute: () => (config: unknown) => config,
    Link: ({
      to,
      params,
      search,
      children,
    }: {
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string | undefined>;
      children: React.ReactNode;
    }) =>
      ReactModule.createElement("a", {
        href: linkHref(to, params, search),
      }, children),
  };
});

import {
  buildSchedulePayload,
  ScheduleDetail,
  RunList,
  type ScheduleFormState,
} from "./schedules";

function linkHref(
  to: string,
  params?: Record<string, string>,
  search?: Record<string, string | undefined>,
): string {
  const path = params?.taskId
    ? to.replace("$taskId", encodeURIComponent(params.taskId))
    : to;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value !== undefined) searchParams.set(key, value);
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function baseForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    id: null,
    name: " Workday review ",
    recurrenceKind: "weekdays",
    recurrenceTime: "08:30",
    timezone: "Asia/Shanghai",
    weekday: 1,
    dayOfMonth: 1,
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

function scheduleFixture(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    id: uuid(40),
    ownerUserId: "user-1",
    repoId: uuid(1),
    name: "legacy interval",
    cronExpression: "*/5 * * * *",
    timezone: "UTC",
    recurrence: {
      kind: "custom",
      timezone: "UTC",
      label: "自定义重复",
    },
    enabled: true,
    nextRunAt: new Date("2026-07-10T00:35:00.000Z"),
    overlapPolicy: "skip",
    misfirePolicy: "fire-once",
    taskTemplate: {
      repoId: uuid(1),
      prompt: "check drift",
      runtime: "codex",
      sandboxEnvironmentId: null,
      deliver: "none",
    },
    latestRun: null,
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

describe("schedule page payload", () => {
  it("submits recurrence, policy, delivery, guardrails, skills, and task-template fields", () => {
    const payload = buildSchedulePayload(baseForm());

    expect(payload).toEqual({
      name: "Workday review",
      recurrence: {
        kind: "weekdays",
        time: "08:30",
        timezone: "Asia/Shanghai",
      },
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
        recurrenceTime: "",
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
    expect(payload.recurrence).toEqual({
      kind: "weekdays",
      time: "09:00",
      timezone: "UTC",
    });
    expect(payload.taskTemplate).toEqual({
      repoId: uuid(1),
      prompt: "check nightly drift",
      sandboxEnvironmentId: null,
    });
  });

  it("preserves custom existing timing while editing task fields", () => {
    const payload = buildSchedulePayload(
      baseForm({
        id: uuid(9),
        recurrenceKind: "custom",
      }),
      {
        cronExpression: "*/5 * * * *",
        timezone: "UTC",
      },
    );

    expect(payload).toMatchObject({
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
      taskTemplate: {
        prompt: "check nightly drift",
      },
    });
    expect("recurrence" in payload).toBe(false);
  });
});

describe("schedule run history rendering", () => {
  it("shows custom recurrence summaries and edit/dispatch actions without exposing raw cron", () => {
    const schedule = scheduleFixture();
    const html = renderToStaticMarkup(
      React.createElement(ScheduleDetail, {
        schedule,
        repos: [],
        onEdit: () => undefined,
        onDispatch: () => undefined,
        onPauseResume: () => undefined,
        onDelete: () => undefined,
      }),
    );

    expect(html).toContain("自定义重复");
    expect(html).toContain("立即派发");
    expect(html).toContain("编辑");
    expect(html).toContain("删除");
    expect(html).not.toContain("/tasks/new");
    expect(html).not.toContain("*/5 * * * *");
  });

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
