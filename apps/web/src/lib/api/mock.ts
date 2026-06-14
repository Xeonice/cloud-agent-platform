/**
 * Typed mock data-access layer (rebuild-console-tanstack-start D5.1; task 10.3).
 *
 * Every mock here returns a value shaped by `@cap/contracts` (extended with a
 * local VIEW type only where the backend genuinely lacks a field today), so the
 * mocks can never drift off-shape from the real responses — the same risk
 * mitigation the design calls out ("mocks are typed against @cap/contracts (+
 * view extensions) so they can't drift off-shape"). Each mock awaits a uniform
 * {@link delay} (120–420ms) to mimic the prototype's `setTimeout` cadence so the
 * console's loading/skeleton states exercise realistically on mock.
 *
 * Writable UI slices (imported repos, default repo, settings, Codex credential)
 * are read THROUGH the persisted store (`../store`), so a mutation that writes
 * the store and invalidates a query causes the mock read to reflect the change —
 * reproducing the prototype's read-state/render loop.
 */
import type {
  ListTasksResponse,
  TaskResponse,
  ListReposResponse,
  AuthSession,
  MetricsResponse,
  TaskMetricsSample,
  TaskResourceResponse,
  ListAuditEventsResponse,
  AuditEvent,
  AuditQuery,
  AccountSettings,
  CodexCredential,
  ListAvailableGithubReposResponse,
  DefaultRepoResponse,
  Repo,
} from "@cap/contracts";
import { getState } from "../store";
import { ALLOWED_ACCOUNT } from "../mock-session";

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/** Uniform mock latency in the prototype's 120–420ms band. */
export function delay(ms = 120 + Math.floor(Math.random() * 300)): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Local VIEW types (only for fields the backend genuinely lacks on a read)
// ---------------------------------------------------------------------------

/**
 * The session task-context strip ("任务目标 / 运行环境 / 安全边界") shows
 * repo#branch / agent / runtime / safety-boundary metadata the `Task` model
 * does not persist today (D5.5). This local view type extends the persisted
 * task fields with the prototype's mock context; once `branches`/runner
 * metadata land, branch/strategy come from the real task and this collapses.
 */
export interface TaskContextView {
  /** The owning task id. */
  taskId: string;
  /** `owner/name` repo display, mock until the task read carries repo identity. */
  repo: string;
  /** Branch the run targets — REAL once `capabilities.branches` flips. */
  branch: string;
  /** Execution strategy — REAL once `capabilities.branches` flips. */
  strategy: string;
  /** The agent/model label (mock). */
  agent: string;
  /** Runtime/runner environment label (mock). */
  runtime: string;
  /** vCPU / memory sizing line (mock). */
  resources: string;
  /** Safety/write boundary copy shown in the 安全边界 card (mock). */
  safetyBoundary: string;
}

// ---------------------------------------------------------------------------
// Fixtures (stable ids so deep-links and dedup behave deterministically)
// ---------------------------------------------------------------------------

const REPO_IDS = {
  console: "11111111-1111-4111-8111-111111111111",
  api: "22222222-2222-4222-8222-222222222222",
  runner: "33333333-3333-4333-8333-333333333333",
  infra: "44444444-4444-4444-8444-444444444444",
} as const;

const TASK_IDS = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  d: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  e: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;

const USER = { githubId: 4_829_173, login: ALLOWED_ACCOUNT } as const;

const now = () => new Date();
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

// ---------------------------------------------------------------------------
// Tasks (these four also have REAL endpoints; mock is the fallback shape)
// ---------------------------------------------------------------------------

