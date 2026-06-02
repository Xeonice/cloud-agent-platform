import { z } from 'zod';

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
 * It is kept byte-for-byte in sync with the Prisma `TaskStatus` enum.
 */
export const TaskStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'agent_failed_to_start',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The set of statuses that are terminal (no further transitions out). */
export const TERMINAL_TASK_STATUSES = [
  'completed',
  'failed',
  'agent_failed_to_start',
] as const satisfies readonly TaskStatus[];

// ---------------------------------------------------------------------------
// Repo domain schema
// ---------------------------------------------------------------------------

/**
 * A registered git repository the operator can launch tasks against.
 */
export const RepoSchema = z.object({
  id: z.string().uuid(),
  /** Human-friendly display name. */
  name: z.string().min(1),
  /** Git source the runner clones from (URL or remote spec). */
  gitSource: z.string().min(1),
  createdAt: z.coerce.date(),
});
export type Repo = z.infer<typeof RepoSchema>;

// ---------------------------------------------------------------------------
// Task domain schema
// ---------------------------------------------------------------------------

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
});
export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Repo REST request/response bodies
// ---------------------------------------------------------------------------

/** Body accepted by `POST /repos`. */
export const CreateRepoRequestSchema = z.object({
  name: z.string().min(1),
  gitSource: z.string().min(1),
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
   * Optional wall-clock deadline in milliseconds from admission. When present it
   * is passed to the guardrails semaphore (`admit(taskId, deadlineMs)`) so the
   * deadline watcher arms and a task that overruns is force-failed and reclaimed
   * (guardrails: "Wall-clock deadline force-fails a task"). Absent ⇒ no deadline.
   */
  deadlineMs: z.number().int().positive().optional(),
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
export const TaskResponseSchema = TaskSchema;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

/** Lower-camel alias of {@link TaskResponseSchema} used by the api tasks service. */
export const taskResponseSchema = TaskResponseSchema;

/** Response body for `GET /tasks`. */
export const ListTasksResponseSchema = z.array(TaskSchema);
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
