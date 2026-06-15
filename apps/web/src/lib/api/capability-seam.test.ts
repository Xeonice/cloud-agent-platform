/**
 * Capability SEAM dispatch test (rebuild-console-tanstack-start task 10.8,
 * contract #1, part b).
 *
 * Proves the query factories' `queryFn` is the single place real-vs-mock is
 * chosen and that it genuinely routes off the capability flag: flag=true runs
 * `real.*`, flag=false runs `mock.*`, per domain, on the SAME factory.
 *
 * Strategy: mock `./capabilities` so `isCapable` reads a mutable `flags` map we
 * flip per test, and stub `./real` + `./mock` with sentinel-returning spies so
 * we can observe WHICH side the seam dispatched to. A regression that hard-wired
 * a queryFn to one implementation would fail this — it is not a tautology.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BackendCapabilities } from "./capabilities";

// A mutable flag map the mocked `./capabilities` reads from.
const flags: Record<string, boolean> = {};

vi.mock("./capabilities", () => ({
  // `isCapable` is the only export `queries.ts` consumes; back it by `flags`.
  isCapable: (domain: string) => flags[domain] === true,
}));

// Stub both implementations with sentinels so we can assert the chosen side.
vi.mock("./real", () => ({
  listTasks: vi.fn(async () => "REAL_tasks"),
  getMetrics: vi.fn(async () => "REAL_metrics"),
  getSessionHistory: vi.fn(async () => "REAL_sessionHistory"),
  listAuditEvents: vi.fn(async () => "REAL_history"),
  getSettings: vi.fn(async () => "REAL_settings"),
  getAuthSession: vi.fn(async () => "REAL_auth"),
  listGithubRepos: vi.fn(async () => "REAL_github"),
}));

vi.mock("./mock", () => ({
  mockListTasks: vi.fn(async () => "MOCK_tasks"),
  mockMetrics: vi.fn(async () => "MOCK_metrics"),
  mockSessionHistory: vi.fn(async () => "MOCK_sessionHistory"),
  mockHistory: vi.fn(async () => "MOCK_history"),
  mockSettings: vi.fn(async () => "MOCK_settings"),
  mockAuthSession: vi.fn(async () => "MOCK_auth"),
  mockGithubRepos: vi.fn(async () => "MOCK_github"),
}));

// Import the factories + the (mocked) implementations AFTER the mocks are
// declared. `vi.mock` is hoisted, so these resolve to the stubs above.
import {
  tasksQuery,
  metricsQuery,
  sessionHistoryQuery,
  historyEventsQuery,
  settingsQuery,
  authSessionQuery,
  githubReposQuery,
} from "./queries";
import * as real from "./real";
import * as mock from "./mock";

type Spy = ReturnType<typeof vi.fn>;

interface Case {
  domain: keyof BackendCapabilities;
  factory: () => { queryFn?: unknown };
  realFn: Spy;
  mockFn: Spy;
  realValue: string;
  mockValue: string;
}

const cases: Case[] = [
  {
    domain: "tasks",
    factory: tasksQuery,
    realFn: real.listTasks as unknown as Spy,
    mockFn: mock.mockListTasks as unknown as Spy,
    realValue: "REAL_tasks",
    mockValue: "MOCK_tasks",
  },
  {
    domain: "metrics",
    factory: metricsQuery,
    realFn: real.getMetrics as unknown as Spy,
    mockFn: mock.mockMetrics as unknown as Spy,
    realValue: "REAL_metrics",
    mockValue: "MOCK_metrics",
  },
  {
    domain: "sessionHistory",
    factory: () => sessionHistoryQuery("task-x"),
    realFn: real.getSessionHistory as unknown as Spy,
    mockFn: mock.mockSessionHistory as unknown as Spy,
    realValue: "REAL_sessionHistory",
    mockValue: "MOCK_sessionHistory",
  },
  {
    domain: "history",
    factory: () => historyEventsQuery(),
    realFn: real.listAuditEvents as unknown as Spy,
    mockFn: mock.mockHistory as unknown as Spy,
    realValue: "REAL_history",
    mockValue: "MOCK_history",
  },
  {
    domain: "settings",
    factory: settingsQuery,
    realFn: real.getSettings as unknown as Spy,
    mockFn: mock.mockSettings as unknown as Spy,
    realValue: "REAL_settings",
    mockValue: "MOCK_settings",
  },
  {
    domain: "auth",
    factory: authSessionQuery,
    realFn: real.getAuthSession as unknown as Spy,
    mockFn: mock.mockAuthSession as unknown as Spy,
    realValue: "REAL_auth",
    mockValue: "MOCK_auth",
  },
  {
    domain: "githubImport",
    factory: githubReposQuery,
    realFn: real.listGithubRepos as unknown as Spy,
    mockFn: mock.mockGithubRepos as unknown as Spy,
    realValue: "REAL_github",
    mockValue: "MOCK_github",
  },
];

async function runQueryFn(
  factory: () => { queryFn?: unknown },
): Promise<unknown> {
  const opts = factory();
  const queryFn = opts.queryFn as (ctx: unknown) => unknown;
  expect(typeof queryFn).toBe("function");
  // TanStack passes a context object at call time; the factories ignore it.
  return queryFn({} as unknown);
}

describe("query factory real/mock dispatch follows the capability flag", () => {
  beforeEach(() => {
    for (const key of Object.keys(flags)) delete flags[key];
    vi.clearAllMocks();
  });

  for (const c of cases) {
    it(`${c.domain}: flag=true -> real, flag=false -> mock`, async () => {
      // flag true -> real implementation runs, mock untouched.
      flags[c.domain] = true;
      const realResult = await runQueryFn(c.factory);
      expect(realResult).toBe(c.realValue);
      expect(c.realFn).toHaveBeenCalledTimes(1);
      expect(c.mockFn).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // Flip the SAME flag false -> mock implementation runs, real untouched.
      flags[c.domain] = false;
      const mockResult = await runQueryFn(c.factory);
      expect(mockResult).toBe(c.mockValue);
      expect(c.mockFn).toHaveBeenCalledTimes(1);
      expect(c.realFn).not.toHaveBeenCalled();
    });
  }
});