const MOCK_TASKS: ListTasksResponse = [
  {
    id: TASK_IDS.a,
    repoId: REPO_IDS.console,
    prompt: "迁移 console 至 TanStack Start 并补齐数据层",
    status: "running",
    createdAt: minsAgo(8),
    branch: "aio-execution-hardening",
    strategy: "single-pass",
  },
  {
    id: TASK_IDS.b,
    repoId: REPO_IDS.api,
    prompt: "为 /metrics 增加 docker-stats 采样",
    status: "queued",
    createdAt: minsAgo(21),
    branch: "main",
    strategy: "review-then-apply",
  },
  {
    id: TASK_IDS.c,
    repoId: REPO_IDS.runner,
    prompt: "修复 runner 拨回握手在断线后的重连",
    status: "completed",
    createdAt: minsAgo(94),
    branch: "fix/dialback-reconnect",
    strategy: "single-pass",
  },
  {
    id: TASK_IDS.d,
    repoId: REPO_IDS.console,
    prompt: "实现历史页审计时间线筛选",
    status: "awaiting_input",
    createdAt: minsAgo(36),
    branch: "feat/history-filter",
    strategy: "single-pass",
  },
  {
    id: TASK_IDS.e,
    repoId: REPO_IDS.infra,
    prompt: "收紧 AIO 镜像体积并补充 e2e 守卫",
    status: "failed",
    createdAt: minsAgo(180),
    branch: "main",
    strategy: "review-then-apply",
  },
];

export async function mockListTasks(): Promise<ListTasksResponse> {
  await delay();
  return MOCK_TASKS.map((t) => ({ ...t }));
}

export async function mockGetTask(id: string): Promise<TaskResponse> {
  await delay();
  const found = MOCK_TASKS.find((t) => t.id === id);
  // Synthesize a plausible task for an unknown id so the session route still
  // renders on mock; the real path 404s via ApiError.
  return found
    ? { ...found }
    : {
        id,
        repoId: REPO_IDS.console,
        prompt: "会话回放（mock）",
        status: "running",
        createdAt: now(),
        branch: "main",
        strategy: "single-pass",
      };
}

// ---------------------------------------------------------------------------
// Repos (REAL endpoint exists; mock seeds the imported list + GitHub fixtures)
// ---------------------------------------------------------------------------

const SEED_REPOS: ListReposResponse = [
  {
    id: REPO_IDS.console,
    name: "cloud-agent-platform",
    gitSource: "git@github.com:tanghehui/cloud-agent-platform.git",
    createdAt: minsAgo(60 * 24 * 9),
    description: "Backend-first cloud agent control plane",
    defaultBranch: "main",
    branchCount: 7,
    updatedAt: minsAgo(40),
    githubId: "778899001",
    isDefault: true,
  },
  {
    id: REPO_IDS.api,
    name: "agent-api",
    gitSource: "git@github.com:tanghehui/agent-api.git",
    createdAt: minsAgo(60 * 24 * 30),
    description: "NestJS orchestrator + guardrails",
    defaultBranch: "main",
    branchCount: 3,
    updatedAt: minsAgo(60 * 5),
    githubId: "778899002",
    isDefault: false,
  },
];

/**
 * The platform repo list: the seeded fixtures merged with any repos the operator
 * imported into the local store this session, de-duplicated by id. Reflects
 * `setDefaultRepoMutation` by marking the selected repo `isDefault`.
 */
export async function mockListRepos(): Promise<ListReposResponse> {
  await delay();
  return buildRepoList();
}

export async function mockGetDefaultRepo(): Promise<DefaultRepoResponse> {
  await delay();
  const def = buildRepoList().find((r) => r.isDefault) ?? null;
  return { repo: def };
}

/**
 * Build the merged repo list (seed fixtures ∪ locally-imported repos), without
 * the artificial delay. Marks the store's `selectedRepo` as `isDefault` so
 * `setDefaultRepoMutation` is reflected; PURE w.r.t. the network.
 */
