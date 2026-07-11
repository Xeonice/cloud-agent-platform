import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decryptStored } from '../settings/secret-storage';
import { DefaultForgeRegistry } from './forge-registry';
import type { ForgeKind, ForgeTarget } from './forge.port';

function legacyHostFilters(host: string): Array<
  { host: string } | { host: { startsWith: string } }
> {
  return [
    { host },
    { host: `https://${host}` },
    { host: `http://${host}` },
    { host: { startsWith: `https://${host}/` } },
    { host: { startsWith: `http://${host}/` } },
  ];
}

/**
 * Resolves a task to a fully-credentialed {@link ForgeTarget} for push-back
 * (add-multi-forge-task-delivery). Detection (registry) + OWNER-SCOPED credential:
 * the token is the task owner's `ForgeCredential` for the resolved (kind, host)
 * — the owner is the task's durable owner FK, with the earliest attributed
 * `task.created` audit event retained as a legacy fallback. An unattributed task, or one with no usable
 * forge PAT credential, resolves to null → push-back is skipped (fail-open).
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
    const ownerId =
      task?.ownerUserId ?? (await this.resolveLegacyTaskOwnerId(taskId));
    if (!ownerId) {
      return null; // unattributed task → skip push-back
    }
    const host = this.hostOf(location.cloneUrl);
    if (!host) {
      return null;
    }

    const token = await this.forgeCredentialToken(ownerId, location.kind, host, env);
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
    const exact = await this.prisma.forgeCredential.findUnique({
      where: { userId_kind_host: { userId, kind, host } },
    });
    const row =
      exact ??
      (await this.prisma.forgeCredential.findFirst({
        where: { userId, kind, OR: legacyHostFilters(host) },
        orderBy: { updatedAt: 'desc' },
      }));
    return decryptStored(row?.tokenCiphertext, env);
  }

  /** Legacy owner fallback for tasks created before the durable owner column. */
  private async resolveLegacyTaskOwnerId(taskId: string): Promise<string | null> {
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
