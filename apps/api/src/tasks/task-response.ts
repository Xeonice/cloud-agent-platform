import {
  DEFAULT_TASK_RUNTIME,
  SandboxMetadataSchema,
  TaskProvisioningSummarySchema,
  isTaskProvisioningProgressEmissionOpen,
  sandboxProviderLabel,
  type Deliver,
  type DeliverStatus,
  type ExecutionMode,
  type Runtime,
  type TaskResponse,
  type TaskSandboxEnvironmentSummary,
  type TaskSandboxProvider,
  type TaskStatus,
} from '@cap/contracts';
import { taskFailureFromRecord } from './task-failure';

/** Relations required by every full TaskResponse projection. */
export const TASK_RESPONSE_INCLUDE = {
  admissionWork: {
    select: {
      state: true,
      stage: true,
      attempt: true,
      resolvedBranch: true,
      updatedAt: true,
      // detach-workspace-clone (D6): latest detached-transfer progress
      // persisted by the parked marker-watching loop into the discrete
      // admission-parking 5.1 columns. Read here once so the single projection
      // below fans the same progress object out to Console, Public V1, and MCP.
      progressPercent: true,
      progressReceivedObjects: true,
      progressTotalObjects: true,
      progressReceivedBytes: true,
      progressThroughputBytesPerSecond: true,
    },
  },
  sandboxRuns: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { providerId: true, metadata: true },
  },
  sandboxEnvironment: {
    select: {
      id: true,
      name: true,
      status: true,
      providerFamilies: true,
      runtimeIds: true,
      source: true,
    },
  },
  scheduleRun: {
    select: {
      scheduleId: true,
      scheduledFor: true,
    },
  },
} as const;

export interface TaskResponseRecord {
  id: string;
  repoId: string;
  prompt: string;
  status: string;
  failureCode?: string | null;
  failureAt?: Date | null;
  failureExitCode?: number | null;
  createdAt: Date;
  branch: string | null;
  strategy: string | null;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  runtime?: string | null;
  model?: string | null;
  sandboxEnvironmentId?: string | null;
  executionMode?: string | null;
  deliver?: string | null;
  deliverStatus?: string | null;
  branchPushed?: string | null;
  commitSha?: string | null;
  changeRequestUrl?: string | null;
  changeRequestNumber?: number | null;
  admissionWork?: {
    state: string;
    stage: string;
    attempt: number;
    resolvedBranch: string | null;
    updatedAt: Date;
    /**
     * Already-assembled transfer-progress snapshot (adapter/fixture input).
     * Treated as untrusted and re-filtered before emission. When absent, the
     * projection derives the snapshot from the discrete persisted columns
     * below — the shape Prisma rows actually carry.
     */
    progressSnapshot?: unknown;
    /** Discrete persisted progress columns (admission-parking 5.1). */
    progressPercent?: number | null;
    progressReceivedObjects?: bigint | number | null;
    progressTotalObjects?: bigint | number | null;
    progressReceivedBytes?: bigint | number | null;
    progressThroughputBytesPerSecond?: bigint | number | null;
  } | null;
  sandboxRuns?: readonly { providerId: string; metadata?: unknown }[];
  sandboxEnvironment?: {
    id: string;
    name: string;
    status: string;
    providerFamilies: string[];
    runtimeIds: string[];
    source: unknown;
  } | null;
  scheduleRun?: {
    scheduleId: string;
    scheduledFor: Date;
  } | null;
}

/** Project one persisted Task row into the canonical, secret-free wire shape. */
export function taskResponseFromRecord(task: TaskResponseRecord): TaskResponse {
  return {
    id: task.id,
    repoId: task.repoId,
    prompt: task.prompt,
    status: task.status as TaskStatus,
    failure: taskFailureFromRecord(task),
    createdAt: task.createdAt,
    branch: task.branch,
    strategy: task.strategy,
    skills: task.skills,
    idleTimeoutMs: task.idleTimeoutMs,
    deadlineMs: task.deadlineMs,
    runtime: (task.runtime ?? DEFAULT_TASK_RUNTIME) as Runtime,
    model: task.model ?? null,
    sandboxEnvironmentId: task.sandboxEnvironmentId ?? null,
    executionMode: (task.executionMode ?? 'interactive-pty') as ExecutionMode,
    deliver: (task.deliver ?? 'none') as Deliver,
    deliverStatus: (task.deliverStatus ?? null) as DeliverStatus | null,
    branchPushed: task.branchPushed ?? null,
    commitSha: task.commitSha ?? null,
    changeRequestUrl: task.changeRequestUrl ?? null,
    changeRequestNumber: task.changeRequestNumber ?? null,
    provisioning: taskProvisioningSummary(task.admissionWork),
    scheduleProvenance: task.scheduleRun
      ? {
          scheduleId: task.scheduleRun.scheduleId,
          scheduledFor: task.scheduleRun.scheduledFor,
        }
      : null,
    sandboxProvider: sandboxProviderSummary(task),
    sandboxEnvironment: sandboxEnvironmentSummary(task.sandboxEnvironment),
    sandboxMetadata: sandboxMetadata(task.sandboxRuns?.[0]?.metadata),
  };
}

