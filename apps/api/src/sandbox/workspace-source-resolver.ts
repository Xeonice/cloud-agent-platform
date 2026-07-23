import { Injectable, Optional } from '@nestjs/common';
import {
  SANDBOX_REPO_SOURCE_MOUNT_DIR,
  createRepoStoreVolumeInspector,
  type RepoStoreVolumeInspector,
  type SandboxProviderCapability,
  type WorkspaceSource,
} from '@cap/sandbox';
import { PrismaService } from '../prisma/prisma.service';
import { RepoStoreService } from '../repo-store/repo-store.service';

/**
 * Workspace-source selection (add-repo-content-store D4/D5, Track 4.1).
 *
 * This is the seam that turns "this task's Repo has a stored bare mirror" into
 * the typed {@link WorkspaceSource} a provider can materialize from. It is the
 * ONLY place the injection matrix is decided:
 *
 * | provider capability          | variant   |
 * |------------------------------|-----------|
 * | `workspace.source.volume`    | `volume`  | read-only per-repo subpath mount (aio-local) |
 * | `workspace.source.archive`   | `archive` | streamed tar through the provider's archive upload (BoxLite) |
 * | git fallback gate enabled    | `git`     | legacy in-sandbox network clone, rollback only |
 *
 * Selection is FAIL-CLOSED: a provider that declares no injection variant with
 * the fallback gate off gets an actionable error naming both the missing
 * capability and the gate, never a silent degrade to a network clone.
 */

/** Operator gate that restores the legacy in-sandbox network clone. */
export const WORKSPACE_GIT_FALLBACK_ENV = 'CAP_WORKSPACE_GIT_FALLBACK_ENABLED';
/** Explicit repo-store volume name; overrides container self-detection. */
export const REPO_STORE_VOLUME_ENV = 'CAP_REPO_STORE_VOLUME';
/** Where an injected copy appears inside the sandbox (read-only). */
export const REPO_SOURCE_MOUNT_PATH = SANDBOX_REPO_SOURCE_MOUNT_DIR;

export type WorkspaceSourceFailureReason =
  /** The task or its Repo could not be read. */
  | 'repo_unavailable'
  /** No copy is ready in the repo-store for this Repo. */
  | 'copy_not_ready'
  /** The provider declares no injection variant and the gate is off. */
  | 'unsupported_provider'
  /** The repo-store volume name could not be determined. */
  | 'store_volume_unresolved';

export class WorkspaceSourceResolutionError extends Error {
  constructor(
    readonly reason: WorkspaceSourceFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSourceResolutionError';
  }
}

export function isWorkspaceSourceResolutionError(
  error: unknown,
): error is WorkspaceSourceResolutionError {
  return (
    error instanceof WorkspaceSourceResolutionError ||
    (error instanceof Error && error.name === 'WorkspaceSourceResolutionError')
  );
}

/** DI token for the repo-store volume-detection seam. */
export const REPO_STORE_VOLUME_INSPECTOR = Symbol('RepoStoreVolumeInspector');

export type { RepoStoreVolumeInspector };

/**
 * Default inspector. The container-runtime detail (self-inspecting the api's
 * own mounts) lives behind the sandbox harness, so API code names only the
 * neutral factory — the api/provider package boundary stays intact.
 */
export function createDefaultRepoStoreVolumeInspector(): RepoStoreVolumeInspector {
  return createRepoStoreVolumeInspector();
}

@Injectable()
export class WorkspaceSourceResolver {
  private cachedVolumeName: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repoStore: RepoStoreService,
    @Optional() private readonly volumes?: RepoStoreVolumeInspector,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** True when the operator re-enabled the legacy in-sandbox network clone. */
  gitFallbackEnabled(): boolean {
    return isEnabled(this.env[WORKSPACE_GIT_FALLBACK_ENV]);
  }

