import {
  DEFAULT_TASK_RUNTIME,
  SandboxMetadataSchema,
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
