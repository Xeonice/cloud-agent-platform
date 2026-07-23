import { z } from 'zod';
import { ForgeKindSchema } from './settings.js';
import { TaskSandboxEnvironmentSummarySchema } from './sandbox-environment.js';
import { SandboxMetadataSchema } from './sandbox-metadata.js';
import { GitBranchNameSchema } from './git-ref.js';

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
// Safe task provisioning progress
// ---------------------------------------------------------------------------

/**
 * Stable public states for the durable task-provisioning work item.
 *
 * These values describe orchestration progress only. They intentionally do not
 * expose a database lease owner, provider-native sandbox state, or retry
 * scheduling internals.
 */
export const TASK_PROVISIONING_STATES = [
  'accepted',
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const TaskProvisioningStateSchema = z.enum(TASK_PROVISIONING_STATES);
export type TaskProvisioningState = z.infer<
  typeof TaskProvisioningStateSchema
>;

/**
 * Stable, provider-neutral stages that may be shown on task read surfaces.
 *
 * A provider may combine multiple implementation steps, but it must project
 * progress through this vocabulary instead of leaking BoxLite/AIO commands or
 * provider-native identifiers.
 */
export const TASK_PROVISIONING_STAGES = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
] as const;
export const TaskProvisioningStageSchema = z.enum(TASK_PROVISIONING_STAGES);
export type TaskProvisioningStage = z.infer<
  typeof TaskProvisioningStageSchema
>;

/**
 * Numeric-only live transfer progress for the `workspace_transfer` stage
 * (detach-workspace-clone).
 *
 * Strict and numeric by design: free text, URLs, or raw git output must fail
 * validation instead of leaking onto public task reads. Unknown values are
 * modeled EXPLICITLY as `null` (AIP-151): clone phases before object-transfer
 * counts exist report `percent: null` (indeterminate), never `0`, so consumers
 * can distinguish "not yet measurable" from an actual 0% transfer.
 */
export const TaskProvisioningProgressSchema = z
  .object({
    /** 0-100 when derivable from parsed object counts; null while unknown. */
    percent: z.number().min(0).max(100).nullable(),
    /** Objects received so far, when git has reported transfer counts. */
    receivedObjects: z.number().int().nonnegative().nullable(),
    /** Total objects expected, when git has reported transfer counts. */
    totalObjects: z.number().int().nonnegative().nullable(),
    /** Bytes received so far, when git has reported transfer counts. */
    receivedBytes: z.number().int().nonnegative().nullable(),
    /** Transfer throughput in bytes per second; null when not measurable. */
    throughput: z.number().nonnegative().nullable(),
  })
  .strict();
export type TaskProvisioningProgress = z.infer<
  typeof TaskProvisioningProgressSchema
>;

/**
 * Secret-free task provisioning projection shared by Console, Public V1, MCP,
 * OpenAPI, and the API Playground.
 *
 * This schema is strict by design: adding an internal lease, provider endpoint,
 * native sandbox id, command, credential path, or diagnostic bag must fail
 * validation instead of silently becoming part of a public response.
 */
export const TaskProvisioningSummarySchema = z
  .object({
    state: TaskProvisioningStateSchema,
    stage: TaskProvisioningStageSchema,
    /** Zero before the first claim; incremented for each processing attempt. */
    attempt: z.number().int().nonnegative(),
    /** Provider-neutral checkout branch snapshot, once it has been resolved. */
    resolvedBranch: z.string().min(1).nullable(),
    updatedAt: z.coerce.date(),
    /**
     * OPTIONAL nullable live transfer progress (additive, contracts-first):
     * payloads produced before this field existed still parse, and emission
     * stays behind the deployment capability gate for mixed-version rollout.
     */
    progress: TaskProvisioningProgressSchema.nullable().optional(),
  })
  .strict();
export type TaskProvisioningSummary = z.infer<
  typeof TaskProvisioningSummarySchema
>;

