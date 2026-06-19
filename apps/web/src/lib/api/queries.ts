/**
 * TanStack Query `queryOptions` factories (rebuild-console-tanstack-start D5;
 * task 10.4).
 *
 * Every page reads data EXCLUSIVELY through these factories — loaders
 * (`context.queryClient.ensureQueryData(...)`) and components (`useQuery(...)`)
 * share the SAME factory and therefore the same query key, so SSR-dehydrated
 * data hydrates straight into the component without a refetch.
 *
 * The queryFn is the SINGLE place real-vs-mock is chosen: each does
 * `if (isCapable(domain)) return real() else return mock()`. Flipping ONE
 * `BACKEND_CAPABILITIES` flag (capabilities.ts) repoints a page at the real api
 * with no other change. Query KEYS are stable across the real/mock switch so a
 * flip never orphans cached data or invalidations.
 *
 * Terminal bytes never enter Query (D5.4) — these factories cover discrete reads
 * only; raw WS frames go straight to `term.write`.
 */
import { queryOptions } from "@tanstack/react-query";
import type {
  AuditQuery,
  ListTasksResponse,
  TaskResponse,
  ListReposResponse,
  AuthSession,
  MetricsResponse,
  TaskResourceResponse,
  SessionHistory,
  CapacityMetrics,
  SlotEntry,
  TaskMetricsSample,
  ListAuditEventsResponse,
  AccountSettings,
  CodexCredential,
  ClaudeCredential,
  ListAvailableGithubReposResponse,
  UpdateStatus,
  ApiKeyListResponse,
} from "@cap/contracts";
import { isCapable } from "./capabilities";
import * as real from "./real";
import * as mock from "./mock";
import type { TaskContextView } from "./mock";
import type {
  RuntimesResponse,
  ListMcpTokensResponse,
  SendApiRequestInput,
  SendApiResult,
} from "./real";

// ---------------------------------------------------------------------------
// Query keys — stable across the real/mock switch
// ---------------------------------------------------------------------------

/**
 * The canonical query-key catalog. Centralized so mutations invalidate by the
 * exact same key the factories register under (no string drift). Keys do NOT
 * encode real-vs-mock, so flipping a capability flag re-uses the same cache
 * entry rather than orphaning it.
 */
