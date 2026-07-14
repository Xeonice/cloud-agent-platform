import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type {
  CreateScheduleRequest,
  ScheduleResponse,
  ScheduleRunResponse,
  UpdateScheduleRequest,
} from "@cap/contracts";

vi.mock("./real", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  },
  runtimeModelErrorFromApiError: vi.fn((error: unknown) => {
    if (!error || typeof error !== "object" || !("body" in error)) return null;
    const body = (error as { body?: { code?: string } }).body;
    return body?.code === "runtime_model_not_available" ||
      body?.code === "runtime_model_catalog_unavailable"
      ? body
      : null;
  }),
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
  dispatchSchedule: vi.fn(async (id) => scheduleFixture(id)),
  deleteSchedule: vi.fn(async () => undefined),
  listScheduleRuns: vi.fn(async (id) => [runFixture("run-a", id)]),
}));

vi.mock("./mock", () => ({}));

import {
  createTaskMutation,
  createScheduleMutation,
  deleteScheduleMutation,
  dispatchScheduleMutation,
  pauseScheduleMutation,
  resumeScheduleMutation,
  updateScheduleMutation,
} from "./mutations";
import { queryKeys, scheduleRunsQuery, schedulesQuery } from "./queries";
import * as real from "./real";

type Spy = ReturnType<typeof vi.fn>;