/** Short aliases for orchestration code that already lives in a task context. */
export const ProvisioningStateSchema = TaskProvisioningStateSchema;
export type ProvisioningState = TaskProvisioningState;
export const ProvisioningStageSchema = TaskProvisioningStageSchema;
export type ProvisioningStage = TaskProvisioningStage;
export const ProvisioningSummarySchema = TaskProvisioningSummarySchema;
export type ProvisioningSummary = TaskProvisioningSummary;
export const ProvisioningProgressSchema = TaskProvisioningProgressSchema;
export type ProvisioningProgress = TaskProvisioningProgress;

// ---------------------------------------------------------------------------
// Per-task runtime model selector (add-task-model-selection)
// ---------------------------------------------------------------------------

/** Maximum UTF-8 size accepted for one runtime model selector. */
export const TASK_MODEL_SELECTOR_MAX_BYTES = 2_048;

function hasTaskModelControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (codeUnit <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
    }
    bytes += 3;
  }
  return bytes;
}

const NormalizedTaskModelSelectorSchema = z
  .string()
  .min(1, 'Model selector must not be empty')
  // This character bound is also visible to OpenAPI. The byte refinement below
  // is the authoritative multi-byte limit.
  .max(TASK_MODEL_SELECTOR_MAX_BYTES, 'Model selector is too long')
  .superRefine((value, ctx) => {
    if (hasTaskModelControlCharacter(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Model selector must not contain control characters',
      });
    }
    if (utf8ByteLength(value) > TASK_MODEL_SELECTOR_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Model selector must be at most ${TASK_MODEL_SELECTOR_MAX_BYTES} UTF-8 bytes`,
      });
    }
  });

/**
 * Provider/CLI model selector supplied for one new task.
 *
 * Ordinary surrounding spaces are normalized away. A raw control character is
 * deliberately preserved by the preprocessor so the production refinement
 * rejects it instead of silently trimming it into a different selector.
 */
export const TaskModelSelectorSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'string') return input;
    return hasTaskModelControlCharacter(input) ? input : input.trim();
  },
  NormalizedTaskModelSelectorSchema,
);
export type TaskModelSelector = z.infer<typeof TaskModelSelectorSchema>;

// ---------------------------------------------------------------------------
// Structured runtime failure detail
// ---------------------------------------------------------------------------

/**
 * Stable runtime-authentication failures that require an operator action.
 *
 * `expired` is reserved for an explicit provider expiry signal; revoked/reused
 * refresh tokens and other provider rejections are kept as `rejected`.
 * This prevents a generic 401 from being presented as a known-expired token.
 */
export const TaskFailureCodeSchema = z.enum([
  'runtime_auth_expired',
  'runtime_auth_rejected',
  'runtime_model_setup_failed',
  'runtime_model_rejected',
  'provisioning_capacity_exhausted',
  'provisioning_workspace_timeout',
  'provisioning_forge_auth_failed',
  'provisioning_tls_network_failed',
  'provisioning_ref_not_found',
  'provisioning_platform_dependency_unavailable',
  'provisioning_unknown',
]);
export type TaskFailureCode = z.infer<typeof TaskFailureCodeSchema>;

export const TaskFailureActionSchema = z.enum([
  'reconnect_runtime',
  'retry_task',
  'choose_another_model',
  'increase_sandbox_capacity',
  'reconnect_forge',
  'verify_repository_ref',
  'repair_deployment',
]);
export type TaskFailureAction = z.infer<typeof TaskFailureActionSchema>;

const TaskFailureFields = {
  runtime: RuntimeSchema,
  message: z.string().min(1),
  occurredAt: z.coerce.date(),
  exitCode: z.number().int().nullable(),
} as const;

export const RuntimeAuthExpiredTaskFailureSchema = z.object({
  code: z.literal('runtime_auth_expired'),
  ...TaskFailureFields,
  action: z.literal('reconnect_runtime'),
});

export const RuntimeAuthRejectedTaskFailureSchema = z.object({
  code: z.literal('runtime_auth_rejected'),
  ...TaskFailureFields,
  action: z.literal('reconnect_runtime'),
});

export const RuntimeModelSetupTaskFailureSchema = z.object({
  code: z.literal('runtime_model_setup_failed'),
  ...TaskFailureFields,
  action: z.literal('retry_task'),
});
export type RuntimeModelSetupTaskFailure = z.infer<
  typeof RuntimeModelSetupTaskFailureSchema
>;

export const RuntimeModelRejectedTaskFailureSchema = z.object({
  code: z.literal('runtime_model_rejected'),
  ...TaskFailureFields,
  action: z.literal('choose_another_model'),
});
export type RuntimeModelRejectedTaskFailure = z.infer<
  typeof RuntimeModelRejectedTaskFailureSchema
>;

const ProvisioningTaskFailureFields = {
  // Public messages are deliberately bounded and carry no diagnostic bag. The
  // service supplies fixed, localized copy rather than raw provider/git output.
  message: z.string().trim().min(1).max(1_024),
  occurredAt: z.coerce.date(),
} as const;

export const ProvisioningCapacityTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_capacity_exhausted'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('increase_sandbox_capacity'),
  })
  .strict();
export type ProvisioningCapacityTaskFailure = z.infer<
  typeof ProvisioningCapacityTaskFailureSchema
>;

export const ProvisioningWorkspaceTimeoutTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_workspace_timeout'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('retry_task'),
  })
  .strict();
export type ProvisioningWorkspaceTimeoutTaskFailure = z.infer<
  typeof ProvisioningWorkspaceTimeoutTaskFailureSchema
>;

export const ProvisioningForgeAuthTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_forge_auth_failed'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('reconnect_forge'),
  })
  .strict();
export type ProvisioningForgeAuthTaskFailure = z.infer<
  typeof ProvisioningForgeAuthTaskFailureSchema
>;

export const ProvisioningTlsNetworkTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_tls_network_failed'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('retry_task'),
  })
  .strict();
export type ProvisioningTlsNetworkTaskFailure = z.infer<
  typeof ProvisioningTlsNetworkTaskFailureSchema
>;

export const ProvisioningRefNotFoundTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_ref_not_found'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('verify_repository_ref'),
  })
  .strict();
export type ProvisioningRefNotFoundTaskFailure = z.infer<
  typeof ProvisioningRefNotFoundTaskFailureSchema
>;

export const ProvisioningPlatformDependencyTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_platform_dependency_unavailable'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('repair_deployment'),
  })
  .strict();
export type ProvisioningPlatformDependencyTaskFailure = z.infer<
  typeof ProvisioningPlatformDependencyTaskFailureSchema
>;

export const ProvisioningUnknownTaskFailureSchema = z
  .object({
    code: z.literal('provisioning_unknown'),
    ...ProvisioningTaskFailureFields,
    action: z.literal('retry_task'),
  })
  .strict();
export type ProvisioningUnknownTaskFailure = z.infer<
  typeof ProvisioningUnknownTaskFailureSchema
>;

/**
 * Secret-free, actionable failure persisted with a task's terminal state.
 * The discriminated branches prevent invalid code/action combinations.
 */
export const TaskFailureSchema = z.discriminatedUnion('code', [
  RuntimeAuthExpiredTaskFailureSchema,
  RuntimeAuthRejectedTaskFailureSchema,
  RuntimeModelSetupTaskFailureSchema,
  RuntimeModelRejectedTaskFailureSchema,
  ProvisioningCapacityTaskFailureSchema,
  ProvisioningWorkspaceTimeoutTaskFailureSchema,
  ProvisioningForgeAuthTaskFailureSchema,
  ProvisioningTlsNetworkTaskFailureSchema,
  ProvisioningRefNotFoundTaskFailureSchema,
  ProvisioningPlatformDependencyTaskFailureSchema,
  ProvisioningUnknownTaskFailureSchema,
]).describe(
  'Closed Task failure discriminator. Current readers accept legacy payloads, ' +
    'but strict previous-version readers require a matched upgrade before the ' +
    'platform-dependency variant can be served.',
);
export type TaskFailure = z.infer<typeof TaskFailureSchema>;

// ---------------------------------------------------------------------------
// Repo domain schema
// ---------------------------------------------------------------------------

/**
 * Repo-store content-copy state (add-repo-content-store).
 *
 * - `missing` — no copy exists (a Repo imported before the content store, or one
 *   whose copy was never acquired). This is the durable default after upgrade.
 * - `refreshing` — an acquisition/refresh is in flight.
 * - `ready` — a bare-mirror copy is materialized and usable for task start.
 * - `failed` — the last acquisition/refresh failed. A failed REFRESH still has
 *   its previous (last-good) copy on disk; a failed initial acquisition has none.
 */
export const RepoCopyStatusSchema = z.enum([
  'missing',
  'refreshing',
  'ready',
  'failed',
]);
export type RepoCopyStatus = z.infer<typeof RepoCopyStatusSchema>;

/**
 * Stable error code a TASK CREATE is rejected with when the selected Repo's
 * content copy is not `ready` (add-repo-content-store D6).
 *
 * DELIBERATELY NOT one of the `repo_copy_*` {@link REPO_IMPORT_FAILURE_CODES}:
 * those say "acquiring/refreshing the copy FAILED". This one says "the Repo row
 * is fine, but no usable copy exists yet, so no task may start against it" — a
 * different audience (task creation) and a different remedy (run the refresh).
 */
export const TASK_REPO_COPY_NOT_READY_ERROR = 'task_repo_copy_not_ready';

/**
 * The blocking copy state named by a rejection. Every {@link RepoCopyStatus}
 * except `ready`, plus `unknown` for a stored value this build does not
 * recognize — such a row is refused (fail closed) rather than admitted.
 */
export const TaskRepoCopyBlockingStatusSchema = z.enum([
  'missing',
  'refreshing',
  'failed',
  'unknown',
]);
export type TaskRepoCopyBlockingStatus = z.infer<
  typeof TaskRepoCopyBlockingStatusSchema
>;

/** REST path (relative to the api root) that acquires/refreshes a repo copy. */
export const REPO_COPY_REFRESH_PATH_TEMPLATE = 'POST /repos/:repoId/refresh-copy';

/**
 * Operator-facing rejection copy. Shared so the console, `/v1`, and MCP all
 * name the SAME remedy, and so a client that prefers its own wording can still
 * branch on {@link TASK_REPO_COPY_NOT_READY_ERROR} + the blocking status.
 *
 * Every variant names `refresh-copy` — it is the single entry point that also
 * acquires a `missing` copy, so it is the one action that unblocks the create.
 */
export function taskRepoCopyNotReadyMessage(
  repoId: string,
  copyStatus: TaskRepoCopyBlockingStatus,
): string {
  const path = `POST /repos/${repoId}/refresh-copy`;
  switch (copyStatus) {
    case 'missing':
      return (
        'This repo has no content copy yet, so a task cannot be started against ' +
        `it (copyStatus "missing"). Acquire the copy with \`${path}\`, then ` +
        'create the task again.'
      );
    case 'refreshing':
      return (
        'This repo\'s content copy is being refreshed right now, so a task ' +
        'cannot be started against it (copyStatus "refreshing"). Wait for the ' +
        `refresh to finish — re-run \`${path}\` if it stalls — then create the ` +
        'task again.'
      );
    case 'failed':
      return (
        'The last content-copy acquisition for this repo failed, so a task ' +
        'cannot be started against it (copyStatus "failed"). Retry it with ' +
        `\`${path}\` (or re-import the repo), then create the task again.`
      );
    case 'unknown':
      return (
        'This repo\'s content copy state is not recognized, so a task cannot be ' +
        `started against it (copyStatus "unknown"). Re-acquire the copy with ` +
        `\`${path}\`, then create the task again.`
      );
  }
}

