/**
 * Mock contract-validation tests (rebuild-console-tanstack-start task 10.8,
 * contract #2).
 *
 * Proves every mock data-access function returns a value that PARSES against its
 * `@cap/contracts` zod schema (or the local view type, for `mockTaskContext`).
 * This is the design's drift guard: "mocks are typed against @cap/contracts (+
 * view extensions) so they can't drift off-shape". We parse the ACTUAL runtime
 * output (not the static type) so a mock that produced an out-of-shape value at
 * runtime — e.g. a missing field or a bad enum — fails here.
 *
 * The store-backed mocks (`mockListRepos`, `mockSettings`, `mockCodexCredential`,
 * `mockAuthSession`) are read through the SSR-safe in-memory store; in the node
 * test environment with no `window` they read `DEFAULT_STATE`. We drive the
 * `githubConnected` gate explicitly so the populated `mockAuthSession` branch is
 * also validated, then reset the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ListTasksResponseSchema,
  TaskResponseSchema,
  ListReposResponseSchema,
  DefaultRepoResponseSchema,
  AuthSessionSchema,
  SessionUserSchema,
  MetricsResponseSchema,
  SessionHistorySchema,
  type SessionHistory,
  ListAuditEventsResponseSchema,
  AccountSettingsSchema,
  CodexCredentialSchema,
  ListAvailableGithubReposResponseSchema,
  UpdateStatusSchema,
  AdminAccountListResponseSchema,
  AdminAccountListItemSchema,
} from "@cap/contracts";
import {
  mockListTasks,
  mockGetTask,
  mockListRepos,
  mockGetDefaultRepo,
  mockAuthSession,
  mockMetrics,
  mockHistory,
  mockSettings,
  mockCodexCredential,
  mockGithubRepos,
  mockTaskContext,
  mockSessionHistory,
  mockUpdateStatus,
  mockListAdminAccounts,
  mockCreateAdminAccount,
  mockSetAdminAccountEnabled,
} from "./mock";
import { setState, resetState } from "../store";

// The mocks await a 120-420ms latency band; give each parse room.
const TIMEOUT = 2000;

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

describe("mock outputs validate against their @cap/contracts schema", () => {
  it(
    "mockListTasks -> ListTasksResponse",
    async () => {
      const out = await mockListTasks();
      expect(() => ListTasksResponseSchema.parse(out)).not.toThrow();
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((task) => task.sandboxProvider?.label === "BoxLite Sandbox")).toBe(true);
      expect(out.some((task) => task.sandboxProvider === null)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "mockGetTask -> TaskResponse (known and synthesized id)",
    async () => {
      const known = await mockListTasks();
      const byKnownId = await mockGetTask(known[0]!.id);
      expect(() => TaskResponseSchema.parse(byKnownId)).not.toThrow();

      // An unknown id is synthesized (the route still renders on mock); it must
      // also be a valid TaskResponse.
      const synthesized = await mockGetTask(
        "99999999-9999-4999-8999-999999999999",
      );
      expect(() => TaskResponseSchema.parse(synthesized)).not.toThrow();
    },
    TIMEOUT,
  );

  it(
    "mockListRepos -> ListReposResponse",
    async () => {
      const out = await mockListRepos();
      expect(() => ListReposResponseSchema.parse(out)).not.toThrow();
      expect(out.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "mockSessionHistory -> SessionHistory across every discriminated state",
    async () => {
      // ids bucketed by their first hex digit (see mockSessionHistory): 0→available,
      // 1→empty/no-rollout, 2→empty/agent-failed-to-start, 3→expired.
      const ids = {
        available: "00000000-0000-4000-8000-000000000000",
        noRollout: "10000000-0000-4000-8000-000000000000",
        agentFailed: "20000000-0000-4000-8000-000000000000",
        expired: "30000000-0000-4000-8000-000000000000",
      };
      const out: Record<string, unknown> = {};
      for (const [k, id] of Object.entries(ids)) out[k] = await mockSessionHistory(id);

      // Every state PARSES against the discriminated contract schema.
      for (const value of Object.values(out)) {
        expect(() => SessionHistorySchema.parse(value)).not.toThrow();
      }
      // And each id maps to its intended state (no fabricated transcript on the
      // empty/expired variants).
      expect(out.available).toMatchObject({ status: "available" });
      expect(out.noRollout).toMatchObject({ status: "empty", reason: "no-rollout" });
      expect(out.agentFailed).toMatchObject({ status: "empty", reason: "agent-failed-to-start" });
      expect(out.expired).toEqual({ status: "expired" });

      // wire-transcript-real-data — the available mock carries the enriched
      // fields the transcript timeline renders, with FIXED timestamps (visual-gate
      // determinism): a `system` milestone turn, a tool `diffstat`, per-turn `at`,
      // and meta totals — all still valid against the contract (asserted above).
      const available = out.available as Extract<SessionHistory, { status: "available" }>;
      expect(available.turns.some((t) => t.kind === "system")).toBe(true);
      expect(available.turns.every((t) => typeof t.at === "string")).toBe(true);
      const patch = available.turns.find((t) => t.kind === "tool" && t.diffstat);
      expect(patch).toBeDefined();
      expect(available.meta.totalTokens).toBeGreaterThan(0);
      expect(available.meta.durationMs).toBeGreaterThan(0);
    },
    4000,
  );

  it(
    "mockGetDefaultRepo -> DefaultRepoResponse",
    async () => {
      const out = await mockGetDefaultRepo();
      expect(() => DefaultRepoResponseSchema.parse(out)).not.toThrow();
    },
    TIMEOUT,
  );

  it(
    "mockAuthSession -> AuthSession (null when disconnected, SessionUser when connected)",
    async () => {
      // Default store: not connected -> null (still a valid AuthSession).
      const disconnected = await mockAuthSession();
      expect(() => AuthSessionSchema.parse(disconnected)).not.toThrow();
      expect(disconnected).toBeNull();

      // Drive the gate so the populated mock-user branch is validated.
      setState({ githubConnected: true });
      const connected = await mockAuthSession();
      expect(() => AuthSessionSchema.parse(connected)).not.toThrow();
      expect(connected).not.toBeNull();
      // The populated branch must satisfy the SessionUser shape specifically.
      expect(() => SessionUserSchema.parse(connected)).not.toThrow();
      expect(connected?.allowed).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "mockMetrics -> MetricsResponse",
    async () => {
      const out = await mockMetrics();
      expect(() => MetricsResponseSchema.parse(out)).not.toThrow();
    },
    TIMEOUT,
  );

  it(
    "mockListAdminAccounts -> AdminAccountListResponse, and create/disable reflect on the next read",
    async () => {
      const initial = await mockListAdminAccounts();
      expect(() => AdminAccountListResponseSchema.parse(initial)).not.toThrow();
      const count = initial.accounts.length;

      // Create reflects on the next list read and the row validates.
      const created = await mockCreateAdminAccount({
        email: "new@team.io",
        name: "New Member",
        role: "member",
        initialCredential: "password",
        password: "temp-passw0rd",
      });
      expect(() => AdminAccountListItemSchema.parse(created)).not.toThrow();
      const afterCreate = await mockListAdminAccounts();
      expect(afterCreate.accounts).toHaveLength(count + 1);

      // Disable flips `allowed` on the next read.
      const toggled = await mockSetAdminAccountEnabled(created.id, false);
      expect(toggled.allowed).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "mockMetrics per-task section stays in lockstep (ceiling 5, honest states, never zero-filled)",
    async () => {
      const out = await mockMetrics();

      // The mock default ceiling stays 5, matching the backend default
      // (`maxConcurrentTasks`: dbSetting ?? env ?? 5).
      expect(out.capacity.ceiling).toBe(5);
      expect(out.occupancy.slots).toHaveLength(5);

      const samples = out.resources.taskSamples;
      expect(samples).toBeDefined();
      const busyIds = out.occupancy.slots
        .filter((s) => s.busy && s.taskId !== null)
        .map((s) => s.taskId!);

      for (const [taskId, frame] of Object.entries(samples!)) {
        // Only busy-slot tasks are sampled — queued/non-running ids are never
        // fabricated into the section.
        expect(busyIds).toContain(taskId);
        expect(frame.sample.taskId).toBe(taskId);
        // Never zero-filled: every frame carries a real, non-zero reading.
        expect(
          frame.sample.cpuPercent > 0 || frame.sample.memoryBytes > 0,
        ).toBe(true);
      }
      for (const queued of out.occupancy.queuedTaskIds) {
        expect(samples).not.toHaveProperty(queued);
      }

      // The fixtures exercise every honest pool-panel state: the primary
      // fresh process-scope frame, the container-scope fallback, a stale
      // carried-forward frame, and a busy slot with NO frame (not-sampled —
      // rendered 未采样, never zeros).
      const frames = Object.values(samples!);
      expect(frames.some((f) => f.scope === "process" && !f.stale)).toBe(true);
      expect(frames.some((f) => f.scope === "container")).toBe(true);
      expect(frames.some((f) => f.stale)).toBe(true);
      expect(busyIds.some((id) => !(id in samples!))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "mockHistory -> ListAuditEventsResponse (unfiltered and level-filtered)",
    async () => {
      const all = await mockHistory();
      expect(() => ListAuditEventsResponseSchema.parse(all)).not.toThrow();
      expect(all.length).toBeGreaterThan(0);

      // Server-side level filter must still yield a valid (narrower) list.
      const warnings = await mockHistory({ level: "warning" });
      expect(() => ListAuditEventsResponseSchema.parse(warnings)).not.toThrow();
      expect(warnings.every((e) => e.level === "warning")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "mockSettings -> AccountSettings",
    async () => {
      const out = await mockSettings();
      expect(() => AccountSettingsSchema.parse(out)).not.toThrow();
    },
    TIMEOUT,
  );

  it(
    "mockCodexCredential -> CodexCredential (never carries a plaintext key)",
    async () => {
      const out = await mockCodexCredential();
      expect(() => CodexCredentialSchema.parse(out)).not.toThrow();
      // Defense-in-depth: the read shape must not surface a plaintext key field.
      expect(Object.keys(out)).not.toContain("apiKey");
    },
    TIMEOUT,
  );

  it(
    "mockGithubRepos -> ListAvailableGithubReposResponse",
    async () => {
      const out = await mockGithubRepos();
      expect(() =>
        ListAvailableGithubReposResponseSchema.parse(out),
      ).not.toThrow();
      expect(out.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "mockTaskContext -> TaskContextView shape (local view type)",
    async () => {
      const out = await mockTaskContext(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      // No contract schema (the backend lacks these fields today); assert the
      // local view type's required fields are present and well-typed.
      expect(typeof out.taskId).toBe("string");
      expect(typeof out.repo).toBe("string");
      expect(typeof out.branch).toBe("string");
      expect(typeof out.strategy).toBe("string");
      expect(typeof out.agent).toBe("string");
      expect(typeof out.sandboxProviderLabel).toBe("string");
      expect(typeof out.resources).toBe("string");
      expect(typeof out.safetyBoundary).toBe("string");
    },
    TIMEOUT,
  );
});

/**
 * `mockUpdateStatus` is the lone mock that is MODE-AWARE (update-availability-
 * check, integration task 4.1): with `capabilities.updateCheck` the only `false`
 * flag, normal source-build prod reads this mock, so a fabricated
 * `updateAvailable: true` would surface a dishonest banner. It therefore degrades
 * to inert by default and only surfaces an available update under the
 * `VITE_FORCE_MOCK=1` visual harness. Both branches must still PARSE against the
 * `@cap/contracts` schema (the drift guard).
 */
describe("mockUpdateStatus is mode-aware and ships inert by default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "default (no VITE_FORCE_MOCK) -> inert UpdateStatus: updateAvailable false, latest null",
    async () => {
      vi.stubEnv("VITE_FORCE_MOCK", "");
      const out = await mockUpdateStatus();
      expect(() => UpdateStatusSchema.parse(out)).not.toThrow();
      // The task-4.1 invariant: absent banner on the current source-build prod —
      // the pure selectBannerView hides on updateAvailable:false / latest null.
      expect(out.updateAvailable).toBe(false);
      expect(out.latestVersion).toBeNull();
      expect(out.releaseUrl).toBeNull();
      expect(out.releaseName).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "visual harness (VITE_FORCE_MOCK=1) -> available UpdateStatus with a release link",
    async () => {
      vi.stubEnv("VITE_FORCE_MOCK", "1");
      const out = await mockUpdateStatus();
      expect(() => UpdateStatusSchema.parse(out)).not.toThrow();
      expect(out.updateAvailable).toBe(true);
      expect(out.latestVersion).toBe("v0.4.0");
      expect(out.releaseUrl).toContain("/releases/tag/v0.4.0");
    },
    TIMEOUT,
  );
});
