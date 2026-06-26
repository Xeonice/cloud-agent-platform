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
  SessionHistory,
  SessionTurn,
  TaskMetricsSample,
  TaskResourceResponse,
  ListAuditEventsResponse,
  AuditEvent,
  AuditQuery,
  AccountSettings,
  ClaudeCredential,
  CodexCredential,
  ListAvailableGithubReposResponse,
  DefaultRepoResponse,
  Repo,
  UpdateStatus,
  ApiKeyListItem,
  ApiKeyMintRequest,
  ApiKeyMintResponse,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  AdminAccountListItem,
  AdminAccountListResponse,
  AdminCreateAccountRequest,
  Role,
} from "@cap/contracts";
import { getState } from "../store";
import { ALLOWED_ACCOUNT } from "../mock-session";
import { forceMock } from "./capabilities";
import type {
  SelfUpdateRequest,
  SelfUpdateAck,
  RuntimesResponse,
  ListMcpTokensResponse,
  McpTokenSummary,
  MintMcpTokenRequest,
  MintMcpTokenResponse,
  SmtpConfigRead,
  SaveSmtpConfigRequest,
  TestSmtpConfigRequest,
  TestSmtpConfigResponse,
} from "./real";

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
    executionMode: "interactive-pty",
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
    // headless-task-conversation-view: a running headless task exercises the
    // conversation-not-terminal branch in the console.
    executionMode: "headless-exec",
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
// Auth — mock local-account session (`tanghehui`)
// ---------------------------------------------------------------------------

/**
 * The mock local-account session: a `tanghehui` identity when the local gate is
 * connected, else `null` (the login gate). The session is gated on the persisted
 * `githubConnected` flag so the mock login/logout flow drives it.
 */