/**
 * Rejection body for a create blocked on copy readiness. Shape follows the
 * existing `{ error, message }` failure texture (see
 * {@link RepoImportFailureSchema}) and adds the two fields a client needs to
 * render the remedy without a second read.
 */
export const TaskRepoCopyNotReadyErrorSchema = z
  .object({
    error: z.literal(TASK_REPO_COPY_NOT_READY_ERROR),
    /** The Repo whose copy blocked the create. */
    repoId: z.string().min(1),
    copyStatus: TaskRepoCopyBlockingStatusSchema,
    /** Bounded, server-safe operator copy naming the refresh path. */
    message: z.string().trim().min(1).max(1_024),
  })
  .strict();
export type TaskRepoCopyNotReadyError = z.infer<
  typeof TaskRepoCopyNotReadyErrorSchema
>;

/**
 * A registered git repository the operator can launch tasks against.
 *
 * Import metadata is OPTIONAL and NULLABLE for legacy rows. `defaultBranch` is
 * forge-neutral and carries a verified picker/API or symbolic-HEAD value;
 * description/branchCount/updatedAt/githubId remain GitHub provenance fields.
 * Read responses MUST NOT fabricate a missing branch.
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
  /** Verified forge default branch. Null/absent for legacy unverified rows. */
  defaultBranch: GitBranchNameSchema.nullable().optional(),
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
  /**
   * Repo-store content-copy state (add-repo-content-store). ADDITIVE and
   * OPTIONAL: a payload produced before the content store existed carries no
   * such field and MUST still parse. A row that predates the store reads as
   * `missing` until an operator triggers acquisition; task creation is gated on
   * `ready`.
   */
  copyStatus: RepoCopyStatusSchema.optional(),
  /**
   * When the bare-mirror content copy was last successfully materialized
   * (import acquisition or an explicit refresh). Null/absent while no copy has
   * ever completed. A FAILED refresh keeps the previous timestamp, because the
   * last-good copy is still the one on disk.
   */
  copyUpdatedAt: z.coerce.date().nullable().optional(),
});
export type Repo = z.infer<typeof RepoSchema>;

