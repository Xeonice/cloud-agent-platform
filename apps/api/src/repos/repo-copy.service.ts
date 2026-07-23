import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isLocalRepoGitSource, type RepoResponse } from '@cap/contracts';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { PrismaService } from '../prisma/prisma.service';
import type { RepoStoreFailure } from '../repo-store/repo-store.service';
import { RepoStoreService } from '../repo-store/repo-store.service';
import { resolveLocalImportTarget } from './local-import';
import { repoRowToResponse } from './repo-response';
import { throwLocalImportRejection } from './local-import-errors';

/**
 * Content-copy orchestration for the repo import/refresh surfaces
 * (add-repo-content-store, Track import-flows).
 *
 * This is the ONLY seam between the import flows and the repo-store: it resolves
 * the operator's forge credential into the clone auth header, runs acquisition /
 * refresh, and translates the repo-store's typed failure vocabulary into stable,
 * secret-free HTTP failures the console can classify by code.
 *
 * Import policy (multi-forge-repo-import): the Repo METADATA row is committed
 * first and is deliberately NOT deleted when acquisition fails — "the repo
 * exists but its copy failed" is a visible, retryable state (`copyStatus` is
 * `failed`), which is exactly what the spec requires instead of a repo that
 * silently cannot start tasks.
 */
@Injectable()
export class RepoCopyService {
  private readonly logger = new Logger(RepoCopyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: RepoStoreService,
    private readonly forgeTargets: ForgeTargetResolver,
    private readonly forgeRegistry: DefaultForgeRegistry,
  ) {}

  /**
   * Acquires the content copy for a freshly imported/reconciled Repo.
   *
   * Returns the SAME repo response with its copy fields advanced to `ready`, so
   * import completion means "metadata row + ready copy" on the wire too. Throws
   * the typed copy failure otherwise; the caller must not roll the Repo row back.
   */
  async acquireOnImport(
    repo: RepoResponse,
    authHeader?: string,
  ): Promise<RepoResponse> {
    const result = await this.store.acquire({
      repoId: repo.id,
      source: repo.gitSource,
      ...(authHeader === undefined ? {} : { authHeader }),
    });
    if (!result.ok) {
      throwRepoCopyFailure(result);
    }
    return {
      ...repo,
      copyStatus: 'ready',
      copyUpdatedAt: result.copyUpdatedAt,
    };
  }

  /**
   * Console-internal manual refresh (`POST /repos/:repoId/refresh-copy`).
   *
   * Deliberately absent from `/v1` and MCP: copy freshness is an operator action,
   * not a machine-surface capability. When the Repo has no copy yet — every Repo
   * that predates this change — this ACQUIRES one, which is the documented
   * per-repo backfill path after upgrade.
   */
  async refreshCopy(ownerUserId: string, repoId: string): Promise<RepoResponse> {
    const repo = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!repo) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

    const source = repo.gitSource;
    let authHeader: string | undefined;
    if (isLocalRepoGitSource(source)) {
      // Re-run the local gate: the allowlist root may have been narrowed (or the
      // feature turned off) since the import, and a stale row must not become a
      // way to keep reading a path the current configuration forbids.
      const resolution = await resolveLocalImportTarget(source);
      if (!resolution.ok) {
        throwLocalImportRejection(resolution.rejection);
      }
    } else {
      authHeader = await this.resolveOwnerAuthHeader(ownerUserId, repo);
    }

    const request = {
      repoId,
      source,
      ...(authHeader === undefined ? {} : { authHeader }),
    };
    // `refresh` fetches into the existing mirror (keeping the last-good copy on
    // failure); with nothing on disk there is nothing to fetch INTO, so the same
    // operator action performs the initial acquisition.
    const result = (await this.store.hasCopy(repoId))
      ? await this.store.refresh(request)
      : await this.store.acquire(request);
    if (!result.ok) {
      throwRepoCopyFailure(result);
    }

