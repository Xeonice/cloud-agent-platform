import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import {
  ScheduleResponseSchema,
  type ScheduleResponse,
  type ScheduleRunResponse,
} from "@cap/contracts";

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
  CurrentPeriodSummary,
  immediateDispatchSuccessMessage,
  LatestRunSummary,
  RunResultBadges,
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
    periodKey: "cron:2026-07-10T00:30:00.000Z",
    triggerSource: "automatic",
    triggeredAt: new Date("2026-07-10T00:30:00.000Z"),
    status: "created",
    taskId: uuid(20),
    taskStatus: "running",
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
    currentPeriod: {
      key: "cron:2026-07-10T00:35:00.000Z",
      scheduledFor: new Date("2026-07-10T00:35:00.000Z"),
      run: null,
    },
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
    expect(html).toContain("立即执行");
    expect(html).toContain("编辑");
    expect(html).toContain("删除");
    expect(html).not.toContain("/tasks/new");
    expect(html).not.toContain("*/5 * * * *");
  });

  it("shows the latest actual dispatch separately from the next scheduled run", () => {
    const dispatchedAt = new Date("2026-07-10T00:31:00.000Z");
    const nextRunAt = new Date("2026-07-10T00:35:00.000Z");
    const schedule = scheduleFixture({
      nextRunAt,
      latestRun: {
        id: uuid(30),
        scheduledFor: new Date("2026-07-10T00:30:00.000Z"),
        periodKey: "cron:2026-07-10T00:30:00.000Z",
        triggerSource: "manual",
        triggeredAt: dispatchedAt,
        createdAt: dispatchedAt,
        status: "created",
        taskId: uuid(20),
        taskStatus: "running",
        error: null,
      },
    });
    const detailHtml = renderToStaticMarkup(
      React.createElement(ScheduleDetail, {
        schedule,
        repos: [],
        onEdit: () => undefined,
        onDispatch: () => undefined,
        onPauseResume: () => undefined,
        onDelete: () => undefined,
      }),
    );
    const summaryHtml = renderToStaticMarkup(
      React.createElement(LatestRunSummary, {
        run: schedule.latestRun,
        timeZone: schedule.timezone,
      }),
    );

    expect(detailHtml).toContain("最近实际执行");
    expect(detailHtml).toContain(formatRenderedDate(dispatchedAt, "UTC"));
    expect(detailHtml).toContain("下次定时运行");
    expect(detailHtml).toContain(formatRenderedDate(nextRunAt, "UTC"));
    expect(summaryHtml).toContain(formatRenderedDate(dispatchedAt, "UTC"));
    expect(summaryHtml).toContain(`dateTime="${dispatchedAt.toISOString()}"`);
  });

  it("labels failed dispatch time as processing rather than execution", () => {
    const failedAt = new Date("2026-07-10T00:31:00.000Z");
    const failedRun = runFixture(uuid(31), {
      status: "failed",
      taskId: null,
      taskStatus: null,
      triggeredAt: failedAt,
      error: "dispatch failed",
    });
    const schedule = scheduleFixture({ latestRun: failedRun });
    const detailHtml = renderToStaticMarkup(
      React.createElement(ScheduleDetail, {
        schedule,
        repos: [],
        onEdit: () => undefined,
        onDispatch: () => undefined,
        onPauseResume: () => undefined,
        onDelete: () => undefined,
      }),
    );
    const summaryHtml = renderToStaticMarkup(
      React.createElement(LatestRunSummary, {
        run: failedRun,
        timeZone: "UTC",
      }),
    );

    expect(detailHtml).toContain("最近实际处理");
    expect(detailHtml).not.toContain("最近实际执行");
    expect(summaryHtml).toContain('aria-label="最近实际处理');
  });

  it("describes whether immediate dispatch preserves, advances, or lacks a next run", () => {
    const previous = scheduleFixture({
      nextRunAt: new Date("2026-07-10T00:35:00.000Z"),
    });
    expect(immediateDispatchSuccessMessage(previous, { ...previous })).toContain(
      "下次定时运行保持",
    );
    expect(
      immediateDispatchSuccessMessage(previous, {
        ...previous,
        nextRunAt: new Date("2026-07-11T00:35:00.000Z"),
      }),
    ).toContain("下次定时运行已更新");
    expect(
      immediateDispatchSuccessMessage(previous, {
        ...previous,
        enabled: false,
        nextRunAt: null,
      }),
    ).toBe("已立即派发，定时任务仍为暂停状态");

    const periodRun = runFixture(uuid(39), {
      triggerSource: "manual",
      triggeredAt: new Date("2026-07-10T00:31:00.000Z"),
    });
    expect(
      immediateDispatchSuccessMessage(previous, {
        ...previous,
        currentPeriod: {
          key: periodRun.periodKey!,
          scheduledFor: periodRun.scheduledFor,
          run: periodRun,
        },
        nextRunAt: new Date("2026-07-10T00:40:00.000Z"),
      }),
    ).toContain("本周期已执行；下次定时运行");
  });

  it("shows an unhandled current period independently from the next run", () => {
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

    expect(html).toContain("本周期未执行");
    expect(html).toContain("下次定时运行");
    expect(html).toContain("立即执行");
    expect(html).not.toContain("本周期已执行");
  });

  it("keeps a failed linked task inside an already-consumed current period", () => {
    const periodRun = runFixture(uuid(36), { taskStatus: "failed" });
    const schedule = scheduleFixture({
      latestRun: periodRun,
      currentPeriod: {
        key: periodRun.periodKey!,
        scheduledFor: periodRun.scheduledFor,
        run: periodRun,
      },
      nextRunAt: new Date("2026-07-10T00:40:00.000Z"),
    });
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

    expect(html).toContain("本周期已执行");
    expect(html).toContain("派发成功");
    expect(html).toContain("任务失败");
    expect(html).toContain('disabled=""');
  });

  it("marks failed and skipped period runs as handled", () => {
    for (const status of ["failed", "skipped"] as const) {
      const run = runFixture(uuid(status === "failed" ? 37 : 38), {
        status,
        taskId: null,
        taskStatus: null,
      });
      const html = renderToStaticMarkup(
        React.createElement(CurrentPeriodSummary, {
          period: {
            key: run.periodKey!,
            scheduledFor: run.scheduledFor,
            run,
          },
          timeZone: "UTC",
        }),
      );
      expect(html).toContain("本周期已处理");
      expect(html).toContain(status === "failed" ? "派发失败" : "已跳过");
    }
  });

  it("keeps immediate execution available when a mixed-version response omits currentPeriod", () => {
    const schedule = scheduleFixture({ currentPeriod: undefined });
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

    expect(html).toContain("状态不可用");
    expect(html).toContain("立即执行");
    expect(html).not.toContain('disabled=""');
  });

  it("separates successful dispatch from the linked task lifecycle", () => {
    const taskId = uuid(20);
    const html = renderToStaticMarkup(
      React.createElement(RunList, {
        runs: [
          runFixture(uuid(30), {
            taskId,
            status: "created",
            taskStatus: "failed",
          }),
        ],
        timeZone: "UTC",
      }),
    );

    expect(html).toContain("派发成功");
    expect(html).toContain("任务失败");
    expect(html).toContain(`href="/tasks/${taskId}"`);
    expect(html).toContain("任务");
  });

  it("shows agent startup failure as a task failure instead of a stopped task", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunResultBadges, {
        run: runFixture(uuid(34), { taskStatus: "agent_failed_to_start" }),
      }),
    );

    expect(html).toContain("派发成功");
    expect(html).toContain("任务启动失败");
    expect(html).not.toContain("任务已停止");
  });

  it("prefers actual triggeredAt over ledger creation and labels the period plan", () => {
    const createdAt = new Date("2026-07-10T00:31:00.000Z");
    const triggeredAt = new Date("2026-07-10T00:32:00.000Z");
    const scheduledFor = new Date("2026-07-12T12:45:00.000Z");
    const html = renderToStaticMarkup(
      React.createElement(RunList, {
        runs: [runFixture(uuid(33), { createdAt, triggeredAt, scheduledFor })],
        timeZone: "UTC",
      }),
    );

    expect(html).toContain("实际执行");
    expect(html).toContain(formatRenderedDate(triggeredAt, "UTC"));
    expect(html).not.toContain(formatRenderedDate(createdAt, "UTC"));
    expect(html).toContain("周期计划时间");
    expect(html).toContain(formatRenderedDate(scheduledFor, "UTC"));
  });

  it("degrades safely when a mixed-version API omits new latest-run fields", () => {
    const legacyRun = {
      id: uuid(35),
      scheduledFor: new Date("2026-07-12T12:45:00.000Z"),
      status: "created" as const,
      taskId: uuid(20),
      error: null,
    };
    const parsed = ScheduleResponseSchema.parse({
      ...scheduleFixture(),
      latestRun: legacyRun,
    });
    const html = renderToStaticMarkup(
      React.createElement(LatestRunSummary, {
        run: parsed.latestRun,
        timeZone: parsed.timezone,
      }),
    );

    expect(parsed.id).toBeTruthy();
    expect(html).toContain("派发成功");
    expect(html).toContain("时间不可用");
  });

  it("shows skipped and failed outcomes with reasons but without fabricated task links", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunList, {
        runs: [
          runFixture(uuid(31), {
            status: "skipped",
            taskId: null,
            taskStatus: null,
            error: "overlap: previous scheduled task is still active",
          }),
          runFixture(uuid(32), {
            status: "failed",
            taskId: null,
            taskStatus: null,
            error: "runtime is not ready",
          }),
        ],
        timeZone: "UTC",
      }),
    );

    expect(html).toContain("已跳过");
    expect(html).toContain("overlap: previous scheduled task is still active");
    expect(html).toContain("派发失败");
    expect(html).toContain("runtime is not ready");
    expect(html).not.toContain('href="/tasks/');
  });
});

function formatRenderedDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