/**
 * Whether a repo's recorded `gitSource` is a local filesystem path rather than
 * an `http(s)` remote (local-repo-import). Pure and shared so the api and the
 * console classify a repo identically without a second wire field: a locally
 * imported Repo records the source PATH as its git source and is never
 * connected to a forge.
 */
export function isLocalRepoGitSource(gitSource: string): boolean {
  // A locally imported Repo records an ABSOLUTE POSIX path (the api container is
  // the only filesystem a local import can name). Everything else — including a
  // relative or scheme-bearing string — is treated as a remote source, so this
  // never misclassifies an existing repo into "local".
  return /^\/(?!\/)/u.test(gitSource.trim());
}

/**
 * Whether forge-side delivery (opening a PR/MR) can be offered for a repo.
 *
 * A locally imported Repo (`gitSource` is a filesystem path) is NEVER treated as
 * connected to a forge, regardless of the `forge` column, so console/API
 * delivery-option reads must not offer PR/MR for it. A remote repo with a null
 * `forge` stays eligible: the forge is inferred from the host at use.
 */
export function repoOffersForgeDelivery(repo: {
  readonly gitSource: string;
  readonly forge?: string | null;
}): boolean {
  return !isLocalRepoGitSource(repo.gitSource);
}

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
  /**
   * Actionable terminal/runtime failure. Null means no structured cause was
   * classified; clients must not infer one from transcript text.
   */
  failure: TaskFailureSchema.nullable().optional(),
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
   * Exact normalized model selector requested for this task. Null/absent means
   * the effective runtime default; it is never inferred from transcript output.
   */
  model: TaskModelSelectorSchema.nullable().optional(),
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
  /**
   * How the repository was selected. Picker imports are re-validated against
   * the requesting account's forge API listing so their default-branch metadata
   * is server verified; omission keeps the existing URL-import behavior.
   */
  importSource: z.enum(['url', 'picker']).optional(),
});
export type CreateRepoRequest = z.infer<typeof CreateRepoRequestSchema>;

