import { describe, expect, it } from "vitest";
import {
  CreateTaskRequestSchema,
  type ScheduleResponse,
} from "@cap/contracts";

import {
  buildSchedulePayload,
  buildTaskRequest,
  ENVIRONMENT_SERVER_DEFAULT,
  scheduleFormFromSchedule,
  type ScheduleFormState,
  type TaskTemplateFormState,
} from "./task-form";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function taskForm(
  overrides: Partial<TaskTemplateFormState> = {},
): TaskTemplateFormState {
  return {
    repoId: uuid(1),
    runtime: "claude-code",
    model: "claude-sonnet-4-5",
    sandboxEnvironmentId: uuid(2),
    deliver: "pr",
    branch: " main ",
    strategy: " ship as PR ",
    skills: ["openspec"],
    idleTimeoutMs: 900_000,
    deadlineMs: 3_600_000,
    prompt: "  implement the thing  ",
    ...overrides,
  };
}

function scheduleForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    ...taskForm(),
    id: null,
    name: " Workday review ",
    recurrenceKind: "weekdays",
    recurrenceTime: "08:30",
    minuteOfHour: 0,
    intervalMinutes: 5,
    timezone: "Asia/Shanghai",
    weekday: 1,
    dayOfMonth: 1,
    overlapPolicy: "skip",
    ...overrides,
  };
}