function buildRepoList(): ListReposResponse {
  const { importedRepos, selectedRepo } = getState();
  const seen = new Set(SEED_REPOS.map((r) => r.id));
  const merged: Repo[] = SEED_REPOS.map((r) => ({ ...r }));
  for (const imp of importedRepos) {
    if (seen.has(imp.id)) continue;
    seen.add(imp.id);
    merged.push({
      id: imp.id,
      name: imp.name,
      gitSource: `git@github.com:${imp.fullName}.git`,
      createdAt: now(),
      description: imp.description ?? null,
      defaultBranch: imp.defaultBranch,
      branchCount: null,
      updatedAt: now(),
      githubId: null,
      isDefault: false,
    });
  }
  return selectedRepo
    ? merged.map((r) => ({ ...r, isDefault: r.id === selectedRepo }))
    : merged;
}

// ---------------------------------------------------------------------------
// Auth — session + allowlist (allowlisted account `tanghehui`)
// ---------------------------------------------------------------------------

/**
 * The mock OAuth session: an allowlisted `tanghehui` identity when the local
 * gate is connected, else `null` (the login gate). The session is gated on the
 * persisted `githubConnected` flag so the mock login/logout flow drives it.
 */
export async function mockAuthSession(): Promise<AuthSession> {
  await delay();
  const { githubConnected } = getState();
  if (!githubConnected) return null;
  return {
    githubId: USER.githubId,
    login: USER.login,
    name: "Tang Hehui",
    avatarUrl: `https://avatars.githubusercontent.com/u/${USER.githubId}?v=4`,
    allowed: true,
  };
}

// ---------------------------------------------------------------------------
// Metrics — RUNNERS 4/5, QUEUE 11, CPU 42 / mem 64, 5-slot table
// ---------------------------------------------------------------------------

/**
 * Mock slot ceiling, aligned to the REAL backend default of 5
 * (`maxConcurrentTasks`: dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5), so the
 * mock and real capacity renders agree (configurable-task-slots).
 */
const CEILING = 5;
const ACTIVE = 4;
const QUEUE_DEPTH = 11;

/**
 * The full `/metrics` payload: semaphore-derived capacity + a 5-slot occupancy
 * table (4 busy / 1 idle, ceiling aligned to the backend default 5) + a sampled
 * CPU/memory block at 42% / 64% (QUEUE 11, CPU 42% 内存 64%).
 *
 * In lockstep with the real `/metrics` (console-design-pixel-merge), the
 * sampled block carries the per-task process-scope section
 * (`resources.taskSamples`, latest frame ONLY, keyed by `taskId`). The
 * fixtures deliberately exercise every HONEST state the pool panel must
 * render — never zero-filled:
 *  - slot 0's task: the normal PRIMARY reading (`scope: 'process'`, codex's
 *    own subtree), fresh;
 *  - slot 1's task: the `scope: 'container'` FALLBACK (in-sandbox process
 *    reading unavailable);
 *  - slot 2's task: a carried-forward frame past a missed tick
 *    (`stale: true`, `ageMs` beyond the cadence);
 *  - slot 3's task: ABSENT from the section (the not-sampled leg — a busy
 *    slot with no frame renders 未采样, not fabricated zeros).
 * Queued ids never appear in the section (queued tasks are not sampled).
 */
