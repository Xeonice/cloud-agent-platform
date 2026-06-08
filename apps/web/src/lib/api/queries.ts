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
  CapacityMetrics,
  ListAuditEventsResponse,
  AccountSettings,
  CodexCredential,
  ListAvailableGithubReposResponse,
} from "@cap/contracts";
import { isCapable } from "./capabilities";
import * as real from "./real";
import * as mock from "./mock";
import type { TaskContextView } from "./mock";

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
  metrics: ["metrics"] as const,
  capacity: ["metrics", "capacity"] as const,
  history: (query?: Partial<AuditQuery>) =>
    ["history", query ?? {}] as const,
  settings: ["settings"] as const,
  codexCredential: ["settings", "codex"] as const,
  authSession: ["auth", "session"] as const,
  githubRepos: ["github", "repos"] as const,
  taskContext: (id: string) => ["tasks", id, "context"] as const,
  taskResource: (id: string) => ["tasks", id, "resource"] as const,
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