function scheduleFixture(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    id: uuid(10),
    ownerUserId: "user-1",
    repoId: uuid(1),
    name: "weekday",
    cronExpression: "30 8 * * 1-5",
    timezone: "Asia/Shanghai",
    recurrence: {
      kind: "weekdays",
      time: "08:30",
      timezone: "Asia/Shanghai",
      label: "工作日 08:30",
    },
    enabled: true,
    nextRunAt: new Date("2026-07-10T00:30:00.000Z"),
    overlapPolicy: "skip",
    misfirePolicy: "fire-once",
    taskTemplate: {
      repoId: uuid(1),
      prompt: "implement the thing",
      runtime: "claude-code",
      model: "claude-sonnet-4-5",
      sandboxEnvironmentId: uuid(2),
      deliver: "pr",
      branch: "main",
      strategy: "ship as PR",
      skills: ["openspec"],
      idleTimeoutMs: 900_000,
      deadlineMs: 3_600_000,
    },
    latestRun: null,
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

describe("shared task form builders", () => {
  it("projects every canonical Console task-create field", () => {
    const body = buildTaskRequest(taskForm());

    expect(Object.keys(body).sort()).toEqual(
      Object.keys(CreateTaskRequestSchema.shape).sort(),
    );
    expect(CreateTaskRequestSchema.parse(body)).toEqual(body);
  });

  it("builds immediate task payloads without schedule fields", () => {
    expect(buildTaskRequest(taskForm())).toEqual({
      prompt: "implement the thing",
      branch: "main",
      strategy: "ship as PR",
      skills: ["openspec"],
      runtime: "claude-code",
      model: "claude-sonnet-4-5",
      sandboxEnvironmentId: uuid(2),
      deliver: "pr",
      idleTimeoutMs: 900_000,
      deadlineMs: 3_600_000,
    });
  });

  it("builds recurrence-first schedule payloads from the same task template state", () => {
    expect(buildSchedulePayload(scheduleForm())).toMatchObject({
      name: "Workday review",
      recurrence: {
        kind: "weekdays",
        time: "08:30",
        timezone: "Asia/Shanghai",
      },
      overlapPolicy: "skip",
      misfirePolicy: "fire-once",
      taskTemplate: {
        repoId: uuid(1),
        prompt: "implement the thing",
        runtime: "claude-code",
        model: "claude-sonnet-4-5",
        deliver: "pr",
      },
    });
  });

  it("builds hourly and fixed-interval payloads with an explicit timezone", () => {
    expect(
      buildSchedulePayload(
        scheduleForm({
          recurrenceKind: "hourly",
          minuteOfHour: 15,
          timezone: "Asia/Shanghai",
        }),
      ).recurrence,
    ).toEqual({
      kind: "hourly",
      minuteOfHour: 15,
      timezone: "Asia/Shanghai",
    });
    expect(
      buildSchedulePayload(
        scheduleForm({
          recurrenceKind: "minuteInterval",
          intervalMinutes: 30,
          timezone: "",
        }),
      ).recurrence,
    ).toEqual({
      kind: "minuteInterval",
      intervalMinutes: 30,
      timezone: "UTC",
    });
  });

  it("prefills edit-recurring mode from an existing schedule", () => {
    const form = scheduleFormFromSchedule(scheduleFixture(), "codex");
    expect(form).toMatchObject({
      id: uuid(10),
      name: "weekday",
      repoId: uuid(1),
      runtime: "claude-code",
      model: "claude-sonnet-4-5",
      recurrenceKind: "weekdays",
      recurrenceTime: "08:30",
      timezone: "Asia/Shanghai",
      prompt: "implement the thing",
      branch: "main",
    });
  });

  it("omits the model when the runtime default is selected", () => {
    expect(buildTaskRequest(taskForm({ model: null }))).not.toHaveProperty("model");
    expect(
      buildSchedulePayload(scheduleForm({ model: null })).taskTemplate,
    ).not.toHaveProperty("model");
  });

  it("preserves deployment-default and managed environments when hydrating a schedule", () => {
    const deploymentDefault = scheduleFixture({
      taskTemplate: {
        repoId: uuid(1),
        prompt: "deployment default",
        runtime: "codex",
        sandboxEnvironmentId: null,
        deliver: "none",
      },
    });

    expect(
      scheduleFormFromSchedule(deploymentDefault, "codex").sandboxEnvironmentId,
    ).toBe(ENVIRONMENT_SERVER_DEFAULT);
    expect(
      scheduleFormFromSchedule(scheduleFixture(), "codex").sandboxEnvironmentId,
    ).toBe(uuid(2));
  });

  it("hydrates hourly and fixed-interval edit fields without inventing calendar time", () => {
    const hourly = scheduleFormFromSchedule(
      scheduleFixture({
        cronExpression: "45 * * * *",
        timezone: "Europe/London",
        recurrence: {
          kind: "hourly",
          minuteOfHour: 45,
          timezone: "Europe/London",
          label: "每小时第 45 分钟",
        },
      }),
      "codex",
    );
    expect(hourly).toMatchObject({
      recurrenceKind: "hourly",
      minuteOfHour: 45,
      timezone: "Europe/London",
    });

    const interval = scheduleFormFromSchedule(
      scheduleFixture({
        cronExpression: "*/15 * * * *",
        timezone: "Asia/Shanghai",
        recurrence: {
          kind: "minuteInterval",
          intervalMinutes: 15,
          timezone: "Asia/Shanghai",
          label: "每 15 分钟",
        },
      }),
      "codex",
    );
    expect(interval).toMatchObject({
      recurrenceKind: "minuteInterval",
      intervalMinutes: 15,
      timezone: "Asia/Shanghai",
    });
  });

  it("keeps custom timing opaque while editing task fields", () => {
    const custom = scheduleFixture({
      cronExpression: "*/7 * * * *",
      timezone: "UTC",
      recurrence: {
        kind: "custom",
        timezone: "UTC",
        label: "自定义重复",
      },
    });
    const form = scheduleFormFromSchedule(custom, "codex");
    const payload = buildSchedulePayload(
      { ...form, prompt: "  keep checking  " },
      custom,
    );

    expect(form.recurrenceKind).toBe("custom");
    expect(payload).toMatchObject({
      cronExpression: "*/7 * * * *",
      timezone: "UTC",
      taskTemplate: {
        prompt: "keep checking",
      },
    });
    expect("recurrence" in payload).toBe(false);
  });
});
