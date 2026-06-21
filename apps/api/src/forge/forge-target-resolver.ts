import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decryptStored, readMaybeEncrypted } from '../settings/secret-storage';
import { DefaultForgeRegistry } from './forge-registry';
import type { ForgeKind, ForgeTarget } from './forge.port';

/**
 * Resolves a task to a fully-credentialed {@link ForgeTarget} for push-back
 * (add-multi-forge-task-delivery). Detection (registry) + OWNER-SCOPED credential:
 * the token is the task owner's `ForgeCredential` for the resolved (kind, host)
 * — the owner is the `task.created` audit-event userId, exactly the
 * `PrismaCodexAuthSource` discipline. The github public-host case falls back to
 * the owner's encrypted `User.githubAccessToken`. An unattributed task, or one
 * with no usable credential, resolves to null → push-back is skipped (fail-open).
 *
 * Reads `forgeCredential` directly + decrypts via the shared pure helpers (no
 * NestJS dependency on SettingsModule → no module cycle into guardrails).
 */
@Injectable()
export class ForgeTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: DefaultForgeRegistry,
  ) {}

  async getForgeTarget(
    taskId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ForgeTarget | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { repo: true },
    });
    const repo = task?.repo;
    if (!repo?.gitSource) {
      return null;
    }
    const location = await this.registry.detect({
      gitSource: repo.gitSource,
      forge: repo.forge,
      gitlabProjectId: repo.gitlabProjectId,
    });
    if (!location) {
      return null;
    }
    const ownerId = await this.resolveTaskOwnerId(taskId);
    if (!ownerId) {
      return null; // unattributed task → skip push-back
    }
    const host = this.hostOf(location.cloneUrl);
    if (!host) {
      return null;
    }

    let token = await this.forgeCredentialToken(ownerId, location.kind, host, env);
    if (!token && location.kind === 'github' && host === 'github.com') {
      token = await this.ownerGithubToken(ownerId, env);
    }
    if (!token) {
      return null;
    }
    return { ...location, token };
  }

  /** The owner's decrypted forge PAT for (kind, host), or null. */
  private async forgeCredentialToken(
    userId: string,
    kind: ForgeKind,
    host: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const row = await this.prisma.forgeCredential.findUnique({
      where: { userId_kind_host: { userId, kind, host } },
    });
    return decryptStored(row?.tokenCiphertext, env);
  }

  /** The owner's decrypted GitHub login token (the github public-host fallback). */
  private async ownerGithubToken(
    ownerId: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { githubAccessToken: true },
    });
    return readMaybeEncrypted(user?.githubAccessToken, env);
  }

  /** The task owner's userId (the `task.created` audit event), or null. */
  private async resolveTaskOwnerId(taskId: string): Promise<string | null> {
    const created = await this.prisma.auditEvent.findFirst({
      where: { taskId, type: 'task.created', userId: { not: null } },
      orderBy: { timestamp: 'asc' },
      select: { userId: true },
    });
    return created?.userId ?? null;
  }

  private hostOf(cloneUrl: string): string | null {
    try {
      return new URL(cloneUrl).host.toLowerCase();
    } catch {
      return null;
    }
  }
}
