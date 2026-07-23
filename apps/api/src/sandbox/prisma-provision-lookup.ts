import { Injectable, Optional } from '@nestjs/common';

import {
  DEFAULT_TASK_RUNTIME,
  ExecutionModeSchema,
  RuntimeSchema,
  SandboxEnvironmentResourcesSchema,
  TaskModelSelectorSchema,
  type Runtime,
  type RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import {
  DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX,
  SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN,
  SandboxRuntimeModelSetupError,
  SandboxEnvironmentProviderFamily,
  SandboxHostImageParameterProfile,
  SandboxResolvedEnvironmentMetadata,
  createExactHostGitCredential,
  snapshotSandboxResources,
  type SandboxProviderCapability,
  type SandboxResourceSnapshot,
  type SandboxWorkspaceMaterializationPlan,
  type WorkspaceSource,
} from '@cap/sandbox';
import { WorkspaceSourceResolver } from './workspace-source-resolver';
import { PrismaService } from '../prisma/prisma.service';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import {
  TaskBranchResolutionError,
  TaskBranchResolver,
} from '../forge/task-branch-resolver';
import { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type {
  CloneSpec,
  ProvisionLookup,
  SandboxPinnedEnvironmentMetadata,
  TaskLaunchContext,
} from './provision-lookup.port';
import { validateRuntimeExecutionEnvironmentSnapshot } from '../runtime-models/runtime-model-snapshot';

/**
 * Prisma-backed {@link ProvisionLookup}. Canonical admission consumes the
 * immutable workspace plan; cloneSpec remains only for providers still moving
 * to staged materialization.
 */
@Injectable()
export class PrismaProvisionLookup implements ProvisionLookup {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly forgeResolver?: ForgeTargetResolver,
    @Optional() private readonly forgeRegistry?: DefaultForgeRegistry,
    @Optional() private readonly sandboxEnvironments?: SandboxEnvironmentsService,
    /**
     * Present in the production SandboxModule/ForgeModule graph. Optional only
     * so model-only isolated unit fixtures can construct this lookup without
     * assembling forge I/O; every production workspace plan passes through it.
     */
    @Optional() private readonly taskBranchResolver?: TaskBranchResolver,
    /**
     * add-repo-content-store Track 4: selects the workspace ORIGIN (repo-store
     * volume mount / archive transfer / gated legacy clone). Optional only so
     * model-only unit fixtures can construct this lookup; production wiring
     * always provides it, and its absence fails closed below rather than
     * silently reverting to a network clone.
     */
    @Optional()
    workspaceSourceResolver?: WorkspaceSourceResolver,
  ) {
    // Structural port compatibility, exactly like `getTaskWorkspacePlan`: an
    // adapter that cannot select a workspace ORIGIN must OMIT the method rather
    // than answer with a degraded value, so orchestration can tell "this
    // deployment has no content store" apart from "selection failed". The
    // production graph always injects the resolver (asserted by the
    // sandbox-module wiring test), so production never omits it.
    if (workspaceSourceResolver) {
      this.getTaskWorkspaceSource = (taskId, declaredCapabilities) =>
        workspaceSourceResolver.resolve(taskId, declaredCapabilities);
    }
  }

  /**
   * Present only when a {@link WorkspaceSourceResolver} was injected. See the
   * constructor note: fail-closed selection lives in the resolver.
   */
  readonly getTaskWorkspaceSource?: (
    taskId: string,
    declaredCapabilities: readonly SandboxProviderCapability[],
  ) => Promise<WorkspaceSource>;

  async getTaskWorkspacePlan(
    taskId: string,
  ): Promise<SandboxWorkspaceMaterializationPlan> {
    if (!this.taskBranchResolver) {
      throw new Error('Task branch resolver is not configured');
    }
    const [branch, workspaceMaterializationDeadlineMs] = await Promise.all([
      this.taskBranchResolver.resolve(taskId),
      this.resolveWorkspaceMaterializationDeadline(taskId),
    ]);
    let repositoryUrl = branch.repositoryUrl;
    let credential: ReturnType<typeof createExactHostGitCredential> | undefined;

    if (this.forgeResolver && this.forgeRegistry) {
      const target = await this.forgeResolver.getForgeTarget(taskId);
      if (target) {
        repositoryUrl = target.cloneUrl;
        const authorizationHeader = this.forgeRegistry
          .forKind(target.kind)
          .cloneAuthHeader(target);
        credential = createExactHostGitCredential(
          repositoryUrl,
          authorizationHeader,
        );
      }
    }

    return {
      repositoryUrl,
      callerBranch: branch.callerBranch,
      resolvedBranch: branch.resolvedBranch,
      deadlineMs: workspaceMaterializationDeadlineMs,
      ...(credential === undefined ? {} : { credential }),
    };
  }

  private async resolveWorkspaceMaterializationDeadline(
    taskId: string,
  ): Promise<number> {
    let work;
    try {
      work = await this.prisma.taskAdmissionWork.findUnique({
        where: { taskId },
        select: { workspaceMaterializationDeadlineMs: true },
      });
    } catch {
      throw new SandboxRuntimeModelSetupError('lookup');
    }
    return parseAdmissionWorkspaceMaterializationDeadline(
      work?.workspaceMaterializationDeadlineMs,
    );
  }

  async getTaskLaunchContext(taskId: string): Promise<TaskLaunchContext> {
    let task;
    try {
      task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          model: true,
          ownerUserId: true,
          executionEnvironmentSnapshot: true,
          runtime: true,
          executionMode: true,
          admissionWork: {
            select: {
              resourceSnapshot: true,
              workspaceMaterializationDeadlineMs: true,
            },
          },
        },
      });
    } catch {
      throw new SandboxRuntimeModelSetupError('lookup');
    }
    if (!task) throw new SandboxRuntimeModelSetupError('lookup');
    const runtime = RuntimeSchema.safeParse(
      task.runtime ?? DEFAULT_TASK_RUNTIME,
    );
    const executionMode = ExecutionModeSchema.safeParse(
      task.executionMode ?? 'interactive-pty',
    );
    if (!runtime.success || !executionMode.success) {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    const admissionResources = parseAdmissionResourceSnapshot(
      task.admissionWork?.resourceSnapshot,
    );
    const workspaceMaterializationDeadlineMs =
      parseAdmissionWorkspaceMaterializationDeadline(
        task.admissionWork?.workspaceMaterializationDeadlineMs,
      );
    if (task.model === null) {
      return {
        modelIntent: { kind: 'runtime-default' },
        ownerUserId: task.ownerUserId ?? null,
        runtimeId: runtime.data,
        executionMode: executionMode.data,
        workspaceMaterializationDeadlineMs,
        ...(admissionResources === undefined
          ? {}
          : { resources: admissionResources }),
      };
    }

    const selector = TaskModelSelectorSchema.safeParse(task.model);
    if (!selector.success) {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    if (!task.ownerUserId) {
      throw new SandboxRuntimeModelSetupError('launch-context');
    }
    let snapshot: RuntimeExecutionEnvironmentSnapshot;
    try {
      snapshot = validateRuntimeExecutionEnvironmentSnapshot(
        runtime.data,
        task.executionEnvironmentSnapshot,
      );
    } catch {
      throw new SandboxRuntimeModelSetupError('snapshot');
    }
    if (
      admissionResources !== undefined &&
      admissionResources.diskSizeGb !== snapshot.resources?.diskSizeGb
    ) {
      throw new SandboxRuntimeModelSetupError('snapshot');
    }
    return {
      modelIntent: { kind: 'explicit', selector: selector.data },
      ownerUserId: task.ownerUserId,
      runtimeId: runtime.data,
      executionMode: executionMode.data,
      workspaceMaterializationDeadlineMs,
      ...(admissionResources === undefined && snapshot.resources === undefined
        ? {}
        : { resources: admissionResources ?? snapshot.resources }),
      environment: resolvedEnvironmentFromSnapshot(snapshot, runtime.data),
    };
  }

  async getCloneSpec(_taskId: string): Promise<CloneSpec | null> {
    // This concrete lookup is the production adapter and therefore never emits
    // an unqualified clone request. Both the retired deployment-global URL and a
    // task repo's bare URL let `git clone` select remote HEAD implicitly, bypassing
    // the immutable TaskBranchResolver snapshot. Legacy/test adapters may still
    // implement this port when they omit getTaskWorkspacePlan altogether.
    throw new TaskBranchResolutionError('repository_unavailable');
  }

  /**
   * The operator-supplied prompt (`task.prompt`) for `taskId`, used by the
   * provider to pre-fill codex's composer with the goal. Returns `null` when the
   * task is missing or its prompt is empty. This is where the DB access lives so
   * provider hooks consume a small port instead of Prisma directly.
   */
  async getTaskPrompt(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { prompt: true },
    });
    const raw = task?.prompt;
    return raw && raw.trim().length > 0 ? raw : null;
  }

  /**
   * The selected skill ids (`task.skills`) for `taskId`, used by the provider to
   * preinstall those skills into the workspace. Returns an empty array when the
   * task is missing or selected none. DB access lives here so provider hooks
   * consume a small port instead of Prisma directly.
   */
  async getTaskSkills(taskId: string): Promise<string[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { skills: true },
    });
    return task?.skills ?? [];
  }

  /**
   * The task's persisted `runtime` (`'codex'` | `'claude-code'`), or `null` when
   * the task is missing / has no runtime. The runtime registry reads this to
   * dispatch provisioning to the right agent — without it EVERY task defaulted to
   * codex. DB access lives here so the provider/registry stay pure port consumers.
   */
  async getTaskRuntime(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { runtime: true },
    });
    return task?.runtime ?? null;
  }

  async getTaskExecutionMode(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { executionMode: true },
    });
    return task?.executionMode ?? null;
  }

  async getTaskImageParameterProfile(
    taskId: string,
    providerFamily: SandboxEnvironmentProviderFamily,
    runtimeId?: string | null,
  ): Promise<SandboxHostImageParameterProfile | null> {
    if (!this.sandboxEnvironments) return null;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        runtime: true,
        sandboxEnvironmentId: true,
      },
    });
    if (!task) return null;
    return this.sandboxEnvironments.resolveImageParameterProfileForTask({
      requestedEnvironmentId: task.sandboxEnvironmentId ?? null,
      runtimeId: runtimeId ?? task.runtime ?? DEFAULT_TASK_RUNTIME,
      providerFamily,
    });
  }

  async getResolvedEnvironment(
    taskId: string,
    providerFamily: SandboxEnvironmentProviderFamily,
    runtimeId?: string | null,
  ): Promise<SandboxResolvedEnvironmentMetadata | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        model: true,
        executionEnvironmentSnapshot: true,
        runtime: true,
        sandboxEnvironmentId: true,
      },
    });
    if (!task) return null;
    if (task.model !== null) {
      const resolvedRuntime = RuntimeSchema.parse(
        runtimeId ?? task.runtime ?? DEFAULT_TASK_RUNTIME,
      );
      const snapshot = validateRuntimeExecutionEnvironmentSnapshot(
        resolvedRuntime,
        task.executionEnvironmentSnapshot,
      );
      if (snapshot.providerFamily !== providerFamily) {
        throw new SandboxRuntimeModelSetupError('provider-selection');
      }
      return resolvedEnvironmentFromSnapshot(snapshot, resolvedRuntime);
    }
    if (!this.sandboxEnvironments) return null;
    return this.sandboxEnvironments.resolveForTask({
      selection: task.sandboxEnvironmentId
        ? { kind: 'managed', environmentId: task.sandboxEnvironmentId }
        : { kind: 'managed-default' },
      runtimeId: runtimeId ?? task.runtime ?? DEFAULT_TASK_RUNTIME,
      providerFamily,
    });
  }
}

