import { Injectable, Logger } from '@nestjs/common';
import {
  GitBranchNameSchema,
  type TaskFailureCode,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ForgeTargetResolver } from './forge-target-resolver';
import {
  RemoteRefsProbePort,
  type RemoteRefsProbeFailureReason,
} from './remote-refs-probe';

export type TaskBranchResolutionSource =
  | 'snapshot'
  | 'explicit-task-branch'
  | 'repo-default-branch'
  | 'legacy-symbolic-head';

export type TaskBranchResolutionFailureReason =
  | 'task_not_found'
  | 'repository_unavailable'
  | 'explicit_branch_invalid'
  | 'repo_default_branch_invalid'
  | 'snapshot_invalid'
  | 'snapshot_conflict'
  | 'owner_credential_unavailable'
  | 'authentication_failed'
  | 'access_denied'
  | 'network_unavailable'
  | 'platform_dependency_unavailable'
  | 'branch_not_found';

export type TaskBranchResolutionFailureCode = Extract<
  TaskFailureCode,
  | 'provisioning_forge_auth_failed'
  | 'provisioning_tls_network_failed'
  | 'provisioning_ref_not_found'
  | 'provisioning_platform_dependency_unavailable'
  | 'provisioning_unknown'
>;

/** Secret-free typed failure suitable for provisioning classification. */
export class TaskBranchResolutionError extends Error {
  readonly failureCode: TaskBranchResolutionFailureCode;

  constructor(readonly reason: TaskBranchResolutionFailureReason) {
    super(`Task branch resolution failed: ${reason}`);
    this.name = 'TaskBranchResolutionError';
    this.failureCode = failureCodeForReason(reason);
  }
}

export function isTaskBranchResolutionError(
  error: unknown,
): error is TaskBranchResolutionError {
  return error instanceof TaskBranchResolutionError;
}

/**
 * Immutable checkout decision shared by provisioning, recovery, and delivery.
 *
 * `callerBranch` is exactly the nullable Task intent and is never rewritten.
 * `snapshotted` is false only for tasks that predate the admission outbox; the
 * resolver intentionally does not create an accepted work item for such tasks.
 */
export interface ResolvedTaskBranch {
  readonly taskId: string;
  readonly repositoryUrl: string;
  readonly callerBranch: string | null;
  readonly resolvedBranch: string;
  readonly source: TaskBranchResolutionSource;
  readonly snapshotted: boolean;
}

export interface ResolveTaskBranchOptions {
  readonly signal?: AbortSignal;
  /** Injectable only for deterministic credential-decryption tests. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface PrepareTaskBranchInput {
  readonly repoId: string;
  readonly ownerUserId: string | null;
  readonly callerBranch?: string | null;
}

/** Transaction-free branch decision frozen into a new admission work row. */
export interface PreparedTaskBranch {
  readonly repositoryUrl: string;
  readonly callerBranch: string | null;
  readonly resolvedBranch: string;
  readonly source: Exclude<TaskBranchResolutionSource, 'snapshot'>;
}

interface SnapshotResult {
  readonly resolvedBranch: string;
  readonly snapshotted: boolean;
  readonly usedCandidate: boolean;
}

/**
 * Canonical task branch resolver.
 *
 * A pre-existing admission snapshot is the recovery source of truth. Before a
 * first snapshot, resolution is strictly explicit Task.branch, verified
 * Repo.defaultBranch, then an owner-authenticated exact-host symbolic-HEAD
 * probe for a legacy null repo. There is deliberately no branch-name fallback.
 */
@Injectable()
export class TaskBranchResolver {
  private readonly logger = new Logger(TaskBranchResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly forgeTargetResolver: ForgeTargetResolver,
    private readonly remoteRefsProbe: RemoteRefsProbePort,
  ) {}

