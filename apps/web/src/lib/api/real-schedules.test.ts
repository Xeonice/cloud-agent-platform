import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import { dispatchSchedule } from "./real";

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
        headers: { "Content-Type": "application/json" },
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
    expect(init?.headers).toEqual({});
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