    const refreshed = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!refreshed) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }
    return repoRowToResponse(refreshed);
  }

  /**
   * Console-internal Repo deletion (`DELETE /repos/:repoId`).
   *
   * This is the ONLY operator-reachable path that retires a Repo, and therefore
   * the only place the spec's "copy lifecycle follows the Repo" cascade can
   * happen: the metadata row and its repo-store bare mirror are removed by the
   * same action, so a deleted Repo never leaves content behind that no surface
   * can see, refresh, or delete.
   *
   * Fails closed on references. `Task.repoId` / `TaskSchedule.repoId` are
   * `onDelete: Cascade` at the database level, so an unguarded delete would
   * silently take an operator's task history and schedules with it. A referenced
   * Repo is therefore refused with the stable `repo_has_tasks` code instead; the
   * operator removes the tasks/schedules first and retries.
   *
   * Ordering / partial-failure policy — the DB row goes FIRST, and a failing
   * `remove()` is logged but does NOT roll it back:
   *   - the Repo row is what every surface reads, so once it is gone the repo is
   *     consistently absent everywhere even if the volume is unreachable;
   *   - the reverse order has a strictly worse failure mode: the copy would be
   *     gone while a row still advertises `copyStatus: ready`, i.e. a repo that
   *     looks task-ready but has no content;
   *   - a leftover `<repoId>.git` directory is inert. Repo ids are freshly
   *     generated uuids, so a later import can never be handed the orphan's path,
   *     and an operator can delete it from the volume at any time.
   */
  async deleteRepo(repoId: string): Promise<void> {
    const existing = await this.prisma.repo.findUnique({
      where: { id: repoId },
      select: { id: true, name: true },
    });
    if (!existing) {
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }

    const [tasks, schedules] = await Promise.all([
      this.prisma.task.count({ where: { repoId } }),
      this.prisma.taskSchedule.count({ where: { repoId } }),
    ]);
    if (tasks > 0 || schedules > 0) {
      throw new ConflictException({
        error: 'repo_has_tasks',
        message:
          `Repository "${existing.name}" still has ${tasks} task(s) and ` +
          `${schedules} schedule(s). Delete or archive them first, then delete the repository.`,
      });
    }

    // `deleteMany` (not `delete`) so a concurrent delete of the same row is a
    // count of 0 rather than a thrown Prisma error; the copy cleanup below still
    // runs, which keeps the cascade idempotent under a double submit.
    const deleted = await this.prisma.repo.deleteMany({ where: { id: repoId } });

    // A stored per-account default preference pointing at a repo that no longer
    // exists is inert but stale. Clear it in the same action so the settings
    // surface does not keep reporting a deleted selection. Deliberately NOT a DB
    // foreign key (see the schema note on `AccountSettings.defaultRepoId`).
    await this.prisma.accountSettings.updateMany({
      where: { defaultRepoId: repoId },
      data: { defaultRepoId: null },
    });

    try {
      await this.store.remove(repoId);
    } catch (error) {
      // The row is already gone and the caller's delete SUCCEEDED. Surface the
      // orphaned copy as an operator-visible warning instead of failing a delete
      // that cannot be retried (the row no longer exists to re-delete).
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Repo ${repoId} was deleted but its repo-store copy could not be removed: ${detail}`,
      );
    }

    if (deleted.count === 0) {
      // Another request won the race between the read above and this delete. The
      // repo is still gone, and its copy has now been cleaned up either way.
      throw new NotFoundException(`Repo not found: ${repoId}`);
    }
  }

  /**
   * The `Authorization: ...` clone header for the requesting account's own forge
   * credential, or undefined when no credential resolves (a public repository
   * still clones anonymously; a private one fails with `authentication_failed`,
   * which is the actionable answer).
   */
  async resolveOwnerAuthHeader(
    ownerUserId: string,
    repo: {
      gitSource: string;
      forge?: string | null;
      gitlabProjectId?: string | null;
    },
  ): Promise<string | undefined> {
    const target = await this.forgeTargets.resolveForOwner(ownerUserId, {
      gitSource: repo.gitSource,
      forge: repo.forge ?? null,
      gitlabProjectId: repo.gitlabProjectId ?? null,
    });
    if (!target.ok) return undefined;
    return this.forgeRegistry.forKind(target.target.kind).cloneAuthHeader(target.target);
  }
}

/**
 * Maps a repo-store failure onto the shared, secret-free repo import failure
 * vocabulary. The repo-store's `detail` is already bounded and redacted, so it
 * is safe to surface as the operator-facing message; the CODE is what clients
 * branch on.
 */
export function throwRepoCopyFailure(failure: RepoStoreFailure): never {
  const detail = `Repository content copy failed while ${failure.stage}: ${failure.detail}`;
  switch (failure.reason) {
    case 'authentication_failed':
      throw new ForbiddenException({
        error: 'repo_copy_authentication_failed',
        message: `${detail} Reconnect the forge credential and refresh the copy.`,
      });
    case 'access_denied':
      throw new ForbiddenException({
        error: 'repo_copy_access_denied',
        message: `${detail} The connected credential cannot read this repository.`,
      });
    case 'network_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_copy_network_unavailable',
        message: `${detail} Retry the copy refresh once the host is reachable.`,
      });
    case 'source_invalid':
      throw new BadRequestException({
        error: 'repo_copy_source_invalid',
        message: `${detail} Re-import the repository with a usable git source.`,
      });
    case 'copy_missing':
      throw new ConflictException({
        error: 'repo_copy_missing',
        message: `${detail} Refresh the repository to acquire its content copy.`,
      });
    case 'store_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_copy_store_unavailable',
        message: `${detail} The repo-store volume is not writable on the api host.`,
      });
    case 'platform_dependency_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_copy_platform_dependency_unavailable',
        message: `${detail} The api deployment is missing the git dependency.`,
      });
    case 'aborted':
      throw new ServiceUnavailableException({
        error: 'repo_copy_acquisition_aborted',
        message: `${detail} Retry the copy refresh.`,
      });
  }
}