/**
 * Single projection point for the public provisioning summary (detach-workspace-
 * clone D6): Console REST, Public V1, and MCP all read tasks through
 * {@link taskResponseFromRecord}, so the progress object is mapped here exactly
 * once and no surface computes its own divergent shape. Exported so projection
 * shapes can be pinned directly by tests.
 */
export function taskProvisioningSummary(
  work: TaskResponseRecord['admissionWork'],
): TaskResponse['provisioning'] {
  if (!work) return null;
  // Emission is behind the deployment capability gate: while closed (default,
  // or during a rollback) the progress key is omitted entirely so strict
  // pre-progress readers keep parsing every task response.
  const progress = isTaskProvisioningProgressEmissionOpen(process.env)
    ? taskProvisioningProgress(
        work.progressSnapshot !== undefined
          ? work.progressSnapshot
          : progressSnapshotFromColumns(work),
      )
    : null;
  const parsed = TaskProvisioningSummarySchema.safeParse({
    // `parked` is an internal admission swimlane (the claim released its worker
    // slot while the detached clone runs); publicly the provisioning attempt is
    // still running its transfer, so it projects through the stable state
    // vocabulary instead of leaking the coordination state.
    state: work.state === 'parked' ? 'running' : work.state,
    stage: work.stage,
    attempt: work.attempt,
    resolvedBranch: work.resolvedBranch,
    updatedAt: work.updatedAt,
    ...(progress ? { progress } : {}),
  });
  // Persisted work is schema/check constrained, but a mixed-version or corrupt
  // row must still fail closed instead of leaking an internal coordination bag.
  return parsed.success ? parsed.data : null;
}

/**
 * Assemble the snapshot object from the discrete persisted progress columns —
 * the shape a Prisma admission-work row actually carries. BigInt columns are
 * narrowed to number here; the numeric-only filter below still owns the
 * finite/non-negative gate, so an unsafe conversion can never leak.
 */
function progressSnapshotFromColumns(
  work: NonNullable<TaskResponseRecord['admissionWork']>,
): Record<string, number> | null {
  const columns = {
    percent: work.progressPercent,
    receivedObjects: work.progressReceivedObjects,
    totalObjects: work.progressTotalObjects,
    receivedBytes: work.progressReceivedBytes,
    throughput: work.progressThroughputBytesPerSecond,
  } as const;
  const snapshot: Record<string, number> = {};
  for (const [field, value] of Object.entries(columns)) {
    if (value === null || value === undefined) continue;
    snapshot[field] = typeof value === 'bigint' ? Number(value) : value;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/** Numeric-only fields the public transfer-progress object may carry (W2). */
const TASK_PROVISIONING_PROGRESS_FIELDS = [
  'percent',
  'receivedObjects',
  'totalObjects',
  'receivedBytes',
  'throughput',
] as const;

/**
 * Map the persisted snapshot into the additive nullable numeric-only progress
 * object. Only finite non-negative numbers under the known field names survive:
 * free text, URLs, raw git output, or any other key is dropped, and an unknown
 * value is OMITTED — never fabricated as 0 — so consumers can distinguish an
 * indeterminate phase (AIP-151) from an actual 0% transfer. Returns null (no
 * progress key emitted) when nothing numeric is known.
 */
function taskProvisioningProgress(
  snapshot: unknown,
): Partial<Record<(typeof TASK_PROVISIONING_PROGRESS_FIELDS)[number], number>> | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  const source = snapshot as Record<string, unknown>;
  const progress: Partial<
    Record<(typeof TASK_PROVISIONING_PROGRESS_FIELDS)[number], number>
  > = {};
  for (const field of TASK_PROVISIONING_PROGRESS_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      progress[field] = value;
    }
  }
  return Object.keys(progress).length > 0 ? progress : null;
}

function sandboxProviderSummary(task: {
  sandboxRuns?: readonly { providerId: string }[];
}): TaskSandboxProvider | null {
  const providerId = task.sandboxRuns?.[0]?.providerId;
  return providerId
    ? { id: providerId, label: sandboxProviderLabel(providerId) }
    : null;
}

function sandboxMetadata(raw: unknown): TaskResponse['sandboxMetadata'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const metadata = (raw as Record<string, unknown>).sandboxMetadata;
  const parsed = SandboxMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function sandboxEnvironmentSummary(
  environment: TaskResponseRecord['sandboxEnvironment'],
): TaskSandboxEnvironmentSummary | null {
  if (
    !environment ||
    typeof environment.source !== 'object' ||
    environment.source === null
  ) {
    return null;
  }
  const source = environment.source as { kind?: unknown };
  return typeof source.kind === 'string'
    ? {
        id: environment.id,
        name: environment.name,
        status: environment.status as never,
        providerFamily: (environment.providerFamilies[0] ?? null) as never,
        sourceKind: source.kind as never,
        runtimeIds: environment.runtimeIds,
      }
    : null;
}
