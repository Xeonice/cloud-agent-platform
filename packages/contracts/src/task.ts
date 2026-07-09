import { z } from 'zod';
import { ForgeKindSchema } from './settings.js';
import { TaskSandboxEnvironmentSummarySchema } from './sandbox-environment.js';

/**
 * Task lifecycle status (repo-and-task-management spec).
 *
 * `agent_failed_to_start` is a DISTINCT terminal state, separate from both
 * `running` and the generic `failed`, surfaced when the agent process exits
 * before it ever reached a running state.
 *
 * `queued` is the admission-control holding state: when the concurrency
 * semaphore (guardrails track) is at `MAX_CONCURRENT_TASKS`, a newly created
 * task is held `queued` (no sandbox provisioned) until a running slot frees up.
 *
 * `cancelled` is the terminal state for an operator-initiated stop
 * (`POST /tasks/:taskId/stop`), DISTINCT from both `completed` (a clean agent
 * exit) and the generic `failed` (a crash / guardrail force-fail), so the
 * timeline can tell a deliberate stop apart from a failure.
 *
 * It is kept byte-for-byte in sync with the Prisma `TaskStatus` enum.
 */
export const TaskStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled',
  'agent_failed_to_start',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The set of statuses that are terminal (no further transitions out). */
export const TERMINAL_TASK_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'agent_failed_to_start',
] as const satisfies readonly TaskStatus[];

// ---------------------------------------------------------------------------
// Agent-runtime selector (add-claude-code-runtime)
// ---------------------------------------------------------------------------

/**
 * The agent runtime a task is dispatched to (agent-runtime spec).
 *
 * Per-task selectable: `claude-code` runs the Claude Code CLI, `codex` runs the
 * codex CLI. The value is OPTIONAL on the wire and on the persisted record;
 * absence is treated as {@link DEFAULT_TASK_RUNTIME} (`codex`) so existing tasks
 * and omitted requests stay valid, and the create response / list / fetch-by-id
 * read paths echo it back (the supplied value, or `codex` when omitted).
 *
 * Kept byte-for-byte in sync with the values the api runtime registry resolves
 * by and the `Task.runtime` column persists.
 */
export const RuntimeSchema = z.enum(['claude-code', 'codex']);
export type Runtime = z.infer<typeof RuntimeSchema>;

/**
 * The execution mode a task runs under (add-headless-execution-track): the console
 * live-terminal `interactive-pty` vs the programmatic one-shot `headless-exec`
 * (MCP/`/v1`). Exposed on the task response so the console can branch the session
 * view (headless-task-conversation-view).
 */