export async function mockMetrics(): Promise<MetricsResponse> {
  await delay();
  const busyTaskIds = [
    TASK_IDS.a,
    TASK_IDS.b,
    TASK_IDS.c,
    TASK_IDS.d,
    "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
    "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
    "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
  ];
  const slots = Array.from({ length: CEILING }, (_, slot) => {
    const busy = slot < ACTIVE;
    return {
      slot,
      busy,
      taskId: busy ? (busyTaskIds[slot] ?? null) : null,
    };
  });
  const queuedTaskIds = Array.from(
    { length: QUEUE_DEPTH },
    (_, i) => `queued-${i + 1}`,
  );
  // 42% of 10 cores ≈ 4.2 cores; memory 64% of an 8GiB host roll-up.
  const memLimit = 8 * 1024 * 1024 * 1024;
  const memUsed = Math.round(memLimit * 0.64);
  // Per-task frames (see the doc comment): each busy slot gets a 2GiB cgroup
  // limit; codex's process subtree sits well below the container aggregate.
  const perTaskLimit = Math.round(memLimit / ACTIVE);
  const codexMem = 126 * 1024 * 1024;
  const pct = (bytes: number) =>
    Number(((bytes / perTaskLimit) * 100).toFixed(1));
  const taskSamples: Record<string, TaskMetricsSample> = {
    // Slot 0 — the normal PRIMARY reading: codex's own process subtree, fresh.
    [busyTaskIds[0]!]: {
      scope: "process",
      sample: {
        taskId: busyTaskIds[0]!,
        cpuPercent: 23.4,
        memoryBytes: codexMem,
        memoryLimitBytes: perTaskLimit,
        memoryPercent: pct(codexMem),
      },
      sampledAt: new Date(Date.now() - 2_000),
      ageMs: 2_000,
      stale: false,
    },
    // Slot 1 — container-scope FALLBACK: the in-sandbox process reading was
    // unavailable, so the frame carries the container aggregate instead.
    [busyTaskIds[1]!]: {
      scope: "container",
      sample: {
        taskId: busyTaskIds[1]!,
        cpuPercent: 34,
        memoryBytes: Math.round(perTaskLimit * 0.46),
        memoryLimitBytes: perTaskLimit,
        memoryPercent: 46,
      },
      sampledAt: new Date(Date.now() - 2_000),
      ageMs: 2_000,
      stale: false,
    },
    // Slot 2 — carried forward past a missed sampling tick: the prior frame
    // surfaces with `stale: true` and an age beyond the 5s cadence.
    [busyTaskIds[2]!]: {
      scope: "process",
      sample: {
        taskId: busyTaskIds[2]!,
        cpuPercent: 11.2,
        memoryBytes: 96 * 1024 * 1024,
        memoryLimitBytes: perTaskLimit,
        memoryPercent: pct(96 * 1024 * 1024),
      },
      sampledAt: new Date(Date.now() - 14_000),
      ageMs: 14_000,
      stale: true,
    },
    // Slot 3's task is deliberately ABSENT — the honest not-sampled leg.
  };
  return {
    capacity: {
      ceiling: CEILING,
      active: ACTIVE,
      free: CEILING - ACTIVE,
      queueDepth: QUEUE_DEPTH,
    },
    occupancy: { slots, queuedTaskIds },
    runnerMinutes: { available: true, minutes: 1287.5 },
    resources: {
      status: "available",
      sampledAt: new Date(Date.now() - 2_000),
      ageMs: 2_000,
      hasActiveContainers: true,
      containers: busyTaskIds.slice(0, ACTIVE).map((taskId, i) => ({
        taskId,
        cpuPercent: 30 + i * 4,
        memoryBytes: Math.round(memUsed / ACTIVE),
        memoryLimitBytes: Math.round(memLimit / ACTIVE),
        memoryPercent: 58 + i,
      })),
      aggregateCpuPercent: 42,
      aggregateMemoryBytes: memUsed,
      taskSamples,
    },
  };
}

/**
 * A single task's own sampled CPU/memory (mirrors `GET /tasks/:id/metrics`).
 * A known busy task returns a `sampled` reading; any other id returns
 * `not-running` so the not-running UI path is exercisable in mock mode too.
 */
export async function mockTaskResource(id: string): Promise<TaskResourceResponse> {
  await delay();
  const busy: string[] = [TASK_IDS.a, TASK_IDS.b, TASK_IDS.c, TASK_IDS.d];
  if (!busy.includes(id)) {
    return { state: "not-running" };
  }
  const memLimit = 2 * 1024 * 1024 * 1024;
  const containerMem = Math.round(memLimit * 0.46);
  const codexMem = 126 * 1024 * 1024; // codex process subtree RSS (primary)
  return {
    state: "sampled",
    // codex's OWN process figure is the PRIMARY reading; the whole-container total
    // (dominated by the sandbox's resident services) is carried as background.
    scope: "process",
    sample: {
      taskId: id,
      cpuPercent: 37.5,
      memoryBytes: codexMem,
      memoryLimitBytes: memLimit,
      memoryPercent: Number(((codexMem / memLimit) * 100).toFixed(1)),
    },
    container: {
      taskId: id,
      cpuPercent: 40,
      memoryBytes: containerMem,
      memoryLimitBytes: memLimit,
      memoryPercent: 46,
    },
    sampledAt: new Date(Date.now() - 2_000),
    ageMs: 2_000,
  };
}