  /**
   * Resolve a new task before its acceptance transaction begins.
   *
   * The legacy symbolic-HEAD probe is authorized only with the prospective
   * task owner's exact-host credential. No Task/audit row needs to exist yet,
   * and no credential-bearing value enters the returned preparation object.
   */
  async prepareForCreate(
    input: PrepareTaskBranchInput,
    options: ResolveTaskBranchOptions = {},
  ): Promise<PreparedTaskBranch> {
    const repo = await this.prisma.repo.findUnique({
      where: { id: input.repoId },
      select: {
        id: true,
        gitSource: true,
        forge: true,
        gitlabProjectId: true,
        defaultBranch: true,
      },
    });
    if (!repo?.gitSource) {
      throw new TaskBranchResolutionError('repository_unavailable');
    }

    const callerBranch = this.parseNullableBranch(
      input.callerBranch ?? null,
      'explicit_branch_invalid',
    );
    if (callerBranch !== null) {
      return {
        repositoryUrl: repo.gitSource,
        callerBranch,
        resolvedBranch: callerBranch,
        source: 'explicit-task-branch',
      };
    }
    if (repo.defaultBranch !== null) {
      return {
        repositoryUrl: repo.gitSource,
        callerBranch,
        resolvedBranch: this.parseBranch(
          repo.defaultBranch,
          'repo_default_branch_invalid',
        ),
        source: 'repo-default-branch',
      };
    }
    if (!input.ownerUserId) {
      throw new TaskBranchResolutionError('owner_credential_unavailable');
    }

    const target = await this.forgeTargetResolver.resolveForOwner(
      input.ownerUserId,
      {
        gitSource: repo.gitSource,
        forge: repo.forge,
        gitlabProjectId: repo.gitlabProjectId,
      },
      options.env ?? process.env,
    );
    if (!target.ok) {
      throw new TaskBranchResolutionError(
        target.reason === 'owner_credential_unavailable'
          ? 'owner_credential_unavailable'
          : 'repository_unavailable',
      );
    }
    const probe = await this.remoteRefsProbe.resolveDefaultBranch(
      target.target,
      options.signal,
    );
    if (!probe.ok) {
      throw new TaskBranchResolutionError(reasonForProbeFailure(probe.reason));
    }
    const resolvedBranch = this.parseBranch(
      probe.defaultBranch,
      'branch_not_found',
    );

    // Owner-authenticated null-only backfill happens before acceptance. A
    // concurrent verified winner is preserved and never rewritten.
    await this.prisma.repo
      .updateMany({
        where: { id: repo.id, defaultBranch: null },
        data: { defaultBranch: resolvedBranch },
      })
      .catch(() => {
        this.logger.warn(
          `legacy repository default-branch backfill skipped for repo ${repo.id}`,
        );
      });
    return {
      repositoryUrl: repo.gitSource,
      callerBranch,
      resolvedBranch,
      source: 'legacy-symbolic-head',
    };
  }