export const ExecutionModeSchema = z.enum(['interactive-pty', 'headless-exec']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * The default runtime applied when a create request omits `runtime` and when an
 * existing/persisted task carries no `runtime` value (additive-nullable column).
 * Existing tasks and omitted requests therefore read back as `codex`.
 */
export const DEFAULT_TASK_RUNTIME = 'codex' as const satisfies Runtime;

// ---------------------------------------------------------------------------
// Repo domain schema
// ---------------------------------------------------------------------------

/**
 * A registered git repository the operator can launch tasks against.
 *
 * The GitHub-import metadata fields (`description`, `defaultBranch`,
 * `branchCount`, `updatedAt`, `githubId`) are OPTIONAL and NULLABLE: they are
 * populated only when the repo was imported from GitHub. A plain `gitSource`-only
 * repo created without GitHub import remains valid with these fields null/absent;
 * the read responses MUST NOT fabricate them. `githubId` is the originating
 * GitHub repository identity, carried so imports can be de-duplicated.
 */
export const RepoSchema = z.object({
  id: z.string().uuid(),
  /** Human-friendly display name. */
  name: z.string().min(1),
  /** Git source the runner clones from (URL or remote spec). */
  gitSource: z.string().min(1),
  createdAt: z.coerce.date(),
  /** GitHub repo description (import metadata). Null/absent when not imported. */
  description: z.string().nullable().optional(),
  /** GitHub default branch name (import metadata). Null/absent when not imported. */
  defaultBranch: z.string().min(1).nullable().optional(),
  /** GitHub branch count (import metadata). Null/absent when not imported. */
  branchCount: z.number().int().nonnegative().nullable().optional(),
  /** GitHub last-updated timestamp (import metadata). Null/absent when not imported. */
  updatedAt: z.coerce.date().nullable().optional(),
  /**
   * Originating GitHub repository identity, used to de-duplicate imports.
   * Null/absent for repos not imported from GitHub.
   */
  githubId: z.string().min(1).nullable().optional(),
  /**
   * Whether this imported Repo is the operator's current DEFAULT repo for
   * task-creation selection. At most one Repo is ever `true`; designating a new
   * default clears the prior one. Defaults to `false`. Only an imported Repo may
   * be defaulted — an available-only GitHub repo (never imported) has no Repo row
   * and therefore cannot carry this flag.
   */
  isDefault: z.boolean().optional(),
  /**
   * The source forge this repo lives on (`github` | `gitlab` | `gitee`) —
   * add-multi-forge-task-delivery. Null/absent for repos predating multi-forge
   * (inferred from `gitSource` host at use). Drives change-request push-back.
   */
  forge: ForgeKindSchema.nullable().optional(),
});
export type Repo = z.infer<typeof RepoSchema>;

// ---------------------------------------------------------------------------
// Task result delivery (add-multi-forge-task-delivery)
// ---------------------------------------------------------------------------

/** Opt-in delivery selector: where a completed task's edits land. Default `none`. */
export const DeliverSchema = z.enum(['none', 'branch', 'pr']);
export type Deliver = z.infer<typeof DeliverSchema>;

/** Outcome of a push-back attempt, surfaced on the task read paths. */
export const DeliverStatusSchema = z.enum([
  'skipped',
  'no_changes',
  'pushed',
  'pr_opened',
  'failed',
]);
export type DeliverStatus = z.infer<typeof DeliverStatusSchema>;

// ---------------------------------------------------------------------------
// Task domain schema
// ---------------------------------------------------------------------------

export const TaskScheduleProvenanceSchema = z.object({
  scheduleId: z.string().uuid(),
  scheduledFor: z.coerce.date(),
});
export type TaskScheduleProvenance = z.infer<typeof TaskScheduleProvenanceSchema>;

/**
 * A single agent run scoped to a repo.
 */
export const TaskSchema = z.object({
  id: z.string().uuid(),
  /** Foreign key to the owning {@link RepoSchema}. */
  repoId: z.string().uuid(),
  /** The operator prompt / instruction the agent is driven with. */
  prompt: z.string().min(1),
  status: TaskStatusSchema,
  createdAt: z.coerce.date(),
  /**
   * Optional run parameter echoed back from the create body: the git branch the
   * runner checks out. Read back on every task read path (create response, list,
   * fetch-by-id) as the supplied value or `null` when omitted — never stale or
   * fabricated (sent value == readable value).
   */
  branch: z.string().min(1).nullable().optional(),
  /**
   * Optional run parameter echoed back from the create body: the execution
   * strategy. Inert with respect to the lifecycle; read back as the supplied
   * value or `null` when omitted.
   */
  strategy: z.string().min(1).nullable().optional(),
  /**
   * Optional run parameter echoed back from the create body: the ids of the
   * skills/methods (e.g. `openspec`, `bmad`) the operator chose to preinstall
   * into the task workspace at provision time (see `task-preinstall-skills`).
   * Inert with respect to the lifecycle; read back as the supplied list (or an
   * empty array / `null` when none were selected) — never stale or fabricated.
   */
  skills: z.array(z.string().min(1)).nullable().optional(),
  /**
   * Optional guardrail parameter echoed back from the create body: the per-task
   * idle ceiling in milliseconds. Idle reclamation is OPT-IN and OFF by default —
   * when this is null/absent (and no operator-level `MAX_IDLE_MS` default is
   * configured) the task is never force-failed for idleness. Consumed at
   * admission to arm the idle watcher AND persisted, so the configured value is
   * readable on every task read path — never stale or fabricated.
   */
  idleTimeoutMs: z.number().int().positive().nullable().optional(),
  /**
   * Optional guardrail parameter echoed back from the create body: the wall-clock
   * deadline in milliseconds from admission. When null/absent the task has no
   * deadline. Consumed at admission to arm the deadline watcher AND persisted
   * (previously it was transient), so the configured value is readable on every
   * task read path — never stale or fabricated.
   */
  deadlineMs: z.number().int().positive().nullable().optional(),
  /**
   * Optional run parameter echoed back from the create body: the agent runtime
   * the task is dispatched to (`claude-code` | `codex`). The column is additive
   * and nullable; a task with no `runtime` reads back as the default `codex`
   * (see {@link DEFAULT_TASK_RUNTIME}). Read back on every task read path
   * (create response, list, fetch-by-id) as the supplied value — never stale or
   * fabricated (sent value == readable value).
   */
  runtime: RuntimeSchema.nullable().optional(),
  /**
   * Optional sandbox runtime environment selected for this task. Null/absent
   * means the platform resolves the managed or deployment default.
   */
  sandboxEnvironmentId: z.string().uuid().nullable().optional(),
  /**
   * The execution mode this task runs under (add-headless-execution-track),
   * exposed so the console can branch the session view (headless-task-conversation-view):
   * `interactive-pty` (console live terminal) or `headless-exec` (programmatic
   * one-shot via MCP/`/v1`). Additive + nullable; a null column reads back as the
   * default `interactive-pty` (sent value == readable value).
   */
  executionMode: ExecutionModeSchema.nullable().optional(),
  /**
   * Opt-in delivery selector echoed from the create body (`none|branch|pr`,
   * default `none`) — add-multi-forge-task-delivery. Read back as the supplied
   * value (or `none`) on every task read path.
   */
  deliver: DeliverSchema.nullable().optional(),
  /** Outcome of the push-back attempt. Null until a delivery runs. */
  deliverStatus: DeliverStatusSchema.nullable().optional(),
  /** The branch the platform pushed (`cap/task-<id>`). Null when none. */
  branchPushed: z.string().min(1).nullable().optional(),
  /** The pushed commit sha. Null when none. */
  commitSha: z.string().min(1).nullable().optional(),
  /** The opened/reused change-request URL. Null when none. */
  changeRequestUrl: z.string().url().nullable().optional(),
  /** The change-request number/iid. Null when none. */
  changeRequestNumber: z.number().int().positive().nullable().optional(),
  /**
   * Nullable provenance for tasks created by a durable schedule. Direct tasks
   * read back as null/absent; scheduler internals and owner credentials are never
   * exposed through this response field.
   */
  scheduleProvenance: TaskScheduleProvenanceSchema.nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Task REST response-only sandbox provider summary
// ---------------------------------------------------------------------------

/**
 * Public, non-secret sandbox provider summary shown by task read surfaces.
 *
 * This is deliberately response-only and much narrower than provider internals:
 * it exposes the public provider id plus a display label, but never provider
 * sandbox ids, connection JSON, native URLs, endpoints, tokens, or metadata.
 */
export const TaskSandboxProviderSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type TaskSandboxProvider = z.infer<typeof TaskSandboxProviderSchema>;

/**
 * Stable display label for a public sandbox provider id.
 *
 * Unknown ids intentionally collapse to a neutral label instead of echoing the id
 * into the label, so a future/misconfigured provider id cannot accidentally make
 * endpoint-like data more prominent in the UI.
 */
export function sandboxProviderLabel(providerId: string): string {
  const id = providerId.trim().toLowerCase();
  if (id === 'aio' || id.startsWith('aio-')) return 'AIO Sandbox';
  if (id === 'boxlite' || id.startsWith('boxlite-')) return 'BoxLite Sandbox';
  if (id === 'cloud-http' || id === 'cloud' || id.startsWith('cloud-')) {
    return 'Cloud Sandbox';
  }
  return 'Sandbox Provider';
}

// ---------------------------------------------------------------------------
// Repo REST request/response bodies
// ---------------------------------------------------------------------------

/** Body accepted by `POST /repos`. */
export const CreateRepoRequestSchema = z.object({
  name: z.string().min(1),
  gitSource: z.string().min(1),
  /**
   * Optional source forge (add-multi-forge-task-delivery). When omitted the
   * server infers it from the `gitSource` host (github.com / gitlab.com /
   * gitee.com); a self-hosted host must supply it explicitly.
   */
  forge: ForgeKindSchema.optional(),
});
export type CreateRepoRequest = z.infer<typeof CreateRepoRequestSchema>;

/**
 * Aliases for the repo create body under the `*Body`/lower-camel naming used by
 * the api repos controller/service. The schema is identical to
 * {@link CreateRepoRequestSchema}; both names resolve to the same single source
 * of truth so api and web can each use their preferred convention.
 */
export const createRepoBodySchema = CreateRepoRequestSchema;
export type CreateRepoBody = CreateRepoRequest;

/** Response body for a single repo (create / fetch-by-id). */
export const RepoResponseSchema = RepoSchema;
export type RepoResponse = z.infer<typeof RepoResponseSchema>;

/** Lower-camel alias of {@link RepoResponseSchema} used by the api repos service. */
export const repoResponseSchema = RepoResponseSchema;

/** Response body for `GET /repos`. */
export const ListReposResponseSchema = z.array(RepoSchema);
export type ListReposResponse = z.infer<typeof ListReposResponseSchema>;

// ---------------------------------------------------------------------------
// Task REST request/response bodies
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /repos/:repoId/tasks`.
 *
 * `repoId` is supplied by the route; only the agent-facing inputs live in the
 * body. `branch` and `strategy` are optional run parameters surfaced by the
 * new-task console form.
 */
export const CreateTaskRequestSchema = z.object({
  prompt: z.string().min(1),
  branch: z.string().min(1).optional(),
  strategy: z.string().min(1).optional(),
  /**
   * Optional skill/method ids to preinstall into the task workspace at provision
   * time (e.g. `["openspec"]`, `["bmad"]`). Validated server-side against the
   * skill allowlist; only allowlisted ids are ever executed. Absent/empty ⇒ no
   * preinstall (unchanged behavior). See `task-preinstall-skills`.
   */
  skills: z.array(z.string().min(1)).optional(),
  /**
   * Optional wall-clock deadline in milliseconds from admission. When present it
   * is passed to the guardrails semaphore (`admit(taskId, { deadlineMs })`) so the
   * deadline watcher arms and a task that overruns is force-failed and reclaimed
   * (guardrails: "Wall-clock deadline force-fails a task"). Absent ⇒ no deadline.
   */
  deadlineMs: z.number().int().positive().optional(),
  /**
   * Optional per-task idle ceiling in milliseconds. Idle reclamation is OPT-IN
   * and OFF by default: when present it is passed to admission
   * (`admit(taskId, { idleTimeoutMs })`) so the idle watcher arms; when absent
   * (and no operator-level `MAX_IDLE_MS` default is set) the task is NEVER
   * force-failed for idleness, so a legitimately long, quiet task is not killed.
   */
  idleTimeoutMs: z.number().int().positive().optional(),
  /**
   * Optional agent-runtime selector (`claude-code` | `codex`). Validated against
   * the shared {@link RuntimeSchema}; a value outside the allowed set is rejected
   * (HTTP 400). When omitted the task is created with the default `codex`
   * ({@link DEFAULT_TASK_RUNTIME}). Persisted on the task and echoed on every read
   * path; at admission the task is dispatched to the selected runtime, and a
   * runtime that is not configured/ready fails closed with a distinct reason
   * rather than launching unauthenticated (see `agent-runtime`).
   */
  runtime: RuntimeSchema.optional(),
  /**
   * Optional managed sandbox runtime environment. When omitted, the server uses
   * the current account's default image; explicit null bypasses the account
   * default and falls back to the deployment-level default.
   */
  sandboxEnvironmentId: z.string().uuid().nullable().optional(),
  /**
   * Optional opt-in delivery selector (`none|branch|pr`) — where a completed
   * task's edits land (add-multi-forge-task-delivery). Default `none` (no
   * commit/branch/push/CR); `branch` pushes `cap/task-<id>`; `pr` also opens a
   * PR/MR on the repo's forge. Persisted + echoed on every read path.
   */
  deliver: DeliverSchema.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/**
 * Aliases for the task create body under the `*Body`/lower-camel naming used by
 * the api tasks controller/service. Identical to {@link CreateTaskRequestSchema};
 * both names resolve to the same single source of truth.
 */
export const createTaskBodySchema = CreateTaskRequestSchema;
export type CreateTaskBody = CreateTaskRequest;

/** Response body for a single task (create / fetch-by-id). */
export const TaskResponseSchema = TaskSchema.extend({
  /**
   * Public sandbox provider selected for this task, when provisioning has
   * recorded an owner. Null means no provider has been selected yet. Optional so
   * mixed deployments with an older api degrade honestly instead of failing task
   * reads; the current api emits null explicitly when absent.
   */
  sandboxProvider: TaskSandboxProviderSchema.nullable().optional(),
  sandboxEnvironment: TaskSandboxEnvironmentSummarySchema.nullable().optional(),
});
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

/** Lower-camel alias of {@link TaskResponseSchema} used by the api tasks service. */
export const taskResponseSchema = TaskResponseSchema;

/** Response body for `GET /tasks`. */
export const ListTasksResponseSchema = z.array(TaskResponseSchema);
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