  async resolve(
    taskId: string,
    declaredCapabilities: readonly SandboxProviderCapability[],
  ): Promise<WorkspaceSource> {
    const repo = await this.loadRepo(taskId);

    if (this.gitFallbackEnabled()) {
      // Rollback channel: behavior must stay identical to the pre-injection
      // release, so the variant only NAMES the legacy path — the staged engine
      // still materializes from the immutable workspace plan.
      return { kind: 'git', spec: { url: repo.gitSource } };
    }

    const supports = (capability: SandboxProviderCapability): boolean =>
      declaredCapabilities.includes(capability);

    if (!supports('workspace.source.volume') && !supports('workspace.source.archive')) {
      throw new WorkspaceSourceResolutionError(
        'unsupported_provider',
        'The selected sandbox provider declares no repo-copy injection capability ' +
          '(workspace.source.volume or workspace.source.archive). Enable a provider that ' +
          `supports one, or set ${WORKSPACE_GIT_FALLBACK_ENV}=true to fall back to the ` +
          'legacy in-sandbox git clone.',
      );
    }

    await this.assertCopyReady(repo);

    if (supports('workspace.source.volume')) {
      return {
        kind: 'volume',
        repoId: repo.id,
        volumeName: await this.resolveVolumeName(),
        subpath: this.repoStore.copySubpath(repo.id),
        mountPath: REPO_SOURCE_MOUNT_PATH,
        gitSource: repo.gitSource,
      };
    }

    return {
      kind: 'archive',
      repoId: repo.id,
      storePath: this.repoStore.copyPath(repo.id),
      gitSource: repo.gitSource,
    };
  }

  private async loadRepo(taskId: string): Promise<{
    readonly id: string;
    readonly gitSource: string;
    readonly copyStatus: string;
  }> {
    let task;
    try {
      task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          repo: { select: { id: true, gitSource: true, copyStatus: true } },
        },
      });
    } catch {
      throw new WorkspaceSourceResolutionError(
        'repo_unavailable',
        'The task repository could not be read while selecting the workspace source.',
      );
    }
    const repo = task?.repo;
    if (!repo?.gitSource) {
      throw new WorkspaceSourceResolutionError(
        'repo_unavailable',
        'The task has no repository with a recorded git source.',
      );
    }
    return {
      id: repo.id,
      gitSource: repo.gitSource,
      copyStatus: repo.copyStatus,
    };
  }

  /**
   * Copy readiness is checked BOTH durably and physically: the status column is
   * the operator-visible truth, and the on-disk probe catches a store volume
   * that was replaced/emptied under a `ready` row.
   */
  private async assertCopyReady(repo: {
    readonly id: string;
    readonly copyStatus: string;
  }): Promise<void> {
    const present = await this.repoStore.hasCopy(repo.id).catch(() => false);
    if (repo.copyStatus === 'ready' && present) return;
    throw new WorkspaceSourceResolutionError(
      'copy_not_ready',
      `The repository content copy is not ready (status: ${
        present ? repo.copyStatus : 'missing'
      }). Refresh the repository to rebuild its copy before starting tasks.`,
    );
  }

  private async resolveVolumeName(): Promise<string> {
    const configured = this.env[REPO_STORE_VOLUME_ENV]?.trim();
    if (configured) return configured;
    if (this.cachedVolumeName) return this.cachedVolumeName;
    const storeRoot = this.repoStore.storeRoot();
    const detected = await this.volumes
      ?.resolveVolumeName(storeRoot)
      .catch(() => null);
    if (!detected) {
      throw new WorkspaceSourceResolutionError(
        'store_volume_unresolved',
        `The repo-store docker volume mounted at ${storeRoot} could not be detected from the ` +
          `api container. Set ${REPO_STORE_VOLUME_ENV} to the volume name (compose users: the ` +
          'project-qualified name, e.g. <project>_repo-store).',
      );
    }
    this.cachedVolumeName = detected;
    return detected;
  }
}

function isEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