// ---------------------------------------------------------------------------
// History — audit events + result codes + durations
// ---------------------------------------------------------------------------

const MOCK_EVENTS: AuditEvent[] = [
  {
    id: "e1111111-1111-4111-8111-111111111111",
    taskId: TASK_IDS.a,
    userId: USER.githubId,
    type: "task.created",
    level: "info",
    title: "创建任务",
    description: "在 cloud-agent-platform#aio-execution-hardening 上派发任务",
    timestamp: minsAgo(8),
    resultCode: 201,
    runId: "run-a-001",
  },
  {
    id: "e2222222-2222-4222-8222-222222222222",
    taskId: TASK_IDS.a,
    userId: USER.githubId,
    type: "task.running",
    level: "info",
    title: "任务开始运行",
    description: "已分配运行槽位，沙箱已就绪",
    timestamp: minsAgo(7),
    resultCode: 200,
    runId: "run-a-001",
  },
  {
    id: "e3333333-3333-4333-8333-333333333333",
    taskId: TASK_IDS.b,
    userId: USER.githubId,
    type: "task.queued",
    level: "warning",
    title: "任务进入队列",
    description: "并发信号量已满（5/5），任务排队等待空闲槽位",
    timestamp: minsAgo(21),
    resultCode: 409,
    runId: "run-b-001",
  },
  {
    id: "e4444444-4444-4444-8444-444444444444",
    taskId: TASK_IDS.d,
    userId: USER.githubId,
    type: "approval.requested",
    level: "warning",
    title: "等待审批",
    description: "Codex 请求执行 shell 命令，等待操作员决策",
    timestamp: minsAgo(35),
    resultCode: 422,
    runId: "run-d-001",
  },
  {
    id: "e5555555-5555-4555-8555-555555555555",
    taskId: TASK_IDS.c,
    userId: USER.githubId,
    type: "task.completed",
    level: "info",
    title: "任务完成",
    description: "runner 拨回重连修复已通过，耗时 4m12s",
    timestamp: minsAgo(90),
    resultCode: 200,
    runId: "run-c-001",
  },
  {
    id: "e6666666-6666-4666-8666-666666666666",
    taskId: TASK_IDS.e,
    userId: USER.githubId,
    type: "force_failed",
    level: "error",
    title: "任务被强制失败",
    description: "超过墙钟截止时间（deadline），已回收槽位，耗时 30m00s",
    timestamp: minsAgo(178),
    resultCode: 409,
    runId: "run-e-001",
  },
];

/**
 * The audit/history event stream, most-recent-first. Honors the server-side
 * `level`/`status`-shaped `limit` filters the real endpoint accepts; the
 * `status` filter is a no-op here (mock events do not carry a task status) and
 * the live client-side search/segmented filter is a separate view concern
 * (`use-client-filter`).
 */
export async function mockHistory(
  query?: Partial<AuditQuery>,
): Promise<ListAuditEventsResponse> {
  await delay();
  let events = [...MOCK_EVENTS].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );
  if (query?.level) events = events.filter((e) => e.level === query.level);
  if (query?.limit != null) events = events.slice(0, query.limit);
  return events;
}

// ---------------------------------------------------------------------------
// Settings — allowedAccount / retention / writeConfirm + Codex credential state
// ---------------------------------------------------------------------------