export async function mockAuthSession(): Promise<AuthSession> {
  await delay();
  const { githubConnected } = getState();
  if (!githubConnected) return null;
  return {
    id: "u_mock_operator",
    githubId: USER.githubId,
    login: USER.login,
    name: "Tang Hehui",
    avatarUrl: `https://avatars.githubusercontent.com/u/${USER.githubId}?v=4`,
    allowed: true,
    // The lone mock operator is the admin (design posture; matches useIsAdmin's
    // mock branch) and never has a pending forced change.
    role: "admin",
    mustChangePassword: false,
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
// Session history — read-only codex transcript replay (session-sandbox-retention)
// ---------------------------------------------------------------------------

/**
 * Build a representative parsed-transcript `available` history. Carries the
 * wire-transcript-real-data fields the dedicated transcript timeline renders —
 * per-turn `at`, an audit-sourced `system` milestone turn, an `apply_patch`
 * diffstat, and meta totals — all with FIXED timestamps so the visual gate stays
 * deterministic (mirrors what the api's audit-merge would produce).
 */
function availableSessionHistory(
  id: string,
  variant: "completed" | "failed",
): SessionHistory {
  const turns: SessionTurn[] = [
    {
      kind: "system",
      title: "任务创建",
      detail: "cloud-agent-platform · aio-execution-hardening",
      level: "info",
      at: "2026-06-12T09:30:00Z",
    },
    { kind: "user", text: "修复登录页在移动端的样式错位问题", at: "2026-06-12T09:30:05Z" },
    {
      kind: "assistant",
      text: "我先查看登录页的样式与结构，定位错位的根因，再做最小修改。",
      isFinalAnswer: false,
      at: "2026-06-12T09:30:10Z",
    },
    {
      kind: "tool",
      name: "exec_command",
      args: '{"cmd":"sed -n \'1,80p\' src/routes/login.tsx"}',
      output:
        "export function Login() {\n  return (\n    <div className=\"login\">…</div>\n  );\n}",
      tokenCount: 1280,
      at: "2026-06-12T09:30:20Z",
    },
    {
      kind: "tool",
      name: "apply_patch",
      args: "*** Update File: src/routes/login.css\n@@\n-  display: block;\n+  display: flex;",
      output: "Success. Updated src/routes/login.css (1 hunk).",
      tokenCount: 642,
      diffstat: { add: 1, del: 1 },
      at: "2026-06-12T09:30:35Z",
    },
  ];
  if (variant === "completed") {
    turns.push(
      {
        kind: "assistant",
        text: "已修复：登录容器改为 flex 居中并约束最大宽度，移动端不再错位。",
        isFinalAnswer: true,
        at: "2026-06-12T09:31:00Z",
      },
      {
        kind: "system",
        title: "任务完成",
        detail: "耗时 1m 05s",
        level: "info",
        at: "2026-06-12T09:31:05Z",
      },
    );
  }
  // variant "failed": the transcript ends at the interruption (no final answer).
  return {
    status: "available",
    turns,
    meta: {
      taskId: id,
      model: "gpt-5-codex",
      cwd: "/home/gem/workspace",
      startedAt: "2026-06-12T09:30:00Z",
      totalTokens: 1922,
      durationMs: variant === "completed" ? 65000 : 35000,
    },
    // Neither mock terminal task (completed / failed) is an operator-cancelled
    // mid-run interruption, so the wire indication is false here.
    isInterrupted: false,
  };
}

/**
 * The read-only codex transcript of a FINISHED task (mirrors
 * `GET /tasks/:id/session-history`). The two real terminal mock tasks render a
 * transcript; otherwise a deterministic bucket (by the id's first hex digit)
 * makes EVERY discriminated state — available / empty(no-rollout) /
 * empty(agent-failed-to-start) / expired — previewable under `VITE_FORCE_MOCK`.
 */
export async function mockSessionHistory(id: string): Promise<SessionHistory> {
  await delay();
  if (id === TASK_IDS.c) return availableSessionHistory(id, "completed");
  if (id === TASK_IDS.e) return availableSessionHistory(id, "failed");
  const firstHex = id.replace(/[^0-9a-f]/gi, "").charAt(0) || "0";
  switch (parseInt(firstHex, 16) % 4) {
    case 1:
      return { status: "empty", reason: "no-rollout" };
    case 2:
      return { status: "empty", reason: "agent-failed-to-start" };
    case 3:
      return { status: "expired" };
    default:
      return availableSessionHistory(id, "completed");
  }
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
// Settings — account display / retention / writeConfirm + Codex credential state
// ---------------------------------------------------------------------------

/** Account preferences: read-only account identity + the editable draft. */
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

/** The Claude Code execution credential state (never a plaintext secret). */
export async function mockClaudeCredential(): Promise<ClaudeCredential> {
  await delay();
  const { claudeCredential } = getState();
  return { ...claudeCredential };
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

// ---------------------------------------------------------------------------
// Update status (update-availability-check, Phase 2)
// ---------------------------------------------------------------------------

/**
 * The typed `UpdateStatus` mock (update-availability-check D4), shaped by
 * `@cap/contracts` `UpdateStatus` so it cannot drift off the real response.
 *
 * It is MODE-AWARE so the change ships INERT on the current source-build prod
 * (integration task 4.1) while still exercising the banner under the visual
 * harness (design D4):
 *  - In the deterministic visual-harness data mode (`VITE_FORCE_MOCK=1`), it
 *    returns an AVAILABLE update so the dismissible app-shell banner renders on
 *    the seam — exercising the "newer version + release link" presentation and
 *    per-version dismissal — with a FIXED `checkedAt` (not `Date.now()`) so the
 *    snapshot data stays stable across renders.
 *  - In normal source-build prod the only mock-read of this domain happens
 *    because `capabilities.updateCheck` is the lone `false` flag (every other
 *    domain is real). There a fabricated "update available" banner would be
 *    dishonest, so the mock degrades to `updateAvailable: false` (latest null) —
 *    the banner is absent until the live `GET /update-status` is verified and the
 *    flag flips to `true`, repointing this read at the real api.
 */
export async function mockUpdateStatus(): Promise<UpdateStatus> {
  await delay();
  if (!forceMock()) {
    // Normal source-build prod: honestly inert — no fabricated prompt (task 4.1).
    return {
      currentVersion: "v0.3.0",
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt: "2026-06-17T00:00:00.000Z",
    };
  }
  // Visual harness only: surface an available update so the banner is exercised.
  return {
    currentVersion: "v0.3.0",
    latestVersion: "v0.4.0",
    updateAvailable: true,
    releaseUrl:
      "https://github.com/Xeonice/cloud-agent-platform/releases/tag/v0.4.0",
    releaseName: "v0.4.0",
    checkedAt: "2026-06-17T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Runtime readiness (add-claude-code-runtime) — create-dialog selector gate
// ---------------------------------------------------------------------------

/**
 * The typed `/runtimes` readiness mock (agent-runtime spec "Runtime readiness
 * endpoint"), shaped by the local `RuntimesResponse` web type so it cannot drift
 * off the real response. Booleans only — never a token.
 *
 * It is MODE-AWARE, mirroring `mockUpdateStatus`:
 *  - In the deterministic visual harness (`VITE_FORCE_MOCK=1`), BOTH runtimes
 *    report ready so the dialog's runtime selector renders fully enabled — the
 *    "operator selects an available runtime" presentation is exercised on the seam.
 *  - In any other mock read, `claude-code` reports NOT ready (no token configured
 *    off the real api) so the dialog honestly shows the Claude option disabled with
 *    a configure hint and keeps `codex` as the selectable default — never falsely
 *    offering an unconfigured runtime that would fail at launch.
 */
export async function mockRuntimes(): Promise<RuntimesResponse> {
  await delay();
  if (!forceMock()) {
    // Honest default: codex ready, claude-code not configured off the real api.
    return [
      { id: "codex", ready: true },
      { id: "claude-code", ready: false },
    ];
  }
  // Visual harness only: both ready so the enabled-selector path is previewable.
  return [
    { id: "codex", ready: true },
    { id: "claude-code", ready: true },
  ];
}

// ---------------------------------------------------------------------------
// Self-update (self-update-action, Phase 3)
// ---------------------------------------------------------------------------

/**
 * The mock `POST /self-update` ack (mirrors `real.postSelfUpdate`). Used only
 * under the visual harness / when `BACKEND_CAPABILITIES.selfUpdate` is off —
 * which is the SHIPPED posture, where the upgrade action is absent entirely, so
 * in normal prod this is never reached. It simply echoes "update started" for the
 * requested target so the banner's "updating… reconnecting" state is previewable
 * without performing (or faking) a real recreate. The local ack shape is owned by
 * `real.ts` (no `@cap/contracts` schema — see the tasks NOTE).
 */
export async function mockPostSelfUpdate(
  body: SelfUpdateRequest,
): Promise<SelfUpdateAck> {
  await delay();
  return { started: true, target: body.target };
}

// ---------------------------------------------------------------------------
// MCP server (remote-mcp-server) — tokens + enable flag
//
// The mock layer is the SERVER stand-in, so it is the legitimate place the raw
// `mcp_…` token is fabricated (mirroring how the real api mints one): the card
// reads it back ONLY from the mint reply (`mockMintMcpToken`), never client-side.
// State is module-scoped here (the mock layer already owns its fixtures, and the
// persisted UI store is out of this seam's scope) so a mint/revoke reflects on
// the next `mockListMcpTokens` read — reproducing the read-state/render loop.
// `revokedAt` is set (idempotently) rather than the row being dropped, so the
// list keeps surfacing the revoked credential's lifecycle state like the real one.
// ---------------------------------------------------------------------------

/** The in-memory mock MCP-token set (non-secret rows only — never a raw token). */
let mockMcpTokenStore: McpTokenSummary[] = [];
/** The system-wide `mcpServerEnabled` flag, mocked default false (spec D5). */
let mockMcpServerEnabledFlag = false;
/** Monotonic counter so distinct mints get distinct ids/suffixes deterministically. */
let mockMcpTokenSeq = 0;

/**
 * Fabricate a raw `mcp_…` token + its non-secret projection, the way the real
 * api mint would. The raw body is random per call; the `last4`/`prefix` are
 * derived from it so the show-once dialog and the subsequent list row agree.
 */
function fabricateMcpToken(
  body: MintMcpTokenRequest,
): MintMcpTokenResponse {
  mockMcpTokenSeq += 1;
  // A random url-safe body (the `mcp_` prefix is the credential family marker).
  const randomBody = Array.from({ length: 36 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".charAt(
      Math.floor(Math.random() * 64),
    ),
  ).join("");
  const raw = `mcp_${randomBody}`;
  const id = `mcp-${mockMcpTokenSeq.toString(16).padStart(8, "0")}`;
  return {
    token: raw,
    id,
    name: body.name,
    scopes: [...body.scopes],
    prefix: "mcp_",
    last4: raw.slice(-4),
    lastUsedAt: null,
    expiresAt: body.expiresAt ?? null,
    revokedAt: null,
  };
}

/** `GET /mcp-tokens` (mock) — the non-secret list, newest first. */
export async function mockListMcpTokens(): Promise<ListMcpTokensResponse> {
  await delay();
  return [...mockMcpTokenStore].reverse();
}

/**
 * `POST /mcp-tokens` (mock) — mint a token. Returns the show-once reply (raw
 * `mcp_…` token present once); stores only the non-secret projection so the raw
 * value is never re-fetchable, exactly like the real api.
 */
export async function mockMintMcpToken(
  body: MintMcpTokenRequest,
): Promise<MintMcpTokenResponse> {
  await delay();
  const minted = fabricateMcpToken(body);
  // Persist only the non-secret projection (drop the raw `token`).
  const { token: _raw, ...summary } = minted;
  void _raw;
  mockMcpTokenStore = [...mockMcpTokenStore, summary];
  return minted;
}

/** `DELETE /mcp-tokens/:id` (mock) — idempotent revoke (sets `revokedAt`). */
export async function mockRevokeMcpToken(id: string): Promise<void> {
  await delay();
  mockMcpTokenStore = mockMcpTokenStore.map((t) =>
    t.id === id && !t.revokedAt
      ? { ...t, revokedAt: new Date().toISOString() }
      : t,
  );
}

/** `GET /settings/mcp-server` (mock) — the current enable flag. */
export async function mockMcpServerEnabled(): Promise<boolean> {
  await delay();
  return mockMcpServerEnabledFlag;
}

/** `PUT /settings/mcp-server` (mock) — flip the enable flag. */
export async function mockSetMcpServerEnabled(
  enabled: boolean,
): Promise<boolean> {
  await delay();
  mockMcpServerEnabledFlag = enabled;
  return mockMcpServerEnabledFlag;
}

/** Test-only reset of the mock MCP state (no production caller). */
export function __resetMockMcpState(): void {
  mockMcpTokenStore = [];
  mockMcpServerEnabledFlag = false;
  mockMcpTokenSeq = 0;
}

// ---------------------------------------------------------------------------
// API keys (api-key-machine-identity) — typed in-memory mock seam
// ---------------------------------------------------------------------------

/**
 * In-memory mock store of the operator's API keys, mutated by the mock
 * mint/revoke so the settings card's list re-derives across a mint→list→revoke
 * cycle on the mock seam (mirroring the prototype's read-state/render loop).
 * Seeded empty; the mock mint FABRICATES a `cap_sk_` key (MOCK-ONLY — the real
 * seam's show-once key is the server's one-time response, never fabricated).
 */
const MOCK_API_KEYS: ApiKeyListItem[] = [];

/** Fabricate a `cap_sk_` raw key for the MOCK path only (deterministic-ish). */
function mockRawApiKey(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const seed = MOCK_API_KEYS.length + 1;
  let body = "";
  for (let i = 0; i < 43; i += 1) body += alphabet[(i * 7 + seed * 13) % 64];
  return `cap_sk_${body}`;
}

/** `GET /api-keys` (mock) — the in-memory key list, most-recent-first. */
export async function mockListApiKeys(): Promise<ApiKeyListResponse> {
  await delay();
  return { keys: MOCK_API_KEYS.map((k) => ({ ...k })) };
}

/**
 * `POST /api-keys` (mock) — fabricate + store a key, returning the show-once raw
 * value. MOCK-ONLY fabrication; the real seam returns the server's one-time key.
 */
export async function mockMintApiKey(
  body: ApiKeyMintRequest,
): Promise<ApiKeyMintResponse> {
  await delay();
  const rawKey = mockRawApiKey();
  const last4 = rawKey.slice(-4);
  const id = `mock-key-${MOCK_API_KEYS.length + 1}`;
  MOCK_API_KEYS.unshift({
    id,
    name: body.name,
    scopes: body.scopes,
    prefix: "cap_sk_",
    last4,
    lastUsedAt: null,
    expiresAt: body.expiresAt ?? null,
    revokedAt: null,
  });
  return {
    key: rawKey,
    id,
    name: body.name,
    scopes: body.scopes,
    prefix: "cap_sk_",
    last4,
    expiresAt: body.expiresAt ?? null,
  };
}

/**
 * `DELETE /api-keys/:id` (mock) — idempotent revoke; a revoked key stays listed
 * with its `revokedAt` timestamp. Returns the revoked key's list view.
 */
export async function mockRevokeApiKey(
  id: string,
): Promise<ApiKeyRevokeResponse> {
  await delay();
  const item = MOCK_API_KEYS.find((k) => k.id === id);
  if (!item) throw new Error(`mock api-key not found: ${id}`);
  if (item.revokedAt == null) item.revokedAt = new Date().toISOString();
  return { key: { ...item } };
}

// ---------------------------------------------------------------------------
// Account administration (account-administration) — admin-only.
//
// An in-memory account set matching the api's list projection EXACTLY (no secret),
// seeded with local-account rows so the page is interactive under the mock gate.
// create/enable/disable/role mutate the store so
// a subsequent list read reflects them (the read-state/render loop); reset is a
// no-op on the non-secret projection (it rotates a password the list never shows).
// ---------------------------------------------------------------------------

let mockAccountStore: AdminAccountListItem[] = [
  {
    id: "local-admin",
    email: "admin@local",
    name: "平台管理员",
    identity: "admin@local",
    role: "admin",
    allowed: true,
    loginMethods: ["password", "otp"],
    isGithubLinked: false,
  },
  {
    id: "local-ops",
    email: "ops@team.io",
    name: "运维组",
    identity: "ops@team.io",
    role: "member",
    allowed: true,
    loginMethods: ["password", "otp"],
    isGithubLinked: false,
  },
  {
    id: "local-dev",
    email: "dev@team.io",
    name: "前端",
    identity: "dev@team.io",
    role: "member",
    allowed: true,
    loginMethods: ["password"],
    isGithubLinked: false,
  },
  {
    id: "local-contractor",
    email: "contractor@ext.dev",
    name: "外包",
    identity: "contractor@ext.dev",
    role: "member",
    allowed: false,
    loginMethods: ["otp"],
    isGithubLinked: false,
  },
];
let mockAccountSeq = 0;

/** `GET /accounts` (mock) — every local account. */
export async function mockListAdminAccounts(): Promise<AdminAccountListResponse> {
  await delay();
  return { accounts: mockAccountStore.map((a) => ({ ...a })) };
}

/** `POST /accounts` (mock) — create a local account; reflected on the next list. */
export async function mockCreateAdminAccount(
  body: AdminCreateAccountRequest,
): Promise<AdminAccountListItem> {
  await delay();
  mockAccountSeq += 1;
  const loginMethods: AdminAccountListItem["loginMethods"] =
    body.initialCredential === "password" ? ["password", "otp"] : ["otp"];
  const item: AdminAccountListItem = {
    id: `local-new-${mockAccountSeq}`,
    email: body.email,
    name: body.name,
    identity: body.email,
    role: body.role,
    allowed: true,
    loginMethods,
    isGithubLinked: false,
  };
  mockAccountStore = [...mockAccountStore, item];
  return { ...item };
}

/** `PATCH /accounts/:id/enabled` (mock) — flip `allowed`. */
export async function mockSetAdminAccountEnabled(
  id: string,
  allowed: boolean,
): Promise<AdminAccountListItem> {
  await delay();
  mockAccountStore = mockAccountStore.map((a) =>
    a.id === id ? { ...a, allowed } : a,
  );
  const found = mockAccountStore.find((a) => a.id === id);
  if (!found) throw new Error(`mock account not found: ${id}`);
  return { ...found };
}

/** `PATCH /accounts/:id/password` (mock) — reset is a no-op on the non-secret row. */
export async function mockResetAdminAccountPassword(
  id: string,
  _password: string,
): Promise<AdminAccountListItem> {
  await delay();
  void _password;
  const found = mockAccountStore.find((a) => a.id === id);
  if (!found) throw new Error(`mock account not found: ${id}`);
  return { ...found };
}

/** `PATCH /accounts/:id/role` (mock) — assign role. */
export async function mockSetAdminAccountRole(
  id: string,
  role: Role,
): Promise<AdminAccountListItem> {
  await delay();
  mockAccountStore = mockAccountStore.map((a) =>
    a.id === id ? { ...a, role } : a,
  );
  const found = mockAccountStore.find((a) => a.id === id);
  if (!found) throw new Error(`mock account not found: ${id}`);
  return { ...found };
}

// ---------------------------------------------------------------------------
// SMTP configuration (add-smtp-config-ui) — masked read + save + test
//
// The mock is the SERVER stand-in for the admin-only SMTP config surface. State
// is module-scoped (this seam's scope; the persisted UI store is out of scope),
// seeded EMPTY so the card's "未配置" path is the default. A save stores ONLY the
// non-secret masked projection — the plaintext API Key is DROPPED, recorded only
// as `passLast4` + `hasPassword` (exactly the masked read contract). The
// host/port/user are the fixed Resend tuple; an empty `pass` keeps the stored
// suffix (the "留空沿用" rule). The test send echoes a success outcome WITHOUT
// persisting — mirroring the real probe — and never returns the password.
// ---------------------------------------------------------------------------

/** The fixed Resend SMTP tuple — host/port/username are copy, not inputs. */
const RESEND_SMTP = { host: "smtp.resend.com", port: 465, user: "resend" } as const;

/** The in-memory mock SMTP config (masked projection only — never a plaintext key). */
let mockSmtpConfig: SmtpConfigRead = {
  host: RESEND_SMTP.host,
  port: RESEND_SMTP.port,
  user: RESEND_SMTP.user,
  from: "",
  passLast4: null,
  hasPassword: false,
};

/** `GET /settings/smtp` (mock) — the current MASKED config (never a plaintext key). */
export async function mockSmtpConfigRead(): Promise<SmtpConfigRead> {
  await delay();
  return { ...mockSmtpConfig };
}

/**
 * `PUT /settings/smtp` (mock) — save the config, storing ONLY the non-secret
 * masked projection. An empty/omitted `pass` keeps the existing suffix ("留空沿
 * 用"); a supplied key is recorded as `passLast4` + `hasPassword` (the plaintext
 * is dropped, never persisted client-side — the masked read contract).
 */
export async function mockSaveSmtpConfig(
  body: SaveSmtpConfigRequest,
): Promise<SmtpConfigRead> {
  await delay();
  const hasNewPass = typeof body.pass === "string" && body.pass.length > 0;
  mockSmtpConfig = {
    host: body.host || RESEND_SMTP.host,
    port: typeof body.port === "number" ? body.port : RESEND_SMTP.port,
    user: body.user || RESEND_SMTP.user,
    from: body.from,
    // Keep the existing suffix when no new key is supplied (留空沿用现有).
    passLast4: hasNewPass ? body.pass!.slice(-4) : mockSmtpConfig.passLast4,
    hasPassword: hasNewPass ? true : mockSmtpConfig.hasPassword,
  };
  return { ...mockSmtpConfig };
}

/**
 * `POST /settings/smtp/test` (mock) — echo a successful test-send outcome WITHOUT
 * persisting (the probe never writes). Mirrors the real `{ ok, message }` shape;
 * never returns the password.
 */
export async function mockTestSmtpConfig(
  _body: TestSmtpConfigRequest,
): Promise<TestSmtpConfigResponse> {
  await delay();
  void _body;
  return { ok: true, message: "测试邮件已发送到你的账号邮箱（mock）。" };
}

/** Test-only reset of the mock SMTP state (no production caller). */
export function __resetMockSmtpState(): void {
  mockSmtpConfig = {
    host: RESEND_SMTP.host,
    port: RESEND_SMTP.port,
    user: RESEND_SMTP.user,
    from: "",
    passLast4: null,
    hasPassword: false,
  };
}