function parseAdmissionResourceSnapshot(
  value: unknown,
): SandboxResourceSnapshot | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = SandboxEnvironmentResourcesSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandboxRuntimeModelSetupError('snapshot');
  }
  return snapshotSandboxResources(parsed.data);
}

function parseAdmissionWorkspaceMaterializationDeadline(
  value: unknown,
): number {
  if (value === null || value === undefined) {
    return DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MIN ||
    (value as number) > SANDBOX_WORKSPACE_MATERIALIZATION_DEADLINE_MS_MAX
  ) {
    throw new SandboxRuntimeModelSetupError('snapshot');
  }
  return value as number;
}

function resolvedEnvironmentFromSnapshot(
  snapshot: RuntimeExecutionEnvironmentSnapshot,
  runtimeId: Runtime,
): SandboxPinnedEnvironmentMetadata {
  return {
    id: snapshot.managedEnvironmentId ?? undefined,
    environmentId: snapshot.managedEnvironmentId ?? undefined,
    providerId: snapshot.provider,
    providerFamily: snapshot.providerFamily,
    runtimeId,
    sourceKind: snapshot.source.kind,
    sourceRef: snapshot.source.locator,
    digest: snapshot.source.digest ?? undefined,
    checksum: snapshot.source.checksum ?? undefined,
    runtimeArtifactChecksums: {
      [runtimeId]: snapshot.cliArtifactChecksum,
    },
    cliArtifactChecksum: snapshot.cliArtifactChecksum,
    validationId: snapshot.validationId ?? undefined,
    validationVersion: snapshot.validationContractVersion ?? undefined,
    contractVersion: snapshot.validationContractVersion ?? undefined,
    resources: snapshot.resources,
    metadata: {
      immutableIdentity: snapshot.immutableIdentity,
      fingerprint: snapshot.fingerprint,
      sandboxMetadata: snapshot.sandboxMetadata,
      sandboxMetadataChecksum: snapshot.sandboxMetadataChecksum,
      cliVersion: snapshot.cliVersion,
    },
  };
}
