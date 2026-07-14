import { Injectable, Optional } from '@nestjs/common';

import {
  DEFAULT_TASK_RUNTIME,
  ExecutionModeSchema,
  RuntimeSchema,
  TaskModelSelectorSchema,
  type Runtime,
  type RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import {
  SandboxRuntimeModelSetupError,
  SandboxEnvironmentProviderFamily,
  SandboxHostImageParameterProfile,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox';
import { PrismaService } from '../prisma/prisma.service';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type {
  CloneSpec,
  ProvisionLookup,
  SandboxPinnedEnvironmentMetadata,
  TaskLaunchContext,
} from './provision-lookup.port';
import { validateRuntimeExecutionEnvironmentSnapshot } from '../runtime-models/runtime-model-snapshot';

/**
 * Prisma-backed {@link ProvisionLookup}: resolves a task's clone spec from its
 * own `repo.gitSource`, attaching the task owner's forge PAT as an Authorization
 * header (NOT in the URL) for private repos. This is where the database access
 * lives so provider hooks consume a small port instead of Prisma directly.
 */
@Injectable()
export class PrismaProvisionLookup implements ProvisionLookup {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly forgeResolver?: ForgeTargetResolver,
    @Optional() private readonly forgeRegistry?: DefaultForgeRegistry,
    @Optional() private readonly sandboxEnvironments?: SandboxEnvironmentsService,
  ) {}

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
    if (task.model === null) {
      return {
        modelIntent: { kind: 'runtime-default' },
        ownerUserId: task.ownerUserId ?? null,
        runtimeId: runtime.data,
        executionMode: executionMode.data,
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
    return {
      modelIntent: { kind: 'explicit', selector: selector.data },
      ownerUserId: task.ownerUserId,
      runtimeId: runtime.data,
      executionMode: executionMode.data,
      environment: resolvedEnvironmentFromSnapshot(snapshot, runtime.data),
    };
  }

  async getCloneSpec(taskId: string): Promise<CloneSpec | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { repo: true },
    });
    const gitSource = task?.repo?.gitSource;
    if (!gitSource) {
      // Fallback to the legacy global env ONLY when the task/repo lookup yields
      // nothing — keeps a single-repo deploy that still sets it working.
      const fallback = process.env.TASK_REPO_URL;
      return fallback ? { url: fallback } : null;
    }
    // add-multi-forge-task-delivery (4.2): clone auth is now multi-forge +
    // OWNER-SCOPED. When the task owner has a forge credential for the repo's
    // forge, clone with `forge.cloneAuthHeader` (github/gitee `x-access-token`,
    // gitlab `oauth2`); the token rides the http.extraHeader, never the URL.
    if (this.forgeResolver && this.forgeRegistry) {
      const target = await this.forgeResolver.getForgeTarget(taskId);
      if (target) {
        const authHeader = this.forgeRegistry.forKind(target.kind).cloneAuthHeader(target);
        return { url: target.cloneUrl, authHeader };
      }
    }
    // No owner-scoped forge PAT could be resolved. Clone public repos with the
    // bare URL; private repos will fail closed inside git rather than borrowing a
    // global or OAuth-derived credential.
    return { url: gitSource };
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
    metadata: {
      immutableIdentity: snapshot.immutableIdentity,
      fingerprint: snapshot.fingerprint,
      sandboxMetadata: snapshot.sandboxMetadata,
      sandboxMetadataChecksum: snapshot.sandboxMetadataChecksum,
      cliVersion: snapshot.cliVersion,
    },
  };
}
