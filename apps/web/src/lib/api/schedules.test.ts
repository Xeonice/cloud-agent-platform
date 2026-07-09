import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type {
  CreateScheduleRequest,
  ScheduleResponse,
  ScheduleRunResponse,
} from "@cap/contracts";

vi.mock("./real", () => ({
  listSchedules: vi.fn(async () => [scheduleFixture("schedule-a")]),
  createSchedule: vi.fn(async (body) =>
    scheduleFixture("schedule-created", {
      taskTemplate: normalizedScheduleTaskTemplate(body.taskTemplate),
    }),
  ),
  updateSchedule: vi.fn(async (id, body) =>
    scheduleFixture(id, { name: body.name ?? "updated" }),
  ),
  pauseSchedule: vi.fn(async (id) => scheduleFixture(id, { enabled: false })),
  resumeSchedule: vi.fn(async (id) => scheduleFixture(id, { enabled: true })),
  deleteSchedule: vi.fn(async () => undefined),
  listScheduleRuns: vi.fn(async (id) => [runFixture("run-a", id)]),
}));

vi.mock("./mock", () => ({}));

import {
  createScheduleMutation,
  deleteScheduleMutation,
  pauseScheduleMutation,
  resumeScheduleMutation,
  updateScheduleMutation,
} from "./mutations";
import { queryKeys, scheduleRunsQuery, schedulesQuery } from "./queries";
import * as real from "./real";

type Spy = ReturnType<typeof vi.fn>;

function queryClientStub() {
  return {
    invalidateQueries: vi.fn(),
  } as unknown as QueryClient & { invalidateQueries: Spy };
}

async function runQueryFn(factory: () => { queryFn?: unknown }): Promise<unknown> {
  const opts = factory();
  const queryFn = opts.queryFn as (ctx: unknown) => unknown;
  expect(typeof queryFn).toBe("function");
  return queryFn({} as unknown);
}

function scheduleFixture(
  id: string,
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  const scheduleId = id === "schedule-created" ? uuid(11) : uuid(1);
  return {
    id: scheduleId,
    ownerUserId: "user-1",
    repoId: uuid(2),
    name: "Daily check",
    cronExpression: "0 9 * * 1-5",
    timezone: "UTC",
    recurrence: {
      kind: "weekdays",
      time: "09:00",
      timezone: "UTC",
      label: "工作日 09:00",
    },
    enabled: true,
    nextRunAt: new Date("2026-07-10T09:00:00.000Z"),
    overlapPolicy: "skip",
    misfirePolicy: "fire-once",
    taskTemplate: {
      repoId: uuid(2),
      prompt: "run checks",
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

function runFixture(id: string, scheduleId: string): ScheduleRunResponse {
  return {
    id: id === "run-a" ? uuid(21) : uuid(22),
    scheduleId,
    scheduledFor: new Date("2026-07-10T09:00:00.000Z"),
    status: "created",
    taskId: uuid(31),
    error: null,
    createdAt: new Date("2026-07-10T09:00:00.000Z"),
    updatedAt: new Date("2026-07-10T09:00:01.000Z"),
  };
}

function normalizedScheduleTaskTemplate(
  input: CreateScheduleRequest["taskTemplate"],
): ScheduleResponse["taskTemplate"] {
  return {
    repoId: input.repoId,
    prompt: input.prompt,
    runtime: input.runtime ?? "codex",
    sandboxEnvironmentId: input.sandboxEnvironmentId ?? null,
    deliver: input.deliver ?? "none",
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: input.idleTimeoutMs }
      : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
  };
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("schedule queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses stable schedule list and run-list keys backed by the real API", async () => {
    expect(schedulesQuery().queryKey).toEqual(queryKeys.schedules);
    await expect(runQueryFn(schedulesQuery)).resolves.toHaveLength(1);
    expect(real.listSchedules).toHaveBeenCalledTimes(1);

    const scheduleId = uuid(1);
    expect(scheduleRunsQuery(scheduleId).queryKey).toEqual(
      queryKeys.scheduleRuns(scheduleId),
    );
    await expect(
      runQueryFn(() => scheduleRunsQuery(scheduleId)),
    ).resolves.toHaveLength(1);
    expect(real.listScheduleRuns).toHaveBeenCalledWith(scheduleId);
  });
});

describe("schedule mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create sends the schedule payload and invalidates the schedule list", async () => {
    const client = queryClientStub();
    const body = {
      name: "Workday review",
      recurrence: {
        kind: "weekdays",
        time: "08:30",
        timezone: "Asia/Shanghai",
      },
      overlapPolicy: "enqueue",
      misfirePolicy: "fire-once",
      taskTemplate: {
        repoId: uuid(2),
        prompt: "check nightly drift",
        runtime: "claude-code",
        sandboxEnvironmentId: uuid(5),
        deliver: "pr",
        skills: ["browser"],
        idleTimeoutMs: 900_000,
        deadlineMs: 3_600_000,
      },
    } as unknown as CreateScheduleRequest;
    const options = createScheduleMutation(client);

    await options.mutationFn!(body, {} as never);
    options.onSuccess?.(
      scheduleFixture("schedule-created", {
        taskTemplate: normalizedScheduleTaskTemplate(body.taskTemplate),
      }),
      body,
      undefined,
      {} as never,
    );

    expect(real.createSchedule).toHaveBeenCalledWith(body);
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.schedules,
    });
  });

  it("update, pause, resume, and delete refresh list plus the affected run ledger", async () => {
    const client = queryClientStub();
    const scheduleId = uuid(1);

    const updateOptions = updateScheduleMutation(client);
    await updateOptions.mutationFn!(
      { id: scheduleId, body: { name: "updated" } },
      {} as never,
    );
    updateOptions.onSuccess?.(
      scheduleFixture(scheduleId, { id: scheduleId }),
      { id: scheduleId, body: { name: "updated" } },
      undefined,
      {} as never,
    );

    const pauseOptions = pauseScheduleMutation(client);
    await pauseOptions.mutationFn!(scheduleId, {} as never);
    pauseOptions.onSuccess?.(
      scheduleFixture(scheduleId, { id: scheduleId, enabled: false }),
      scheduleId,
      undefined,
      {} as never,
    );

    const resumeOptions = resumeScheduleMutation(client);
    await resumeOptions.mutationFn!(scheduleId, {} as never);
    resumeOptions.onSuccess?.(
      scheduleFixture(scheduleId, { id: scheduleId, enabled: true }),
      scheduleId,
      undefined,
      {} as never,
    );

    const deleteOptions = deleteScheduleMutation(client);
    await deleteOptions.mutationFn!(scheduleId, {} as never);
    deleteOptions.onSuccess?.(undefined, scheduleId, undefined, {} as never);

    expect(real.updateSchedule).toHaveBeenCalledWith(scheduleId, { name: "updated" });
    expect(real.pauseSchedule).toHaveBeenCalledWith(scheduleId);
    expect(real.resumeSchedule).toHaveBeenCalledWith(scheduleId);
    expect(real.deleteSchedule).toHaveBeenCalledWith(scheduleId);

    expect(client.invalidateQueries).toHaveBeenCalledTimes(8);
    for (let index = 1; index <= 8; index += 2) {
      expect(client.invalidateQueries).toHaveBeenNthCalledWith(index, {
        queryKey: queryKeys.schedules,
      });
      expect(client.invalidateQueries).toHaveBeenNthCalledWith(index + 1, {
        queryKey: queryKeys.scheduleRuns(scheduleId),
      });
    }
  });
});