export const queryKeys = {
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  repos: ["repos"] as const,
  defaultRepo: ["repos", "default"] as const,
  /** Per-runtime readiness for the create-task dialog selector (`GET /runtimes`). */
  runtimes: ["runtimes"] as const,
  metrics: ["metrics"] as const,
  capacity: ["metrics", "capacity"] as const,
  history: (query?: Partial<AuditQuery>) =>
    ["history", query ?? {}] as const,
  settings: ["settings"] as const,
  /** The operator's API keys (`GET /api-keys`, api-key-machine-identity). */
  apiKeys: ["api-keys"] as const,
  codexCredential: ["settings", "codex"] as const,
  claudeCredential: ["settings", "claude"] as const,
  /**
   * The compatible-provider model-discovery probe (`POST /settings/codex/models`,
   * wire-compatible-provider-execution). There is no discovery READ — the probe is
   * a one-shot action validating an operator-supplied `{baseUrl, apiKey}` whose
   * result populates the dialog's model picker transiently and is never cached as a
   * persistent read. This key exists only so the mutation has a stable, centralized
   * handle alongside `codexCredential` (mirroring the no-string-drift discipline of
   * the other keys); it is keyed by the probed Base URL so distinct candidates do
   * not collide.
   */
  codexModels: (baseUrl: string) =>
    ["settings", "codex", "models", baseUrl] as const,
  authSession: ["auth", "session"] as const,
  githubRepos: ["github", "repos"] as const,
  taskContext: (id: string) => ["tasks", id, "context"] as const,
  taskResource: (id: string) => ["tasks", id, "resource"] as const,
  sessionHistory: (id: string) => ["tasks", id, "session-history"] as const,
  updateStatus: ["update-status"] as const,
  /** The operator's MCP tokens (`GET /mcp-tokens`, remote-mcp-server). */
  mcpTokens: ["mcp-tokens"] as const,
  /** The system-wide `mcpServerEnabled` flag (`GET /settings/mcp-server`). */
  mcpServerEnabled: ["settings", "mcp-server"] as const,
  /**
   * The self-update action (self-update-action). There is no self-update READ —
   * the upgrade is a one-shot `POST /self-update` whose target comes from
   * `updateStatus`. This key exists only so the mutation's invalidation has a
   * stable, centralized handle alongside the cross-checked `updateStatus` it also
   * refreshes (mirroring the no-string-drift discipline of the other keys).
   */
  selfUpdate: ["self-update"] as const,
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** The fleet task list. Polls every 5s for live status (D5; prototype cadence). */
export function tasksQuery() {
  return queryOptions<ListTasksResponse>({
    queryKey: queryKeys.tasks,
    queryFn: () => (isCapable("tasks") ? real.listTasks() : mock.mockListTasks()),
    refetchInterval: 5000,
  });
}

/** A single task (session page). */
export function taskQuery(id: string) {
  return queryOptions<TaskResponse>({
    queryKey: queryKeys.task(id),
    queryFn: () => (isCapable("tasks") ? real.getTask(id) : mock.mockGetTask(id)),
  });
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/** Registered platform repos (new-task form, workspace cards, repositories page). */
export function reposQuery() {
  return queryOptions<ListReposResponse>({
    queryKey: queryKeys.repos,
    queryFn: () => (isCapable("repos") ? real.listRepos() : mock.mockListRepos()),
  });
}

/**
 * Per-runtime readiness (`GET /runtimes`, add-claude-code-runtime) backing the
 * create-task dialog's runtime selector: it gates each runtime option on a
 * booleans-only readiness read so an unconfigured runtime is shown disabled with a
 * configure hint instead of being selectable and failing at launch (frontend-console
 * spec "Create-task dialog offers a runtime selector gated on readiness").
 *
 * Rides the standard real/mock seam gated by `createTask` (runtime readiness is part
 * of the task-creation domain — when the create endpoint is real this readiness read
 * is too); otherwise the mode-aware `mockRuntimes` keeps the dialog rendering. The
 * read is cheap and config-stable, so it polls only modestly and re-checks on focus
 * so a freshly-configured token surfaces without a reload.
 */
export function runtimesQuery() {
  return queryOptions<RuntimesResponse>({
    queryKey: queryKeys.runtimes,
    queryFn: () =>
      isCapable("createTask") ? real.getRuntimes() : mock.mockRuntimes(),
    refetchOnWindowFocus: true,
    staleTime: 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Metrics (one `/metrics` payload; `capacityQuery` projects the derived block)
// ---------------------------------------------------------------------------

/** The full `/metrics` payload (capacity + occupancy + sampled CPU/memory). */
export function metricsQuery() {
  return queryOptions<MetricsResponse>({
    queryKey: queryKeys.metrics,
    queryFn: () => (isCapable("metrics") ? real.getMetrics() : mock.mockMetrics()),
    refetchInterval: 5000,
  });
}

/**
 * A single task's own sampled CPU/memory (`GET /tasks/:id/metrics`), real-time
 * from the latest sampler snapshot. Returns a `sampled` state (carrying the
 * reading) or `not-running` (no live container) so the session page renders the
 * task's resources or "未运行/未采样" honestly. Polls at the metrics cadence;
 * callers enable it only while the session page is mounted.
 */
export function taskResourceQuery(id: string) {
  return queryOptions<TaskResourceResponse>({
    queryKey: queryKeys.taskResource(id),
    queryFn: () =>
      isCapable("metrics") ? real.getTaskResource(id) : mock.mockTaskResource(id),
    refetchInterval: 5000,
  });
}

/**
 * The read-only codex transcript of a FINISHED task (session-sandbox-retention),
 * for the session page's replay region. A static read (NO `refetchInterval`): a
 * settled task's transcript is frozen. Real-vs-mock is the only switch — gated by
 * `sessionHistory`, mirroring the `taskResource` seam.
 */
export function sessionHistoryQuery(id: string) {
  return queryOptions<SessionHistory>({
    queryKey: queryKeys.sessionHistory(id),
    queryFn: () =>
      isCapable("sessionHistory")
        ? real.getSessionHistory(id)
        : mock.mockSessionHistory(id),
  });
}

/**
 * Just the exact, semaphore-derived capacity scalars, projected from the same
 * `/metrics` source via `select` so the workspace stat-tiles don't re-fetch a
 * second payload — one network read, two views.
 */
export function capacityQuery() {
  return queryOptions<MetricsResponse, Error, CapacityMetrics>({
    queryKey: queryKeys.metrics,
    queryFn: () => (isCapable("metrics") ? real.getMetrics() : mock.mockMetrics()),
    refetchInterval: 5000,
    select: (data) => data.capacity,
  });
}

/**
 * The capacity-modern pool panel's view of the ONE `/metrics` payload
 * (console-design-pixel-merge D1/D2): live ceiling + occupancy scalars for the
 * pool-hero ("N/M 在线" computed client-side, never the design's 7/10 sample),
 * the exactly-`ceiling`-many slot entries the numbered slot grid sizes to, the
 * FIFO queue, and the per-task latest frames the per-runner resource rows read.
 */
export interface PoolPanelMetrics {
  /** Live configured slot ceiling (`capacity.ceiling`). */
  ceiling: number;
  /** Active running-task count — the pool-hero's "N" of "N/M 在线". */
  active: number;
  /** Free slots (`ceiling - active`). */
  free: number;
  /** Queue depth (equals `queuedTaskIds.length`). */
  queueDepth: number;
  /** Exactly `ceiling`-many slot entries (busy(taskId) | idle) for the grid. */
  slots: SlotEntry[];
  /** Queued task ids in FIFO order. */
  queuedTaskIds: string[];
  /**
   * Per-task LATEST frames keyed by `taskId` (scope/stale-honest, server-
   * computed percentages). A busy slot whose task is absent here renders the
   * explicit 未运行/未采样 state — never fabricated zeros. `{}` when the
   * sampled block carries no section.
   */
  taskSamples: Record<string, TaskMetricsSample>;
}

/**
 * Module-scoped (stable-identity) select so TanStack Query memoizes the
 * projection — the pool panel re-renders only when the `/metrics` data
 * actually changes, not on every component render.
 */
const selectPoolPanel = (data: MetricsResponse): PoolPanelMetrics => ({
  ceiling: data.capacity.ceiling,
  active: data.capacity.active,
  free: data.capacity.free,
  queueDepth: data.capacity.queueDepth,
  slots: data.occupancy.slots,
  queuedTaskIds: data.occupancy.queuedTaskIds,
  taskSamples: data.resources.taskSamples ?? {},
});

/**
 * The pool-panel projection of the SAME `/metrics` poll (same key, same 5s
 * cadence as {@link metricsQuery}/{@link capacityQuery}) via `select` — one
 * network read feeds the hero, slot grid, pool-lane, and per-runner rows. The
 * per-runner repo/title/status legs come from the separately-cached
 * `tasksQuery` via a client-side join in the panel (design D2) — deliberately
 * NOT folded in here so the metrics cache never carries task presentation
 * fields. No per-task `GET /tasks/:taskId/metrics` fan-out, no SSE.
 */
export function poolPanelQuery() {
  return queryOptions<MetricsResponse, Error, PoolPanelMetrics>({
    queryKey: queryKeys.metrics,
    queryFn: () => (isCapable("metrics") ? real.getMetrics() : mock.mockMetrics()),
    refetchInterval: 5000,
    select: selectPoolPanel,
  });
}

// ---------------------------------------------------------------------------
// History (audit timeline) — server-side filters are part of the key
// ---------------------------------------------------------------------------

/**
 * Recent audit events, most-recent-first. The optional `query` carries the
 * SERVER-side `level`/`status`/`limit` filters and is part of the key so each
 * filter combination caches separately. The live in-page search + segmented
 * filter is a SEPARATE client-only view concern (`use-client-filter`) that never
 * touches the cache.
 */
export function historyEventsQuery(query?: Partial<AuditQuery>) {
  return queryOptions<ListAuditEventsResponse>({
    queryKey: queryKeys.history(query),
    queryFn: () =>
      isCapable("history") ? real.listAuditEvents(query) : mock.mockHistory(query),
  });
}

// ---------------------------------------------------------------------------
// Settings + Codex credential
// ---------------------------------------------------------------------------

/** Account preferences (read-only identity + editable draft). */
export function settingsQuery() {
  return queryOptions<AccountSettings>({
    queryKey: queryKeys.settings,
    queryFn: () => (isCapable("settings") ? real.getSettings() : mock.mockSettings()),
  });
}

/** The Codex execution credential state (never the plaintext key). */
export function codexCredentialQuery() {
  return queryOptions<CodexCredential>({
    queryKey: queryKeys.codexCredential,
    queryFn: () =>
      isCapable("settings")
        ? real.getCodexCredential()
        : mock.mockCodexCredential(),
  });
}

export function claudeCredentialQuery() {
  return queryOptions<ClaudeCredential>({
    queryKey: queryKeys.claudeCredential,
    queryFn: () =>
      isCapable("settings")
        ? real.getClaudeCredential()
        : mock.mockClaudeCredential(),
  });
}

/**
 * The operator's API keys (`GET /api-keys`, api-key-machine-identity). Rides the
 * standard real/mock seam gated by `apiKeys`: the real session-gated endpoint
 * when capable, the typed in-memory mock otherwise. The settings "API Keys" card
 * reads this; the mint/revoke mutations invalidate `queryKeys.apiKeys` so the
 * list re-derives.
 */
export function apiKeysQuery() {
  return queryOptions<ApiKeyListResponse>({
    queryKey: queryKeys.apiKeys,
    queryFn: () =>
      isCapable("apiKeys") ? real.listApiKeys() : mock.mockListApiKeys(),
  });
}

// ---------------------------------------------------------------------------
// Auth session
// ---------------------------------------------------------------------------

/**
 * The current OAuth session identity (or `null`). When `auth` is off this reads
 * the mock allowlisted `tanghehui` session driven by the local gate; when on it
 * reads `GET /auth/session`. `staleTime: 0` so the gate re-checks promptly.
 */
export function authSessionQuery() {
  return queryOptions<AuthSession>({
    queryKey: queryKeys.authSession,
    queryFn: () =>
      isCapable("auth") ? real.getAuthSession() : mock.mockAuthSession(),
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// GitHub import + task context
// ---------------------------------------------------------------------------

/** The operator's importable GitHub repositories (the "仓库导入" dialog list). */
export function githubReposQuery() {
  return queryOptions<ListAvailableGithubReposResponse>({
    queryKey: queryKeys.githubRepos,
    queryFn: () =>
      isCapable("githubImport") ? real.listGithubRepos() : mock.mockGithubRepos(),
  });
}

/**
 * The session task-context strip (repo#branch / agent / runtime / safety
 * boundary). Mock until `capabilities.branches` flips; when on, branch/strategy
 * are read back from the real task (the rest of the context view stays mock
 * until runner metadata is persisted).
 */
export function taskContextQuery(id: string) {
  return queryOptions<TaskContextView>({
    queryKey: queryKeys.taskContext(id),
    queryFn: async () => {
      const ctx = await mock.mockTaskContext(id);
      if (!isCapable("tasks")) return ctx;
      // Bind to REAL data: the repo name from the task's repoId, branch/strategy
      // from the task. agent/runtime/resources have NO backend field yet, so
      // downgrade them to honest placeholders instead of the mock's fabricated
      // "gpt-5-codex / 2 vCPU·4 GiB" (D5.5 — never render an unsent field). The
      // sandbox IS AIO Sandbox (the provider), so that one is a truthful label.
      const task = await real.getTask(id);
      const repos = await real.listRepos();
      const repo = repos.find((r) => r.id === task.repoId);
      const repoName = repo
        ? (repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? repo.name)
        : ctx.repo;
      return {
        ...ctx,
        repo: repoName,
        branch: task.branch ?? ctx.branch,
        strategy: task.strategy ?? ctx.strategy,
        agent: "Codex",
        runtime: "AIO Sandbox",
        resources: "—",
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Update status (update-availability-check, Phase 2)
// ---------------------------------------------------------------------------

/**
 * The cached, server-side update check (`GET /update-status`,
 * update-availability-check D4) the app-shell banner reads. Rides the standard
 * real/mock seam: gated by `BACKEND_CAPABILITIES.updateCheck`, it reads
 * `real.getUpdateStatus` (Zod `.parse` against the `@cap/contracts`
 * `UpdateStatusSchema`) when capable and the typed `mock.mockUpdateStatus`
 * otherwise — so the banner renders on the mock until the live endpoint is
 * verified, then ONE flag flip repoints it. The api already caches the upstream
 * GitHub fetch (one per TTL across all browsers), so this is a plain read with
 * no client-side poll.
 */
export function updateStatusQuery() {
  return queryOptions<UpdateStatus>({
    queryKey: queryKeys.updateStatus,
    queryFn: () =>
      isCapable("updateCheck") ? real.getUpdateStatus() : mock.mockUpdateStatus(),
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

// ---------------------------------------------------------------------------
// MCP server (remote-mcp-server) — tokens + enable flag
// ---------------------------------------------------------------------------

/**
 * The operator's MCP tokens (`GET /mcp-tokens`) backing the settings MCP-server
 * card's list. Rides the standard real/mock seam gated by `mcpServer`: the mock
 * `mockMcpTokens` exercises the mint/list/revoke loop today; flipping the flag
 * repoints it at the real endpoint with no card change. The list is non-secret
 * (prefix + last4 only) — the raw token is never part of any read.
 */
export function mcpTokensQuery() {
  return queryOptions<ListMcpTokensResponse>({
    queryKey: queryKeys.mcpTokens,
    queryFn: () =>
      isCapable("mcpServer") ? real.listMcpTokens() : mock.mockListMcpTokens(),
  });
}

/**
 * The system-wide `mcpServerEnabled` flag (`GET /settings/mcp-server`) the card's
 * toggle reflects. READ is open to any authenticated operator (so the card
 * renders the honest state); the WRITE is admin-gated server-side. Rides the same
 * `mcpServer` seam as {@link mcpTokensQuery}.
 */
export function mcpServerEnabledQuery() {
  return queryOptions<boolean>({
    queryKey: queryKeys.mcpServerEnabled,
    queryFn: () =>
      isCapable("mcpServer")
        ? real.getMcpServerEnabled()
        : mock.mockMcpServerEnabled(),
  });
}

// ---------------------------------------------------------------------------
// API Playground runner (add-api-playground D3) — REAL-only, no cached read
// ---------------------------------------------------------------------------

/**
 * The capability-gated API Playground runner (the seam for `real.sendApiRequest`).
 * Unlike the read factories above this is an IMPERATIVE ACTION — a one-shot send,
 * not a cached `queryOptions` read — so it is a plain async function the page
 * calls on 发送 (via a mutation/handler in the page-and-stream track), NOT a
 * query key.
 *
 * It is the ONLY domain that is REAL-ONLY: there is NO mock branch. When the
 * `apiPlayground` capability is on the send executes for real against the running
 * api (signed by the operator's console session). When it is off — mock /
 * backend-less / the `VITE_FORCE_MOCK` visual harness — a send is NOT fabricated
 * (a playground that "sent" against a mock would be misleading, D3); instead it
 * resolves to a clear "needs the running api" `kind: "error"` result so the
 * response panel renders an honest needs-the-api state rather than a fake 200.
 */
export function runApiRequest(input: SendApiRequestInput): Promise<SendApiResult> {
  if (!isCapable("apiPlayground")) {
    return Promise.resolve({
      kind: "error",
      message:
        "API 调试需要连接到正在运行的后端：当前为本地 mock 模式（VITE_FORCE_MOCK 或后端不可用），发送已被禁用。",
      durationMs: 0,
    });
  }
  return real.sendApiRequest(input);
}