/**
 * Stable, secret-free failures returned by the authenticated Console repo
 * import boundary. The Console classifies these codes directly; it must not
 * parse raw Git output, transport diagnostics, or arbitrary error prose.
 */
export const REPO_IMPORT_FAILURE_CODES = [
  'session_operator_required',
  'repo_git_source_invalid',
  'repo_git_source_credentials_forbidden',
  'repo_forge_unresolved',
  'repo_forge_auth_required',
  'repo_forge_authentication_failed',
  'repo_forge_access_denied',
  'repo_forge_network_unavailable',
  'repo_platform_dependency_unavailable',
  'repo_default_branch_unresolved',
  'repo_picker_candidate_not_accessible',
  'repo_import_identity_conflict',
  // add-repo-content-store — content-copy acquisition/refresh failures. These are
  // DISTINCT from the metadata codes above so the console can tell "the repo could
  // not be verified" from "the repo is registered but its content copy is not
  // ready"; the latter leaves a retryable Repo row whose copy status is visible.
  'repo_copy_authentication_failed',
  'repo_copy_access_denied',
  'repo_copy_network_unavailable',
  'repo_copy_source_invalid',
  'repo_copy_missing',
  'repo_copy_store_unavailable',
  'repo_copy_platform_dependency_unavailable',
  'repo_copy_acquisition_aborted',
  // add-repo-content-store — Console repo DELETION refused because the Repo is
  // still referenced. The database cascade would silently take the referencing
  // tasks/schedules with it, so the delete surface fails closed and names the
  // reference instead; the operator removes the tasks/schedules first.
  'repo_has_tasks',
  // add-repo-content-store / local-repo-import — local-path import gate failures.
  'repo_local_import_disabled',
  'repo_local_import_path_invalid',
  'repo_local_import_path_outside_root',
  'repo_local_import_path_not_found',
  'repo_local_import_not_a_git_repository',
] as const;
export const RepoImportFailureCodeSchema = z.enum(REPO_IMPORT_FAILURE_CODES);
export type RepoImportFailureCode = z.infer<
  typeof RepoImportFailureCodeSchema