function queryClientStub() {
  return {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  } as unknown as QueryClient & { setQueryData: Spy; invalidateQueries: Spy };
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
    currentPeriod: {
      key: "day:2026-07-10",
      scheduledFor: new Date("2026-07-10T09:00:00.000Z"),
      run: null,
    },
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
    periodKey: "day:2026-07-10",
    triggerSource: "automatic",
    triggeredAt: new Date("2026-07-10T09:00:00.000Z"),
    status: "created",
    taskId: uuid(31),
    taskStatus: "running",
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
      name: "Hourly review",
      recurrence: {
        kind: "hourly",
        minuteOfHour: 17,
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

  it("update, pause, resume, dispatch, and delete refresh affected schedule reads", async () => {
    const client = queryClientStub();
    const scheduleId = uuid(1);
    const updateBody: UpdateScheduleRequest = {
      recurrence: {
        kind: "minuteInterval",
        intervalMinutes: 15,
        timezone: "Asia/Shanghai",
      },
    };

    const updateOptions = updateScheduleMutation(client);
    await updateOptions.mutationFn!(
      { id: scheduleId, body: updateBody },
      {} as never,
    );
    updateOptions.onSuccess?.(
      scheduleFixture(scheduleId, { id: scheduleId }),
      { id: scheduleId, body: updateBody },
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

    const dispatchOptions = dispatchScheduleMutation(client);
    const dispatchVariables = {
      id: scheduleId,
      expectedPeriodKey: "day:2026-07-10",
    };
    await dispatchOptions.mutationFn!(dispatchVariables, {} as never);
    dispatchOptions.onSuccess?.(
      scheduleFixture(scheduleId, { id: scheduleId }),
      dispatchVariables,
      undefined,
      {} as never,
    );

    const deleteOptions = deleteScheduleMutation(client);
    await deleteOptions.mutationFn!(scheduleId, {} as never);
    deleteOptions.onSuccess?.(undefined, scheduleId, undefined, {} as never);

    expect(real.updateSchedule).toHaveBeenCalledWith(scheduleId, updateBody);
    expect(real.pauseSchedule).toHaveBeenCalledWith(scheduleId);
    expect(real.resumeSchedule).toHaveBeenCalledWith(scheduleId);
    expect(real.dispatchSchedule).toHaveBeenCalledWith(
      scheduleId,
      dispatchVariables.expectedPeriodKey,
    );
    expect(real.deleteSchedule).toHaveBeenCalledWith(scheduleId);

    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData).toHaveBeenCalledWith(
      queryKeys.schedules,
      expect.any(Function),
    );

    expect(client.invalidateQueries).toHaveBeenCalledTimes(11);
    for (let index = 1; index <= 6; index += 2) {
      expect(client.invalidateQueries).toHaveBeenNthCalledWith(index, {
        queryKey: queryKeys.schedules,
      });
      expect(client.invalidateQueries).toHaveBeenNthCalledWith(index + 1, {
        queryKey: queryKeys.scheduleRuns(scheduleId),
      });
    }
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(7, {
      queryKey: queryKeys.schedules,
      exact: true,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(8, {
      queryKey: queryKeys.scheduleRuns(scheduleId),
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(9, {
      queryKey: queryKeys.tasks,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(10, {
      queryKey: queryKeys.schedules,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(11, {
      queryKey: queryKeys.scheduleRuns(scheduleId),
    });
  });

  it("dispatch immediately replaces the matching schedule cache before revalidation", () => {
    const client = queryClientStub();
    const scheduleId = uuid(1);
    const otherSchedule = scheduleFixture(uuid(2), { id: uuid(2) });
    const previous = scheduleFixture(scheduleId, {
      nextRunAt: new Date("2026-07-10T09:00:00.000Z"),
    });
    const dispatched = scheduleFixture(scheduleId, {
      nextRunAt: new Date("2026-07-10T10:00:00.000Z"),
      updatedAt: new Date("2026-07-10T09:00:01.000Z"),
    });
    const options = dispatchScheduleMutation(client);

    options.onSuccess?.(
      dispatched,
      { id: scheduleId, expectedPeriodKey: undefined },
      undefined,
      {} as never,
    );

    const updateCache = client.setQueryData.mock.calls[0]?.[1] as
      | ((current: ScheduleResponse[] | undefined) => ScheduleResponse[] | undefined)
      | undefined;
    expect(updateCache).toBeTypeOf("function");
    expect(updateCache?.([previous, otherSchedule])).toEqual([
      dispatched,
      otherSchedule,
    ]);
    expect(updateCache?.(undefined)).toBeUndefined();
    expect(client.setQueryData.mock.invocationCallOrder[0]).toBeLessThan(
      client.invalidateQueries.mock.invocationCallOrder[0]!,
    );
  });

  it("refreshes schedule state after a period conflict but not a generic failure", async () => {
    const client = queryClientStub();
    const scheduleId = uuid(1);
    const variables = { id: scheduleId, expectedPeriodKey: "day:2026-07-10" };
    const options = dispatchScheduleMutation(client);

    await options.onError?.(
      new real.ApiError(409, "schedule_period_changed"),
      variables,
      undefined,
      {} as never,
    );
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.schedules,
      exact: true,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: queryKeys.scheduleRuns(scheduleId),
    });

    client.invalidateQueries.mockClear();
    await options.onError?.(
      new real.ApiError(500, "server error"),
      variables,
      undefined,
      {} as never,
    );
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("refreshes model catalogs after task or schedule model-domain rejection only", async () => {
    const client = queryClientStub();
    const domainError = new real.ApiError(422, "model unavailable", {
      code: "runtime_model_not_available",
      message: "The requested runtime model is not available.",
      retryable: false,
      context: { runtime: "codex", model: "fixture/stale-model" },
    });
    const mutations = [
      createTaskMutation(client),
      createScheduleMutation(client),
      updateScheduleMutation(client),
    ];

    for (const options of mutations) {
      await options.onError?.(
        domainError,
        undefined as never,
        undefined,
        {} as never,
      );
    }
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
    for (const call of client.invalidateQueries.mock.calls) {
      expect(call[0]).toEqual({ queryKey: queryKeys.runtimeModels });
    }

    client.invalidateQueries.mockClear();
    for (const options of mutations) {
      await options.onError?.(
        new real.ApiError(500, "server error"),
        undefined as never,
        undefined,
        {} as never,
      );
    }
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });
});
