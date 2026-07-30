import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  // The console reports which release it was built from on every call; a mock
  // that omits it makes the module look like it lost an export.
  buildId: () => "test-build",
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import { dispatchSchedule, listSchedules } from "./real";

const SCHEDULE_ID = "00000000-0000-4000-8000-000000000001";
const REPO_ID = "00000000-0000-4000-8000-000000000002";
const PERIOD_KEY = "day:2026-07-10";

const SCHEDULE_RESPONSE = {
  id: SCHEDULE_ID,
  ownerUserId: "user-1",
  repoId: REPO_ID,
  name: "Daily check",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  recurrence: {
    kind: "daily",
    time: "09:00",
    timezone: "UTC",
    label: "每天 09:00",
  },
  enabled: true,
  nextRunAt: "2026-07-11T09:00:00.000Z",
  overlapPolicy: "skip",
  misfirePolicy: "fire-once",
  taskTemplate: {
    repoId: REPO_ID,
    prompt: "run checks",
    runtime: "codex",
    sandboxEnvironmentId: null,
    deliver: "none",
  },
  latestRun: null,
  currentPeriod: {
    key: PERIOD_KEY,
    scheduledFor: "2026-07-10T09:00:00.000Z",
    run: null,
  },
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchSchedule", () => {
  it("binds immediate execution to the observed current period", async () => {
    const fetchMock = stubScheduleResponse();

    await dispatchSchedule(SCHEDULE_ID, PERIOD_KEY);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/schedules/${SCHEDULE_ID}/dispatch`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expectedPeriodKey: PERIOD_KEY }),
      }),
    );
  });

  it("keeps the legacy no-body request when currentPeriod is unavailable", async () => {
    const fetchMock = stubScheduleResponse();

    await dispatchSchedule(SCHEDULE_ID);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    // What this case is actually about: no body means no Content-Type. It used to
    // assert the header set was EMPTY, which pinned the absence of every header
    // rather than the one that matters — so adding the console's build identity to
    // every call broke it while changing nothing it was written to protect.
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });
});

describe("schedule response parsing", () => {
  it("preserves structured hourly and fixed-interval recurrence responses", async () => {
    const hourly = {
      ...SCHEDULE_RESPONSE,
      name: "Hourly check",
      cronExpression: "17 * * * *",
      recurrence: {
        kind: "hourly",
        minuteOfHour: 17,
        timezone: "Asia/Shanghai",
        label: "每小时第 17 分钟",
      },
      timezone: "Asia/Shanghai",
      nextRunAt: "2026-07-10T01:17:00.000Z",
      currentPeriod: {
        key: "cron:2026-07-10T00:17:00.000Z",
        scheduledFor: "2026-07-10T00:17:00.000Z",
        run: null,
      },
    };
    const minuteInterval = {
      ...SCHEDULE_RESPONSE,
      id: "00000000-0000-4000-8000-000000000003",
      name: "Quarter-hour check",
      cronExpression: "*/15 * * * *",
      recurrence: {
        kind: "minuteInterval",
        intervalMinutes: 15,
        timezone: "UTC",
        label: "每 15 分钟",
      },
      nextRunAt: "2026-07-10T00:30:00.000Z",
      currentPeriod: {
        key: "cron:2026-07-10T00:15:00.000Z",
        scheduledFor: "2026-07-10T00:15:00.000Z",
        run: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([hourly, minuteInterval]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const schedules = await listSchedules();

    expect(schedules.map((schedule) => schedule.recurrence)).toEqual([
      hourly.recurrence,
      minuteInterval.recurrence,
    ]);
    expect(schedules[0]?.nextRunAt).toBeInstanceOf(Date);
    expect(schedules[1]?.currentPeriod?.scheduledFor).toBeInstanceOf(Date);
  });
});

function stubScheduleResponse() {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(SCHEDULE_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