/** Account preferences: read-only allowlisted identity + the editable draft. */
export async function mockSettings(): Promise<AccountSettings> {
  await delay();
  const { settings } = getState();
  // Built as a variable so the system-level `maxConcurrentTasks` (store-backed,
  // default 5 — aligned to the real backend default) rides the read shape.
  const result = {
    allowedAccount: ALLOWED_ACCOUNT,
    defaultRepoId: settings.defaultRepoId,
    retention: settings.retention,
    writeConfirm: settings.writeConfirm,
    maxConcurrentTasks: settings.maxConcurrentTasks,
  };
  return result;
}

/** The Codex execution credential state (never a plaintext key). */
export async function mockCodexCredential(): Promise<CodexCredential> {
  await delay();
  const { codexCredential } = getState();
  return { ...codexCredential };
}

// ---------------------------------------------------------------------------
// GitHub import — USER_REPOSITORIES (4 repos + metadata)
// ---------------------------------------------------------------------------

/**
 * The operator's importable GitHub repositories (the "仓库导入" dialog list),
 * sourced live from GitHub `GET /user/repos` in the real path. Four fixtures
 * with full metadata; the real token never reaches the browser.
 */
export async function mockGithubRepos(): Promise<ListAvailableGithubReposResponse> {
  await delay();
  return [
    {
      id: 778_899_001,
      full_name: "tanghehui/cloud-agent-platform",
      name: "cloud-agent-platform",
      defaultBranch: "main",
      visibility: "private",
      description: "Backend-first cloud agent control plane",
    },
    {
      id: 778_899_002,
      full_name: "tanghehui/agent-api",
      name: "agent-api",
      defaultBranch: "main",
      visibility: "private",
      description: "NestJS orchestrator + guardrails",
    },
    {
      id: 778_899_003,
      full_name: "tanghehui/agent-runner",
      name: "agent-runner",
      defaultBranch: "main",
      visibility: "public",
      description: "Sandbox runner + dial-back handshake",
    },
    {
      id: 778_899_004,
      full_name: "tanghehui/design-prototype",
      name: "design-prototype",
      defaultBranch: "main",
      visibility: "private",
      description: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Task contexts — taskId → repo#branch / agent / runtime / safety boundary
// ---------------------------------------------------------------------------

const SAFETY =
  "破坏性写入需操作员确认；容器即信任边界，沙箱内执行不二次门禁。";

const MOCK_TASK_CONTEXTS: Record<string, TaskContextView> = {
  [TASK_IDS.a]: {
    taskId: TASK_IDS.a,
    repo: "tanghehui/cloud-agent-platform",
    branch: "aio-execution-hardening",
    strategy: "single-pass",
    agent: "Codex (gpt-5-codex)",
    runtime: "AIO Sandbox",
    resources: "4 vCPU · 8 GiB",
    safetyBoundary: SAFETY,
  },
  [TASK_IDS.b]: {
    taskId: TASK_IDS.b,
    repo: "tanghehui/agent-api",
    branch: "main",
    strategy: "review-then-apply",
    agent: "Codex (gpt-5-codex)",
    runtime: "AIO Sandbox",
    resources: "2 vCPU · 4 GiB",
    safetyBoundary: SAFETY,
  },
};

/**
 * The session task-context strip data. Falls back to a synthesized context for
 * an unknown id so the session route always renders on mock. Once
 * `capabilities.branches` flips, branch/strategy here are replaced by the real
 * task read (closing the "sendable but unreadable" trap).
 */
export async function mockTaskContext(taskId: string): Promise<TaskContextView> {
  await delay();
  return (
    MOCK_TASK_CONTEXTS[taskId] ?? {
      taskId,
      repo: "tanghehui/cloud-agent-platform",
      branch: "main",
      strategy: "single-pass",
      agent: "Codex (gpt-5-codex)",
      runtime: "AIO Sandbox",
      resources: "2 vCPU · 4 GiB",
      safetyBoundary: SAFETY,
    }
  );
}