  async resolve(
    taskId: string,
    options: ResolveTaskBranchOptions = {},
  ): Promise<ResolvedTaskBranch> {
    const [task, admissionWork] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          branch: true,
          repo: {
            select: {
              id: true,
              gitSource: true,
              defaultBranch: true,
            },
          },
        },
      }),
      this.prisma.taskAdmissionWork.findUnique({
        where: { taskId },
        select: { resolvedBranch: true },
      }),
    ]);

    if (!task) throw new TaskBranchResolutionError('task_not_found');
    if (!task.repo) {
      throw new TaskBranchResolutionError('repository_unavailable');
    }

    const callerBranch = this.parseNullableBranch(
      task.branch,
      'explicit_branch_invalid',
    );

    if (admissionWork?.resolvedBranch !== null && admissionWork?.resolvedBranch !== undefined) {
      const resolvedBranch = this.parseBranch(
        admissionWork.resolvedBranch,
        'snapshot_invalid',
      );
      if (callerBranch !== null && callerBranch !== resolvedBranch) {
        throw new TaskBranchResolutionError('snapshot_conflict');
      }
      return {
        taskId,
        repositoryUrl: task.repo.gitSource,
        callerBranch,
        resolvedBranch,
        source: 'snapshot',
        snapshotted: true,
      };
    }

    if (callerBranch !== null) {
      return this.resolveCandidate(
        taskId,
        task.repo.gitSource,
        callerBranch,
        callerBranch,
        'explicit-task-branch',
      );
    }

    if (task.repo.defaultBranch !== null) {
      const repoDefault = this.parseBranch(
        task.repo.defaultBranch,
        'repo_default_branch_invalid',
      );
      return this.resolveCandidate(
        taskId,
        task.repo.gitSource,
        callerBranch,
        repoDefault,
        'repo-default-branch',
      );
    }

    const target = await this.forgeTargetResolver.getForgeTarget(
      taskId,
      options.env ?? process.env,
    );
    if (!target) {
      throw new TaskBranchResolutionError('owner_credential_unavailable');
    }
    const probe = await this.remoteRefsProbe.resolveDefaultBranch(
      target,
      options.signal,
    );
    if (!probe.ok) {
      throw new TaskBranchResolutionError(reasonForProbeFailure(probe.reason));
    }
    const remoteDefault = this.parseBranch(
      probe.defaultBranch,
      'branch_not_found',
    );
    const resolved = await this.resolveCandidate(
      taskId,
      task.repo.gitSource,
      callerBranch,
      remoteDefault,
      'legacy-symbolic-head',
    );

    // Backfill is allowed only after this task owner's authenticated exact-host
    // probe succeeds. A concurrent non-null winner is preserved; this is never
    // a tokenless/global migration and never overwrites a renamed default.
    if (resolved.resolvedBranch === remoteDefault) {
      await this.prisma.repo
        .updateMany({
          where: { id: task.repo.id, defaultBranch: null },
          data: { defaultBranch: remoteDefault },
        })
        .catch(() => {
          this.logger.warn(
            `legacy repository default-branch backfill skipped for task ${taskId}`,
          );
        });
    }
    return resolved;
  }

  private async resolveCandidate(
    taskId: string,
    repositoryUrl: string,
    callerBranch: string | null,
    candidate: string,
    source: Exclude<TaskBranchResolutionSource, 'snapshot'>,
  ): Promise<ResolvedTaskBranch> {
    const snapshot = await this.snapshotCandidate(taskId, candidate);
    if (callerBranch !== null && snapshot.resolvedBranch !== callerBranch) {
      throw new TaskBranchResolutionError('snapshot_conflict');
    }
    return {
      taskId,
      repositoryUrl,
      callerBranch,
      resolvedBranch: snapshot.resolvedBranch,
      source: snapshot.usedCandidate ? source : 'snapshot',
      snapshotted: snapshot.snapshotted,
    };
  }

  /** Null-only CAS: never creates a claimable admission outbox for old tasks. */
  private async snapshotCandidate(
    taskId: string,
    candidate: string,
  ): Promise<SnapshotResult> {
    const changed = await this.prisma.taskAdmissionWork.updateMany({
      where: { taskId, resolvedBranch: null },
      data: { resolvedBranch: candidate },
    });
    if (changed.count === 1) {
      return {
        resolvedBranch: candidate,
        snapshotted: true,
        usedCandidate: true,
      };
    }

    const winner = await this.prisma.taskAdmissionWork.findUnique({
      where: { taskId },
      select: { resolvedBranch: true },
    });
    if (!winner) {
      return {
        resolvedBranch: candidate,
        snapshotted: false,
        usedCandidate: true,
      };
    }
    if (winner.resolvedBranch === null) {
      throw new TaskBranchResolutionError('snapshot_conflict');
    }
    return {
      resolvedBranch: this.parseBranch(
        winner.resolvedBranch,
        'snapshot_invalid',
      ),
      snapshotted: true,
      usedCandidate: winner.resolvedBranch === candidate,
    };
  }

  private parseNullableBranch(
    value: string | null,
    reason: TaskBranchResolutionFailureReason,
  ): string | null {
    return value === null ? null : this.parseBranch(value, reason);
  }

  private parseBranch(
    value: string,
    reason: TaskBranchResolutionFailureReason,
  ): string {
    const parsed = GitBranchNameSchema.safeParse(value);
    if (!parsed.success) throw new TaskBranchResolutionError(reason);
    return parsed.data;
  }
}

function reasonForProbeFailure(
  reason: RemoteRefsProbeFailureReason,
): TaskBranchResolutionFailureReason {
  switch (reason) {
    case 'authentication_failed':
      return 'authentication_failed';
    case 'access_denied':
      return 'access_denied';
    case 'network_unavailable':
      return 'network_unavailable';
    case 'platform_dependency_unavailable':
      return 'platform_dependency_unavailable';
    case 'default_branch_unresolved':
      return 'branch_not_found';
  }
}

function failureCodeForReason(
  reason: TaskBranchResolutionFailureReason,
): TaskBranchResolutionFailureCode {
  switch (reason) {
    case 'owner_credential_unavailable':
    case 'authentication_failed':
    case 'access_denied':
      return 'provisioning_forge_auth_failed';
    case 'network_unavailable':
      return 'provisioning_tls_network_failed';
    case 'platform_dependency_unavailable':
      return 'provisioning_platform_dependency_unavailable';
    case 'explicit_branch_invalid':
    case 'repo_default_branch_invalid':
    case 'snapshot_invalid':
    case 'snapshot_conflict':
    case 'repository_unavailable':
    case 'branch_not_found':
      return 'provisioning_ref_not_found';
    case 'task_not_found':
      return 'provisioning_unknown';
  }
}