>;

export const RepoImportFailureSchema = z
  .object({
    error: RepoImportFailureCodeSchema,
    /** Bounded server-safe copy; clients may use their own code-based wording. */
    message: z.string().trim().min(1).max(1_024),
  })
  .strict();
export type RepoImportFailure = z.infer<typeof RepoImportFailureSchema>;

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

/**
 * Successful `POST /repos` / verified picker responses are stronger than legacy
 * reads: a repository is not import-successful or task-selectable until its real
 * default branch has crossed the owner-authenticated verification boundary.
 */
export const VerifiedRepoImportResponseSchema = RepoResponseSchema.extend({
  defaultBranch: GitBranchNameSchema,
});
export type VerifiedRepoImportResponse = z.infer<
  typeof VerifiedRepoImportResponseSchema
>;

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
   * Optional per-run model selector. It is validated against the contextual
   * runtime-model catalog before persistence; omission preserves the effective
   * runtime/credential default.
   */
  model: TaskModelSelectorSchema.optional(),
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
   * Safe durable-admission/provisioning progress. Optional and nullable so task
   * rows written before this projection existed remain valid without inventing
   * progress. Current services emit null until a durable work row is available.
   */
  provisioning: TaskProvisioningSummarySchema.nullable().optional(),
  /**
   * Public sandbox provider selected for this task, when provisioning has
   * recorded an owner. Null means no provider has been selected yet. Optional so
   * mixed deployments with an older api degrade honestly instead of failing task
   * reads; the current api emits null explicitly when absent.
   */
  sandboxProvider: TaskSandboxProviderSchema.nullable().optional(),
  sandboxEnvironment: TaskSandboxEnvironmentSummarySchema.nullable().optional(),
  sandboxMetadata: SandboxMetadataSchema.nullable().optional(),
});
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

/** Lower-camel alias of {@link TaskResponseSchema} used by the api tasks service. */
export const taskResponseSchema = TaskResponseSchema;

/** Response body for `GET /tasks`. */
export const ListTasksResponseSchema = z.array(TaskResponseSchema);
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
